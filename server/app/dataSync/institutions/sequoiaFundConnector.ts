import type {
  RoutedSyncArtifact,
  SyncAccountCoverage,
  SyncConnector,
  SyncConnectorRunContext,
} from '../connector.ts';
import { goalWindowForCoverage } from '../planning.ts';
import {
  runSequoiaFundSync,
  type SequoiaFundDownloadedArtifact,
  type SequoiaFundProgressEvent,
} from './sequoiaFund.ts';

type SequoiaFundSyncRunner = typeof runSequoiaFundSync;

function matchesSequoiaFundAccount(account: SyncAccountCoverage): boolean {
  return /sequoia/i.test(account.institution ?? '');
}

function normalizedRouteNames(account: SyncAccountCoverage): Set<string> {
  return new Set([
    account.name,
    account.sourceAccountName,
    ...account.sourceAccountNames,
    ...account.accountAliases,
  ]
    .map(value => value?.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((value): value is string => Boolean(value)));
}

function routeLast4s(account: SyncAccountCoverage): Set<string> {
  return new Set([...normalizedRouteNames(account)]
    .flatMap(value => [...value.matchAll(/\b(\d{4})\b/g)].map(match => match[1]!)));
}

function normalizedArtifactAccountName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function routeArtifacts(
  artifacts: SequoiaFundDownloadedArtifact[],
  accounts: SyncAccountCoverage[],
): RoutedSyncArtifact[] {
  if (artifacts.length === 0) return [];
  if (accounts.length === 0) {
    throw new Error('No active Sequoia Fund account is available for downloaded data');
  }

  const tokens = [...new Set(artifacts.map(artifact => artifact.accountToken))];
  const accountIdByToken = new Map<string, number>();
  const usedAccountIds = new Set<number>();

  for (const token of tokens) {
    const tokenArtifacts = artifacts.filter(artifact => artifact.accountToken === token);
    const claimedNames = [...new Set(tokenArtifacts.map(artifact =>
      normalizedArtifactAccountName(artifact.accountName)
    ))];
    if (claimedNames.length !== 1) {
      throw new Error('Sequoia Fund artifacts disagree about their remote account identity');
    }

    const last4 = token.match(/^last4-(\d{4})$/)?.[1];
    let matches = last4
      ? accounts.filter(account => routeLast4s(account).has(last4))
      : accounts.filter(account => normalizedRouteNames(account).has(claimedNames[0]!));

    if (matches.length === 0 && tokens.length === 1 && accounts.length === 1) {
      matches = [accounts[0]!];
    }
    if (matches.length !== 1) {
      throw new Error('A Sequoia Fund remote account has no unambiguous local account route');
    }

    const accountId = matches[0]!.id;
    if (usedAccountIds.has(accountId)) {
      throw new Error('Multiple Sequoia Fund remote accounts map to the same local account');
    }
    usedAccountIds.add(accountId);
    accountIdByToken.set(token, accountId);
  }

  return artifacts.map(artifact => ({
    fileName: artifact.fileName,
    accountId: accountIdByToken.get(artifact.accountToken)!,
  }));
}

function targetLabel(accounts: SyncAccountCoverage[]): string {
  const holders = [...new Set(accounts
    .map(account => account.accountHolder?.trim())
    .filter((holder): holder is string => Boolean(holder)))];
  return holders.length === 1 ? `Sequoia Fund (${holders[0]})` : 'Sequoia Fund';
}

function reportProgress(context: SyncConnectorRunContext, event: SequoiaFundProgressEvent): void {
  context.report({
    type: event.state === 'waiting' ? 'action' : 'phase',
    message: event.message,
    data: {
      phase: event.phase,
      state: event.state,
      ...(event.elapsedMs === undefined ? {} : { elapsedMs: event.elapsedMs }),
      ...(event.data ?? {}),
    },
  });
}

export function createSequoiaFundConnector(
  runSync: SequoiaFundSyncRunner = runSequoiaFundSync,
) {
  return {
    id: 'sequoia-fund',
    label: 'Sequoia Fund',

    matchesAccount: matchesSequoiaFundAccount,

    listTargets(context) {
      const accounts = context.accounts.filter(matchesSequoiaFundAccount);
      return accounts.length === 0 ? [] : [{ label: targetLabel(accounts) }];
    },

    async run(context) {
      const accounts = context.accounts.filter(matchesSequoiaFundAccount);
      if (accounts.length === 0) {
        throw new Error('No active Sequoia Fund accounts are available');
      }

      const windows = accounts.map(account => goalWindowForCoverage(context.goal, account, context.today));
      const from = windows.map(window => window.startDate).sort()[0]!;
      const through = windows.map(window => window.endDate).sort().at(-1)!;

      context.report({
        type: 'phase',
        message: 'Opening Sequoia Fund',
        data: {
          goal: context.goal.kind,
          accountCount: accounts.length,
          from,
          through,
        },
      });

      const result = await runSync(
        { outputDir: context.outputDir, from, through },
        event => reportProgress(context, event),
      );
      const routed = routeArtifacts(result.artifacts, accounts);

      context.report({
        type: 'phase',
        message: `Validated ${routed.length} Sequoia Fund artifact${routed.length === 1 ? '' : 's'}`,
      });
      return routed;
    },
  } satisfies SyncConnector<'sequoia-fund'>;
}

export const sequoiaFundConnector = createSequoiaFundConnector();
