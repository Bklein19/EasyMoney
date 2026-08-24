import type {
  RoutedSyncArtifact,
  SyncAccountCoverage,
  SyncConnector,
  SyncConnectorRunContext,
} from '../connector.ts';
import { goalWindowForCoverage } from '../planning.ts';
import {
  runTiaaSync,
  type TiaaDownloadedArtifact,
  type TiaaProgressEvent,
} from './tiaa.ts';

type TiaaSyncRunner = typeof runTiaaSync;

export function matchesTiaaAccount(account: SyncAccountCoverage): boolean {
  return /\btiaa(?:-cref)?\b/i.test(account.institution?.trim() ?? '');
}

function tiaaAccounts(accounts: readonly SyncAccountCoverage[]): SyncAccountCoverage[] {
  return accounts.filter(matchesTiaaAccount);
}

function routingKeyFromFileName(fileName: string): string | null {
  const activity = fileName.match(
    /^tiaa-retirement-annuity-\d{4}-account-([a-f0-9]{12})-\d{4}-\d{2}-\d{2}-to-/i,
  );
  if (activity?.[1]) return activity[1].toLowerCase();
  const statement = fileName.match(
    /^tiaa-\d{4}-\d{2}-\d{2}-retirement-q[1-4]-\d{4}-([a-f0-9]{12})\.pdf$/i,
  );
  return statement?.[1]?.toLowerCase() ?? null;
}

function localRoutingKeys(account: SyncAccountCoverage): Set<string> {
  return new Set(account.artifactFileNames
    .map(routingKeyFromFileName)
    .filter((value): value is string => Boolean(value)));
}

function isCalendarYear(value: string): boolean {
  return /^(?:19|20)\d{2}$/.test(value);
}

function identityTokens(value: string): Set<string> {
  const normalized = value.toLowerCase();
  const tokens = new Set<string>();
  for (const token of normalized.match(/[a-z0-9]{4,}/g) ?? []) {
    if (!/\d/.test(token) || isCalendarYear(token)) continue;
    tokens.add(token);
    const digits = token.replace(/\D/g, '');
    if (digits.length >= 4) {
      if (!isCalendarYear(digits)) tokens.add(digits);
      tokens.add(digits.slice(-4));
    }
  }
  return tokens;
}

function legacyArtifactIdentityTokens(fileName: string): Set<string> {
  const tokens = new Set<string>();
  const activity = fileName.match(/tiaa-cref([a-z0-9]+)/i)?.[1];
  const statement = fileName.match(
    /^tiaa-\d{4}-\d{2}-\d{2}-retirement-q[1-4]-\d{4}-(\d+)\.pdf$/i,
  )?.[1];
  for (const value of [activity, statement]) {
    if (!value) continue;
    for (const token of identityTokens(value)) tokens.add(token);
  }
  return tokens;
}

function localIdentityTokens(account: SyncAccountCoverage): Set<string> {
  const tokens = new Set<string>();
  const values = [
    account.name,
    account.sourceAccountName,
    ...account.sourceAccountNames,
    ...account.accountAliases,
  ].filter((value): value is string => Boolean(value?.trim()));
  for (const value of values) {
    for (const token of identityTokens(value)) tokens.add(token);
  }
  for (const fileName of account.artifactFileNames) {
    for (const token of legacyArtifactIdentityTokens(fileName)) tokens.add(token);
  }
  return tokens;
}

function remoteIdentityTokens(remoteAccountId: string): Set<string> {
  return identityTokens(remoteAccountId);
}

function matchesRemoteIdentity(account: SyncAccountCoverage, remoteAccountId: string): boolean {
  const local = localIdentityTokens(account);
  return [...remoteIdentityTokens(remoteAccountId)].some(token => local.has(token));
}

export function routeTiaaArtifacts(
  artifacts: readonly TiaaDownloadedArtifact[],
  accounts: readonly SyncAccountCoverage[],
): RoutedSyncArtifact[] {
  if (artifacts.length === 0) return [];
  if (accounts.length === 0) throw new Error('No active TIAA account is available for downloaded data');

  const routingKeys = [...new Set(artifacts.map(artifact => artifact.account.routingKey))];
  const accountIdByRoutingKey = new Map<string, number>();
  const usedAccountIds = new Set<number>();

  for (const routingKey of routingKeys) {
    const routedArtifacts = artifacts.filter(artifact => artifact.account.routingKey === routingKey);
    const remoteAccountIds = [...new Set(routedArtifacts
      .map(artifact => artifact.account.remoteAccountId)
      .filter((value): value is string => Boolean(value)))];
    if (remoteAccountIds.length > 1) {
      throw new Error('TIAA artifacts disagree about their remote account identity');
    }

    let matches = accounts.filter(account => localRoutingKeys(account).has(routingKey));
    if (matches.length === 0 && remoteAccountIds[0]) {
      matches = accounts.filter(account => matchesRemoteIdentity(account, remoteAccountIds[0]!));
    }
    if (matches.length === 0 && routingKeys.length === 1 && accounts.length === 1) {
      matches = [accounts[0]!];
    }
    if (matches.length !== 1) {
      throw new Error('A TIAA remote account has no unambiguous local account route');
    }

    const accountId = matches[0]!.id;
    if (usedAccountIds.has(accountId)) {
      throw new Error('Multiple TIAA remote accounts map to the same local account');
    }
    usedAccountIds.add(accountId);
    accountIdByRoutingKey.set(routingKey, accountId);
  }

  return artifacts.map(artifact => ({
    fileName: artifact.fileName,
    accountId: accountIdByRoutingKey.get(artifact.account.routingKey)!,
  }));
}

function combinedTiaaWindow(context: SyncConnectorRunContext, accounts: SyncAccountCoverage[]) {
  const windows = accounts.flatMap(account => [
    goalWindowForCoverage(context.goal, account, context.today),
    goalWindowForCoverage(context.goal, {
      latestFactDate: account.latestBalanceDate,
      earliestFactDate: account.earliestBalanceDate,
    }, context.today),
  ]);
  return {
    from: windows.map(window => window.startDate).sort()[0]!,
    through: windows.map(window => window.endDate).sort().at(-1)!,
  };
}

function reportTiaaProgress(context: SyncConnectorRunContext, event: TiaaProgressEvent): void {
  context.report({
    type: event.state === 'progress' ? 'action' : 'phase',
    message: event.message,
    data: {
      phase: event.phase,
      state: event.state,
      elapsedMs: event.elapsedMs,
      phaseElapsedMs: event.phaseElapsedMs,
      ...(event.data ?? {}),
    },
  });
}

export function createTiaaConnector(runSync: TiaaSyncRunner = runTiaaSync) {
  return {
    id: 'tiaa',
    label: 'TIAA',

    matchesAccount: matchesTiaaAccount,

    listTargets(context) {
      return tiaaAccounts(context.accounts).length === 0 ? [] : [{ label: 'TIAA' }];
    },

    async run(context) {
      const accounts = tiaaAccounts(context.accounts);
      if (accounts.length === 0) throw new Error('No active TIAA accounts are available');
      const { from, through } = combinedTiaaWindow(context, accounts);

      context.report({
        type: 'phase',
        message: 'Opening TIAA',
        data: {
          goal: context.goal.kind,
          accountCount: accounts.length,
          from,
          through,
        },
      });

      const result = await runSync({
        outputDir: context.outputDir,
        from,
        through,
        session: 'tiaa-catchup',
      }, event => reportTiaaProgress(context, event));
      const routed = routeTiaaArtifacts(result.artifacts, accounts);

      context.report({
        type: 'phase',
        message: `Validated ${routed.length} TIAA artifact${routed.length === 1 ? '' : 's'}`,
        data: {
          accountsDiscovered: result.accountsDiscovered,
          activityPeriodsDiscovered: result.activityPeriodsDiscovered,
          statementsDiscovered: result.statementsDiscovered,
          emptyActivityExports: result.emptyActivityExports,
          timingsMs: result.timingsMs,
        },
      });
      return routed;
    },
  } satisfies SyncConnector<'tiaa'>;
}

export const tiaaConnector = createTiaaConnector();
