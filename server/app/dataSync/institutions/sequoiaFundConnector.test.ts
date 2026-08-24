import { describe, expect, test } from 'bun:test';

import type {
  SyncAccountCoverage,
  SyncConnectorRunContext,
} from '../connector.ts';
import type { SyncEvent } from '../protocol.ts';
import type {
  SequoiaFundDownloadedArtifact,
  SequoiaFundProgressReporter,
  SequoiaFundSyncConfig,
  SequoiaFundSyncResult,
} from './sequoiaFund.ts';
import {
  createSequoiaFundConnector,
  sequoiaFundConnector,
} from './sequoiaFundConnector.ts';

function account(
  id: number,
  overrides: Partial<SyncAccountCoverage> = {},
): SyncAccountCoverage {
  return {
    id,
    name: `Sequoia account ${id}`,
    institution: 'Sequoia Fund',
    type: 'investment',
    latestFactDate: null,
    earliestFactDate: null,
    latestBalanceDate: null,
    earliestBalanceDate: null,
    balanceDates: [],
    sourceAccountName: null,
    sourceAccountNames: [],
    accountAliases: [],
    accountHolder: null,
    artifactFileNames: [],
    ...overrides,
  };
}

function artifact(
  accountToken: string,
  accountName: string,
  fileName: string,
): SequoiaFundDownloadedArtifact {
  return {
    fileName,
    path: `/tmp/${fileName}`,
    kind: 'activity',
    parserId: 'sequoia-fund-activity-csv',
    accountToken,
    accountName,
    status: 'downloaded',
    size: 100,
    transactionCount: 1,
    balanceCount: 0,
  };
}

function result(artifacts: SequoiaFundDownloadedArtifact[]): SequoiaFundSyncResult {
  return {
    artifacts,
    accountCount: new Set(artifacts.map(item => item.accountToken)).size,
    activityCount: artifacts.filter(item => item.kind === 'activity').length,
    statementCount: artifacts.filter(item => item.kind === 'statement').length,
  };
}

function runContext(
  accounts: SyncAccountCoverage[],
  report: SyncConnectorRunContext['report'] = () => {},
): SyncConnectorRunContext {
  return {
    today: '2026-08-24',
    accounts,
    goal: { kind: 'current', overlapDays: 7 },
    outputDir: '/tmp/sequoia-connector-test',
    report,
  };
}

describe('Sequoia Fund connector targeting', () => {
  test('matches only Sequoia accounts and identifies a unique account holder', () => {
    const accounts = [
      account(1, { accountHolder: 'Example Owner' }),
      account(2, { accountHolder: 'Example Owner' }),
      account(3, { institution: 'Different Institution' }),
    ];

    expect(accounts.map(item => sequoiaFundConnector.matchesAccount(item))).toEqual([true, true, false]);
    expect(sequoiaFundConnector.listTargets({ today: '2026-08-24', accounts })).toEqual([
      { label: 'Sequoia Fund (Example Owner)' },
    ]);
  });

  test('omits the owner suffix when ownership is unavailable or ambiguous', () => {
    expect(sequoiaFundConnector.listTargets({
      today: '2026-08-24',
      accounts: [account(1, { accountHolder: 'Owner One' }), account(2, { accountHolder: 'Owner Two' })],
    })).toEqual([{ label: 'Sequoia Fund' }]);
    expect(sequoiaFundConnector.listTargets({ today: '2026-08-24', accounts: [] })).toEqual([]);
  });
});

describe('Sequoia Fund connector execution', () => {
  test('combines account windows, invokes the low-level sync, translates progress, and routes artifacts', async () => {
    const calls: SequoiaFundSyncConfig[] = [];
    const events: Array<Omit<SyncEvent, 'runId' | 'timestamp'>> = [];
    const connector = createSequoiaFundConnector(async (
      config: SequoiaFundSyncConfig,
      progress: SequoiaFundProgressReporter = () => {},
    ) => {
      calls.push(config);
      progress({
        phase: 'authentication',
        state: 'waiting',
        timestamp: '2026-08-24T00:00:00.000Z',
        message: 'Waiting for authentication',
        elapsedMs: 125,
        data: { attempt: 1 },
      });
      progress({
        phase: 'discovery',
        state: 'complete',
        timestamp: '2026-08-24T00:00:01.000Z',
        message: 'Discovered accounts',
      });
      return result([
        artifact('last4-1111', 'Sequoia Fund - 1111', 'first.csv'),
        artifact('key-abc123abc123', 'Sequoia Fund account abc123abc123', 'second.csv'),
      ]);
    });
    const accounts = [
      account(1, {
        name: 'Fund - 1111',
        latestFactDate: '2026-08-10',
      }),
      account(2, {
        name: 'Second fund',
        latestFactDate: '2026-07-01',
        sourceAccountNames: ['Sequoia Fund account abc123abc123'],
      }),
      account(3, {
        institution: 'Different Institution',
        latestFactDate: '2020-01-01',
      }),
    ];

    await expect(connector.run(runContext(accounts, event => events.push(event)))).resolves.toEqual([
      { fileName: 'first.csv', accountId: 1 },
      { fileName: 'second.csv', accountId: 2 },
    ]);
    expect(calls).toEqual([{
      outputDir: '/tmp/sequoia-connector-test',
      from: '2026-06-24',
      through: '2026-08-24',
    }]);
    expect(events).toEqual([
      {
        type: 'phase',
        message: 'Opening Sequoia Fund',
        data: {
          goal: 'current',
          accountCount: 2,
          from: '2026-06-24',
          through: '2026-08-24',
        },
      },
      {
        type: 'action',
        message: 'Waiting for authentication',
        data: {
          phase: 'authentication',
          state: 'waiting',
          elapsedMs: 125,
          attempt: 1,
        },
      },
      {
        type: 'phase',
        message: 'Discovered accounts',
        data: { phase: 'discovery', state: 'complete' },
      },
      {
        type: 'phase',
        message: 'Validated 2 Sequoia Fund artifacts',
      },
    ]);
  });

  test('permits only the unambiguous single-account fallback', async () => {
    const connector = createSequoiaFundConnector(async () => result([
      artifact('key-abc123abc123', 'Unknown remote identity', 'activity.csv'),
    ]));

    await expect(connector.run(runContext([account(10)]))).resolves.toEqual([
      { fileName: 'activity.csv', accountId: 10 },
    ]);
    await expect(connector.run(runContext([account(10), account(20)]))).rejects.toThrow(
      'no unambiguous local account route',
    );
  });

  test('rejects ambiguous last-four matches and conflicting remote identities', async () => {
    const duplicateLast4 = createSequoiaFundConnector(async () => result([
      artifact('last4-1111', 'Sequoia Fund - 1111', 'activity.csv'),
    ]));
    await expect(duplicateLast4.run(runContext([
      account(10, { name: 'First - 1111' }),
      account(20, { accountAliases: ['Second - 1111'] }),
    ]))).rejects.toThrow('no unambiguous local account route');

    const conflictingIdentity = createSequoiaFundConnector(async () => result([
      artifact('last4-1111', 'First identity', 'activity.csv'),
      artifact('last4-1111', 'Second identity', 'statement.pdf'),
    ]));
    await expect(conflictingIdentity.run(runContext([
      account(10, { name: 'Fund - 1111' }),
    ]))).rejects.toThrow('artifacts disagree about their remote account identity');
  });

  test('does not allow two remote accounts to collapse onto one local account', async () => {
    const connector = createSequoiaFundConnector(async () => result([
      artifact('key-first', 'Shared exact identity', 'first.csv'),
      artifact('key-second', 'Shared exact identity', 'second.csv'),
    ]));
    await expect(connector.run(runContext([
      account(10, { sourceAccountName: 'Shared exact identity' }),
    ]))).rejects.toThrow('Multiple Sequoia Fund remote accounts map to the same local account');
  });

  test('fails before invoking the institution runner when no local account matches', async () => {
    let invoked = false;
    const connector = createSequoiaFundConnector(async () => {
      invoked = true;
      return result([]);
    });

    await expect(connector.run(runContext([account(10, { institution: 'Different Institution' })])))
      .rejects.toThrow('No active Sequoia Fund accounts are available');
    expect(invoked).toBe(false);
  });
});
