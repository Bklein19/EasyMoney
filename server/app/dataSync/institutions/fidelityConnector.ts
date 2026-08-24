import type {
  RoutedSyncArtifact,
  SyncAccountCoverage,
  SyncConnector,
  SyncConnectorContext,
  SyncConnectorRunContext,
} from '../connector.ts';
import { goalWindowForCoverage } from '../planning.ts';
import {
  runFidelitySync,
  type FidelityAccountKind,
  type FidelityDownloadedArtifact,
  type FidelityProgressEvent,
} from './fidelity.ts';

type FidelitySyncRunner = typeof runFidelitySync;

function identityTexts(account: SyncAccountCoverage): string[] {
  return [
    account.name,
    account.sourceAccountName,
    ...account.sourceAccountNames,
    ...account.accountAliases,
  ].filter((value): value is string => Boolean(value?.trim()));
}

function normalizedIdentity(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function matchesFidelityAccount(account: SyncAccountCoverage): boolean {
  return /\bfidelity\b/i.test(account.institution?.trim() ?? '');
}

export function inferFidelityAccountLast4(account: SyncAccountCoverage): string | null {
  const preferred = new Set<string>();
  const fallback = new Set<string>();
  for (const text of identityTexts(account)) {
    const explicit = text.match(
      /(?:ending\s+in|account(?:\s+(?:number|ending))?|[x*\u2022]{2,}|-{2,})\D{0,12}(\d{4})(?!\d)/i,
    )?.[1];
    if (explicit) preferred.add(explicit);
    for (const match of text.matchAll(/\b(?!19\d{2}\b|20\d{2}\b)(\d{4})\b/g)) {
      fallback.add(match[1]!);
    }
  }
  const candidates = preferred.size > 0 ? preferred : fallback;
  return candidates.size === 1 ? [...candidates][0]! : null;
}

function localAccountSupportsKind(account: SyncAccountCoverage, kind: FidelityAccountKind): boolean {
  const text = `${account.type} ${identityTexts(account).join(' ')}`.toLowerCase();
  if (kind === 'retirement') return /401\s*\(k\)|403\s*\(b\)|retirement|pension|workplace|savings plan/.test(text);
  if (kind === 'stock-plan') return /stock plan|equity compensation|rsu|espp/.test(text);
  if (kind === 'cash-management') return /cash management/.test(text);
  if (kind === 'hsa') return /health savings|\bhsa\b/.test(text);
  if (kind === 'ira') return /\bira\b|roth|traditional/.test(text);
  if (kind === 'brokerage') return /brokerage|individual|joint|trust|custodial|investment/.test(text);
  return true;
}

function accountForRemoteIdentity(
  remote: FidelityDownloadedArtifact['account'],
  accounts: SyncAccountCoverage[],
  remoteIdentityCount: number,
): SyncAccountCoverage {
  let candidates = remote.last4
    ? accounts.filter(account => inferFidelityAccountLast4(account) === remote.last4)
    : [];

  if (candidates.length > 1) {
    const byKind = candidates.filter(account => localAccountSupportsKind(account, remote.kind));
    if (byKind.length > 0) candidates = byKind;
  }

  if (candidates.length === 0 && remote.label) {
    const remoteName = normalizedIdentity(remote.label);
    candidates = accounts.filter(account => identityTexts(account).some(
      name => normalizedIdentity(name) === remoteName,
    ));
  }

  if (candidates.length === 0 && remoteIdentityCount === 1 && accounts.length === 1) {
    candidates = [accounts[0]!];
  }

  if (candidates.length !== 1) {
    const identity = remote.last4 ? ` ending in ${remote.last4}` : '';
    throw new Error(`A Fidelity ${remote.kind} account${identity} has no unambiguous local account route`);
  }
  return candidates[0]!;
}

export function routeFidelityArtifacts(
  artifacts: readonly FidelityDownloadedArtifact[],
  accounts: readonly SyncAccountCoverage[],
): RoutedSyncArtifact[] {
  const localAccounts = accounts.filter(matchesFidelityAccount);
  if (artifacts.length === 0) return [];
  if (localAccounts.length === 0) {
    throw new Error('No active Fidelity account is available for downloaded data');
  }

  const byRemoteIdentity = new Map<string, FidelityDownloadedArtifact[]>();
  for (const artifact of artifacts) {
    const identity = `${artifact.account.surface}:${artifact.account.accountKey}`;
    const group = byRemoteIdentity.get(identity) ?? [];
    group.push(artifact);
    byRemoteIdentity.set(identity, group);
  }

  const accountIdByIdentity = new Map<string, number>();
  const usedAccountIds = new Set<number>();
  for (const [identity, group] of byRemoteIdentity) {
    const signatures = new Set(group.map(artifact => JSON.stringify({
      surface: artifact.account.surface,
      kind: artifact.account.kind,
      last4: artifact.account.last4,
      label: artifact.account.label ?? null,
    })));
    if (signatures.size !== 1) {
      throw new Error('Fidelity artifacts disagree about their remote account identity');
    }

    const account = accountForRemoteIdentity(group[0]!.account, localAccounts, byRemoteIdentity.size);
    if (usedAccountIds.has(account.id)) {
      throw new Error('Multiple Fidelity remote accounts map to the same local account');
    }
    usedAccountIds.add(account.id);
    accountIdByIdentity.set(identity, account.id);
  }

  return artifacts.map(artifact => ({
    fileName: artifact.fileName,
    accountId: accountIdByIdentity.get(`${artifact.account.surface}:${artifact.account.accountKey}`)!,
  }));
}

function fidelityAccounts(context: SyncConnectorContext): SyncAccountCoverage[] {
  return context.accounts.filter(matchesFidelityAccount);
}

function targetLabel(accounts: SyncAccountCoverage[]): string {
  const holders = [...new Set(accounts
    .map(account => account.accountHolder?.trim())
    .filter((holder): holder is string => Boolean(holder)))];
  return holders.length === 1 ? `Fidelity (${holders[0]})` : 'Fidelity';
}

function reportProgress(context: SyncConnectorRunContext, event: FidelityProgressEvent): void {
  context.report({
    type: event.status === 'failed'
      ? 'warning'
      : event.phase === 'authentication' && event.status === 'started' ? 'action' : 'phase',
    message: event.message,
    data: {
      phase: event.phase,
      step: event.step,
      status: event.status,
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...(event.details ?? {}),
    },
  });
}

export function createFidelityConnector(
  runSync: FidelitySyncRunner = runFidelitySync,
): SyncConnector<'fidelity'> {
  return {
    id: 'fidelity',
    label: 'Fidelity',
    matchesAccount: matchesFidelityAccount,
    listTargets(context) {
      const accounts = fidelityAccounts(context);
      return accounts.length > 0 ? [{ label: targetLabel(accounts) }] : [];
    },
    async run(context) {
      if (context.connectionId) {
        throw new Error(`Fidelity connection is unavailable: ${context.connectionId}`);
      }
      const accounts = fidelityAccounts(context);
      if (accounts.length === 0) throw new Error('No active Fidelity accounts are available');

      const windows = accounts.map(account => goalWindowForCoverage(context.goal, account, context.today));
      const from = windows.map(window => window.startDate).sort()[0]!;
      const through = windows.map(window => window.endDate).sort().at(-1)!;
      context.report({
        type: 'phase',
        message: 'Opening Fidelity',
        data: { goal: context.goal.kind, accountCount: accounts.length, from, through },
      });

      const result = await runSync(
        { outputDir: context.outputDir, from, through, session: 'fidelity-catchup' },
        event => reportProgress(context, event),
      );
      if (result.status === 'authentication-required') {
        throw new Error('Fidelity authentication is required');
      }
      if (result.status === 'institution-unavailable') {
        throw new Error('Fidelity is temporarily unavailable');
      }
      for (const message of result.skipped) {
        context.report({ type: 'warning', message });
      }

      const routed = routeFidelityArtifacts(result.artifacts, accounts);
      context.report({
        type: 'phase',
        message: `Validated ${routed.length} Fidelity artifact${routed.length === 1 ? '' : 's'}`,
        data: { accountsDiscovered: result.accountsDiscovered },
      });
      return routed;
    },
  };
}

export const fidelityConnector = createFidelityConnector();
