import type {
  MultiAccountSyncArtifact,
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

export function routeTiaaArtifacts(
  artifacts: readonly TiaaDownloadedArtifact[],
): MultiAccountSyncArtifact[] {
  return artifacts.map(artifact => {
    if (artifact.account.remoteAccounts.length === 0) {
      throw new Error('A TIAA artifact exposes no parser-backed account claims');
    }
    const claimKeys = artifact.account.remoteAccounts.map(account => account.claimKey.trim());
    if (claimKeys.some(value => !value) || new Set(claimKeys).size !== claimKeys.length) {
      throw new Error('A TIAA artifact exposes ambiguous parser-backed account claims');
    }
    return {
      fileName: artifact.fileName,
      accountRoutes: claimKeys.map(remoteAccountId => ({ remoteAccountId })),
    };
  });
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
      const routed = routeTiaaArtifacts(result.artifacts);

      context.report({
        type: 'phase',
        message: `Validated ${routed.length} TIAA artifact${routed.length === 1 ? '' : 's'}`,
        data: {
          accountsDiscovered: result.accountsDiscovered,
          accountSelectionsDiscovered: result.accountSelectionsDiscovered,
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
