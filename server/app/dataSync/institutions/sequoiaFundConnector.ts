import { createHash } from 'node:crypto';

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

function connectionIdForAccount(account: SyncAccountCoverage): string {
  return `account-${account.id}`;
}

export function sequoiaFundCanonicalAccountToken(account: Pick<SyncAccountCoverage, 'id' | 'last4'>): string {
  if (/^\d{4}$/.test(account.last4 ?? '')) return `last4-${account.last4}`;
  const key = createHash('sha256')
    .update(`sequoia-fund-local-account:${account.id}`)
    .digest('hex')
    .slice(0, 12);
  return `key-${key}`;
}

function accountNameForToken(accountToken: string): string {
  const last4 = accountToken.match(/^last4-(\d{4})$/)?.[1];
  if (last4) return `Sequoia Fund - ${last4}`;
  const key = accountToken.match(/^key-([a-f0-9]{12})$/)?.[1];
  if (key) return `Sequoia Fund account ${key}`;
  throw new Error('Sequoia Fund canonical account token is invalid');
}

export function selectSequoiaFundAccount(
  accounts: SyncAccountCoverage[],
  connectionId?: string,
): SyncAccountCoverage {
  const matches = accounts.filter(matchesSequoiaFundAccount);
  if (connectionId) {
    if (!/^account-\d+$/.test(connectionId)) throw new Error('Sequoia Fund connection is unavailable');
    const selected = matches.find(account => connectionIdForAccount(account) === connectionId);
    if (!selected) throw new Error('Sequoia Fund connection is unavailable');
    return selected;
  }
  if (matches.length !== 1) {
    throw new Error('Select exactly one Sequoia Fund account connection');
  }
  return matches[0]!;
}

function routeArtifacts(
  artifacts: SequoiaFundDownloadedArtifact[],
  account: SyncAccountCoverage,
  accountToken: string,
): RoutedSyncArtifact[] {
  const accountName = accountNameForToken(accountToken);
  const fileNames = new Set<string>();
  return artifacts.map(artifact => {
    if (artifact.accountToken !== accountToken || artifact.accountName !== accountName) {
      throw new Error('Sequoia Fund returned an artifact for a different canonical account');
    }
    if (fileNames.has(artifact.fileName)) throw new Error('Sequoia Fund returned a duplicate artifact filename');
    fileNames.add(artifact.fileName);
    return { fileName: artifact.fileName, accountId: account.id };
  });
}

function targetLabel(account: SyncAccountCoverage): string {
  const detail = account.accountHolder?.trim() || account.name.trim();
  return detail ? `Sequoia Fund (${detail})` : 'Sequoia Fund';
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
      return accounts.map(account => ({
        connectionId: connectionIdForAccount(account),
        label: targetLabel(account),
      }));
    },

    async run(context) {
      const account = selectSequoiaFundAccount(context.accounts, context.connectionId);
      const window = goalWindowForCoverage(context.goal, account, context.today);
      const accountToken = sequoiaFundCanonicalAccountToken(account);
      const connectionId = connectionIdForAccount(account);

      context.report({
        type: 'phase',
        message: 'Opening Sequoia Fund',
        data: {
          goal: context.goal.kind,
          accountCount: 1,
          from: window.startDate,
          through: window.endDate,
        },
      });

      const result = await runSync(
        {
          outputDir: context.outputDir,
          from: window.startDate,
          through: window.endDate,
          accountToken,
          session: `sequoia-fund-${connectionId}-catchup`,
        },
        event => reportProgress(context, event),
      );
      if (result.accountCount !== 1) throw new Error('Sequoia Fund returned an invalid account count');
      const routed = routeArtifacts(result.artifacts, account, accountToken);

      context.report({
        type: 'phase',
        message: `Validated ${routed.length} Sequoia Fund artifact${routed.length === 1 ? '' : 's'}`,
      });
      return routed;
    },
  } satisfies SyncConnector<'sequoia-fund'>;
}

export const sequoiaFundConnector = createSequoiaFundConnector();
