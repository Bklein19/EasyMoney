import { describe, expect, test } from 'bun:test';

import type {
  SyncAccountCoverage,
  SyncConnectorRunContext,
} from '../connector.ts';
import type { SyncEvent } from '../protocol.ts';
import type {
  SequoiaFundArtifactKind,
  SequoiaFundDownloadedArtifact,
  SequoiaFundProgressReporter,
  SequoiaFundSyncConfig,
  SequoiaFundSyncResult,
} from './sequoiaFund.ts';
import {
  createSequoiaFundConnector,
  selectSequoiaFundAccount,
  sequoiaFundCanonicalAccountToken,
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

function accountNameForToken(accountToken: string): string {
  const last4 = accountToken.match(/^last4-(\d{4})$/)?.[1];
  if (last4) return `Sequoia Fund - ${last4}`;
  const key = accountToken.match(/^key-([a-f0-9]{12})$/)?.[1];
  if (key) return `Sequoia Fund account ${key}`;
  throw new Error('Invalid test account token');
}

function artifact(
  accountToken: string,
  fileName: string,
  overrides: Partial<SequoiaFundDownloadedArtifact> = {},
): SequoiaFundDownloadedArtifact {
  const kind: SequoiaFundArtifactKind = overrides.kind ?? 'activity';
  return {
    fileName,
    path: `/tmp/${fileName}`,
    kind,
    parserId: kind === 'activity'
      ? 'sequoia-fund-activity-csv'
      : 'sequoia-fund-statement-pdf',
    accountToken,
    accountName: accountNameForToken(accountToken),
    status: 'downloaded',
    size: 100,
    transactionCount: kind === 'activity' ? 1 : 0,
    balanceCount: kind === 'statement' ? 1 : 0,
    ...overrides,
  };
}

function result(
  artifacts: SequoiaFundDownloadedArtifact[],
  overrides: Partial<SequoiaFundSyncResult> = {},
): SequoiaFundSyncResult {
  return {
    artifacts,
    accountCount: 1,
    activityCount: artifacts.filter(item => item.kind === 'activity').length,
    statementCount: artifacts.filter(item => item.kind === 'statement').length,
    ...overrides,
  };
}

function runContext(
  accounts: SyncAccountCoverage[],
  report: SyncConnectorRunContext['report'] = () => {},
  connectionId?: string,
): SyncConnectorRunContext {
  return {
    today: '2026-08-24',
    accounts,
    ...(connectionId ? { connectionId } : {}),
    goal: { kind: 'current', overlapDays: 7 },
    outputDir: '/tmp/sequoia-connector-test',
    report,
  };
}

describe('Sequoia Fund connector targeting', () => {
  test('lists one connection target for every local Sequoia Fund account', () => {
    const accounts = [
      account(1, { accountHolder: 'Example Owner' }),
      account(2, { name: 'Second fund' }),
      account(3, { institution: 'Different Institution' }),
    ];

    expect(accounts.map(item => sequoiaFundConnector.matchesAccount(item))).toEqual([true, true, false]);
    expect(sequoiaFundConnector.listTargets({ today: '2026-08-24', accounts })).toEqual([
      { connectionId: 'account-1', label: 'Sequoia Fund (Example Owner)' },
      { connectionId: 'account-2', label: 'Sequoia Fund (Second fund)' },
    ]);
    expect(sequoiaFundConnector.listTargets({ today: '2026-08-24', accounts: [accounts[2]!] }))
      .toEqual([]);
  });

  test('selects an exact local connection and permits only a single-account fallback', () => {
    const accounts = [account(10), account(20)];

    expect(selectSequoiaFundAccount(accounts, 'account-20')).toBe(accounts[1]);
    expect(selectSequoiaFundAccount([accounts[0]!])).toBe(accounts[0]);
    expect(() => selectSequoiaFundAccount(accounts)).toThrow(
      'Select exactly one Sequoia Fund account connection',
    );
    expect(() => selectSequoiaFundAccount(accounts, 'account-30')).toThrow(
      'Sequoia Fund connection is unavailable',
    );
    expect(() => selectSequoiaFundAccount(accounts, 'wrong-shape')).toThrow(
      'Sequoia Fund connection is unavailable',
    );
  });

  test('uses a confirmed last four or a stable local-account hash as the canonical token', () => {
    expect(sequoiaFundCanonicalAccountToken(account(42, { last4: '0123' }))).toBe('last4-0123');
    expect(sequoiaFundCanonicalAccountToken(account(42))).toBe('key-90a2dadb275a');
    expect(sequoiaFundCanonicalAccountToken(account(42))).toBe(
      sequoiaFundCanonicalAccountToken(account(42)),
    );
    expect(sequoiaFundCanonicalAccountToken(account(43))).toBe('key-fd9beab72ec5');
  });
});

describe('Sequoia Fund connector execution', () => {
  test('selects the requested local account and routes every scoped artifact back to it', async () => {
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
      return result([
        artifact('last4-2222', 'first-scope.csv'),
        artifact('last4-2222', 'second-scope.csv'),
        artifact('last4-2222', 'statement.pdf', { kind: 'statement' }),
      ]);
    });
    const accounts = [
      account(1, {
        name: 'First fund',
        last4: '1111',
        latestFactDate: '2026-08-10',
      }),
      account(2, {
        name: 'Second fund',
        last4: '2222',
        latestFactDate: '2026-07-01',
      }),
    ];

    await expect(connector.run(runContext(
      accounts,
      event => events.push(event),
      'account-2',
    ))).resolves.toEqual([
      { fileName: 'first-scope.csv', accountId: 2 },
      { fileName: 'second-scope.csv', accountId: 2 },
      { fileName: 'statement.pdf', accountId: 2 },
    ]);
    expect(calls).toEqual([{
      outputDir: '/tmp/sequoia-connector-test',
      from: '2026-06-24',
      through: '2026-08-24',
      accountToken: 'last4-2222',
      session: 'sequoia-fund-account-2-catchup',
    }]);
    expect(events).toContainEqual({
      type: 'phase',
      message: 'Opening Sequoia Fund',
      data: {
        goal: 'current',
        accountCount: 1,
        from: '2026-06-24',
        through: '2026-08-24',
      },
    });
    expect(events).toContainEqual({
      type: 'action',
      message: 'Waiting for authentication',
      data: {
        phase: 'authentication',
        state: 'waiting',
        elapsedMs: 125,
        attempt: 1,
      },
    });
    expect(events).toContainEqual({
      type: 'phase',
      message: 'Validated 3 Sequoia Fund artifacts',
    });
  });

  test('runs the unambiguous fallback with the selected account canonical hash', async () => {
    const calls: SequoiaFundSyncConfig[] = [];
    const connector = createSequoiaFundConnector(async config => {
      calls.push(config);
      return result([artifact('key-90a2dadb275a', 'activity.csv')]);
    });

    await expect(connector.run(runContext([account(42)]))).resolves.toEqual([
      { fileName: 'activity.csv', accountId: 42 },
    ]);
    expect(calls[0]).toMatchObject({
      accountToken: 'key-90a2dadb275a',
      session: 'sequoia-fund-account-42-catchup',
    });
  });

  test('fails before invoking the runner when the local target is ambiguous or unavailable', async () => {
    let invocationCount = 0;
    const connector = createSequoiaFundConnector(async () => {
      invocationCount += 1;
      return result([]);
    });

    await expect(connector.run(runContext([account(10), account(20)]))).rejects.toThrow(
      'Select exactly one Sequoia Fund account connection',
    );
    await expect(connector.run(runContext([account(10)], undefined, 'account-20'))).rejects.toThrow(
      'Sequoia Fund connection is unavailable',
    );
    await expect(connector.run(runContext([
      account(10, { institution: 'Different Institution' }),
    ]))).rejects.toThrow('Select exactly one Sequoia Fund account connection');
    expect(invocationCount).toBe(0);
  });

  test('rejects artifacts with a different canonical token or account name', async () => {
    const wrongToken = createSequoiaFundConnector(async () => result([
      artifact('last4-2222', 'activity.csv'),
    ]));
    await expect(wrongToken.run(runContext([account(10, { last4: '1111' })])))
      .rejects.toThrow('Sequoia Fund returned an artifact for a different canonical account');

    const wrongName = createSequoiaFundConnector(async () => result([
      artifact('last4-1111', 'activity.csv', { accountName: 'Wrong name' }),
    ]));
    await expect(wrongName.run(runContext([account(10, { last4: '1111' })])))
      .rejects.toThrow('Sequoia Fund returned an artifact for a different canonical account');
  });

  test('rejects duplicate filenames even when every artifact has the canonical identity', async () => {
    const connector = createSequoiaFundConnector(async () => result([
      artifact('last4-1111', 'duplicate.csv'),
      artifact('last4-1111', 'duplicate.csv'),
    ]));

    await expect(connector.run(runContext([account(10, { last4: '1111' })])))
      .rejects.toThrow('Sequoia Fund returned a duplicate artifact filename');
  });

  test('rejects a low-level result that does not represent one canonical account', async () => {
    for (const invalidAccountCount of [0, 2]) {
      const connector = createSequoiaFundConnector(async () => result(
        [artifact('last4-1111', 'activity.csv')],
        { accountCount: invalidAccountCount },
      ));

      await expect(connector.run(runContext([account(10, { last4: '1111' })])))
        .rejects.toThrow('Sequoia Fund returned an invalid account count');
    }
  });
});
