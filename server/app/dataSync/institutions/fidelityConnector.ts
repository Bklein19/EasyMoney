import type {
  MultiAccountSyncArtifact,
  RoutedSyncArtifact,
  SyncAccountCoverage,
  SyncConnector,
  SyncConnectorContext,
  SyncConnectorRunContext,
} from '../connector.ts';
import { goalWindowForCoverage } from '../planning.ts';
import {
  runFidelitySync,
  type FidelityDownloadedArtifact,
  type FidelityProgressEvent,
} from './fidelity.ts';

type FidelitySyncRunner = typeof runFidelitySync;

export function matchesFidelityAccount(account: SyncAccountCoverage): boolean {
  return /\bfidelity\b/i.test(account.institution?.trim() ?? '');
}

export function routeFidelityArtifacts(
  artifacts: readonly FidelityDownloadedArtifact[],
): MultiAccountSyncArtifact[] {
  return artifacts.map(artifact => {
    if (artifact.sourceAccounts.length === 0) {
      throw new Error('A Fidelity artifact exposes no parser-backed account claims');
    }
    const remoteAccountIds = artifact.sourceAccounts.map(account => account.remoteAccountId.trim());
    if (remoteAccountIds.some(value => !value) || new Set(remoteAccountIds).size !== remoteAccountIds.length) {
      throw new Error('A Fidelity artifact exposes ambiguous parser-backed account claims');
    }
    return {
      fileName: artifact.fileName,
      accountRoutes: remoteAccountIds.map(remoteAccountId => ({ remoteAccountId })),
    };
  });
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

      const routed: RoutedSyncArtifact[] = routeFidelityArtifacts(result.artifacts);
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
