import { describe, expect, test } from 'bun:test';

import type {
  SyncAccountCoverage,
  SyncConnectorRunContext,
} from '../connector.ts';
import type { SyncEvent } from '../protocol.ts';
import type {
  WellsFargoDownloadedArtifact,
  WellsFargoSyncConfig,
} from './wellsFargo.ts';
import {
  createWellsFargoConnector,
  inferWellsFargoAccountKind,
  inferWellsFargoAccountLast4,
  matchesWellsFargoAccount,
  planWellsFargoAccounts,
  routeWellsFargoArtifacts,
  wellsFargoConnector,
} from './wellsFargoConnector.ts';

function account(overrides: Partial<SyncAccountCoverage> = {}): SyncAccountCoverage {
  return {
    id: 1,
    name: 'Everyday Checking 1111',
    institution: 'Wells Fargo',
    type: 'checking',
    latestFactDate: '2026-08-01',
    earliestFactDate: '2020-01-01',
    latestBalanceDate: '2026-07-31',
    earliestBalanceDate: '2020-01-31',
    balanceDates: ['2026-07-31'],
    sourceAccountName: 'Everyday Checking account ending in 1111',
    sourceAccountNames: [],
    accountAliases: [],
    accountHolder: null,
    artifactFileNames: [],
    last4: null,
    ...overrides,
  };
}

function runContext(
  accounts: SyncAccountCoverage[],
  report: SyncConnectorRunContext['report'] = () => {},
): SyncConnectorRunContext {
  return {
    today: '2026-08-20',
    accounts,
    goal: { kind: 'current', overlapDays: 7 },
    outputDir: '/tmp/easymoney-wells-fargo-connector-test',
    report,
  };
}

function artifact(
  overrides: Partial<WellsFargoDownloadedArtifact> = {},
): WellsFargoDownloadedArtifact {
  return {
    accountId: 10,
    fileName: 'wells-fargo-checking-1111-2026-07-25-to-2026-08-20.csv',
    path: '/tmp/easymoney-wells-fargo-connector-test/wells-fargo-checking-1111-2026-07-25-to-2026-08-20.csv',
    kind: 'activity',
    account: { kind: 'checking', last4: '1111' },
    coveredFrom: '2026-07-25',
    coveredThrough: '2026-08-20',
    byteLength: 100,
    transactionCount: 2,
    balanceCount: 0,
    ...overrides,
  };
}

describe('Wells Fargo connector', () => {
  test('exposes exactly one catch-up action for one Wells Fargo login', () => {
    const wells = account();
    const other = account({
      id: 2,
      institution: 'Other Bank',
      name: 'Other checking 2222',
      sourceAccountName: null,
    });

    expect(matchesWellsFargoAccount(wells)).toBe(true);
    expect(matchesWellsFargoAccount(other)).toBe(false);
    expect(wellsFargoConnector.listTargets({ today: '2026-08-20', accounts: [wells, other] }))
      .toEqual([{ label: 'Wells Fargo' }]);
    expect(wellsFargoConnector.listTargets({ today: '2026-08-20', accounts: [other] }))
      .toEqual([]);
  });

  test('infers supported account kinds and exact account identity without fixed product names', () => {
    const savings = account({
      name: 'Goal account',
      type: 'asset',
      sourceAccountName: 'Way2Save Savings account ending in 2222',
    });
    const card = account({
      name: 'Rewards account',
      type: 'credit',
      sourceAccountName: 'Visa Signature XXXX3333',
    });
    const ambiguous = account({
      sourceAccountName: 'Checking ending in 1111',
      accountAliases: ['Checking ending in 9999'],
    });

    expect(inferWellsFargoAccountKind(savings)).toBe('savings');
    expect(inferWellsFargoAccountLast4(savings)).toBe('2222');
    expect(inferWellsFargoAccountKind(card)).toBe('credit-card');
    expect(inferWellsFargoAccountLast4(card)).toBe('3333');
    expect(inferWellsFargoAccountLast4(ambiguous)).toBeNull();
    expect(inferWellsFargoAccountLast4({ ...ambiguous, last4: '4444' })).toBe('4444');
  });

  test('plans account-specific activity and statement windows', () => {
    expect(planWellsFargoAccounts(runContext([
      account({ id: 10 }),
      account({
        id: 20,
        name: 'Goal Savings 2222',
        type: 'savings',
        latestFactDate: '2026-07-15',
        latestBalanceDate: '2026-06-30',
        sourceAccountName: 'Goal Savings account ending in 2222',
      }),
      account({
        id: 30,
        name: 'Autograph Visa 3333',
        type: 'credit',
        latestFactDate: null,
        latestBalanceDate: null,
        sourceAccountName: 'Autograph Visa account ending in 3333',
      }),
    ]))).toEqual([
      {
        accountId: 10,
        kind: 'checking',
        last4: '1111',
        activityFrom: '2026-07-25',
        activityThrough: '2026-08-20',
        statementFrom: '2026-07-24',
        statementThrough: '2026-08-20',
      },
      {
        accountId: 20,
        kind: 'savings',
        last4: '2222',
        activityFrom: '2026-07-08',
        activityThrough: '2026-08-20',
        statementFrom: '2026-06-23',
        statementThrough: '2026-08-20',
      },
      {
        accountId: 30,
        kind: 'credit-card',
        last4: '3333',
        activityFrom: '2025-08-20',
        activityThrough: '2026-08-20',
        statementFrom: '2025-08-20',
        statementThrough: '2026-08-20',
      },
    ]);
  });

  test('warns and skips local accounts with incomplete or ambiguous routing identity', () => {
    const events: Array<Omit<SyncEvent, 'runId' | 'timestamp'>> = [];
    expect(planWellsFargoAccounts(runContext([
      account({
        id: 1,
        name: 'Account without product kind 1111',
        type: 'asset',
        sourceAccountName: 'Account ending in 1111',
      }),
      account({
        id: 2,
        accountAliases: ['Checking ending in 9999'],
      }),
    ], event => events.push(event)))).toEqual([]);

    expect(events).toHaveLength(2);
    expect(events.every(event =>
      event.type === 'warning' &&
      typeof event.data?.accountId === 'number'
    )).toBe(true);
  });

  test('rejects duplicate local routing identities before opening the browser', async () => {
    let called = false;
    const connector = createWellsFargoConnector(async () => {
      called = true;
      return { accounts: [], artifacts: [], unavailable: [] };
    });

    await expect(connector.run(runContext([
      account({ id: 10 }),
      account({ id: 20, name: 'Second Checking 1111' }),
    ]))).rejects.toThrow('ambiguous routing identity');
    expect(called).toBe(false);
  });

  test('runs one login with all planned accounts and routes parser-validated artifacts by account id', async () => {
    let capturedConfig: WellsFargoSyncConfig | undefined;
    const events: Array<Omit<SyncEvent, 'runId' | 'timestamp'>> = [];
    const connector = createWellsFargoConnector(async (config, onProgress) => {
      capturedConfig = config;
      onProgress?.({
        step: 'activity-validation',
        status: 'completed',
        timestamp: '2026-08-24T00:00:00.000Z',
        message: 'Wells Fargo activity validation complete',
        accountIndex: 1,
        accountCount: 1,
        accountKind: 'checking',
        artifactKind: 'activity',
      });
      return {
        accounts: [{ kind: 'checking', last4: '1111' }],
        artifacts: [artifact()],
        unavailable: [],
      };
    });

    await expect(connector.run(runContext([
      account({ id: 10 }),
    ], event => events.push(event)))).resolves.toEqual([{
      fileName: 'wells-fargo-checking-1111-2026-07-25-to-2026-08-20.csv',
      accountId: 10,
    }]);

    expect(capturedConfig).toEqual({
      outputDir: '/tmp/easymoney-wells-fargo-connector-test',
      accounts: [{
        accountId: 10,
        kind: 'checking',
        last4: '1111',
        activityFrom: '2026-07-25',
        activityThrough: '2026-08-20',
        statementFrom: '2026-07-24',
        statementThrough: '2026-08-20',
      }],
      session: 'wells-fargo-catchup',
    });
    expect(events).toContainEqual({
      type: 'phase',
      message: 'Wells Fargo activity validation complete',
      data: {
        step: 'activity-validation',
        status: 'completed',
        timestamp: '2026-08-24T00:00:00.000Z',
        accountIndex: 1,
        accountCount: 1,
        accountKind: 'checking',
        artifactKind: 'activity',
      },
    });
  });

  test('rejects an artifact whose validated identity changed before staging', () => {
    expect(() => routeWellsFargoArtifacts([
      artifact({ account: { kind: 'credit-card', last4: '1111' } }),
    ], [{
      accountId: 10,
      kind: 'checking',
      last4: '1111',
      activityFrom: '2026-07-25',
      activityThrough: '2026-08-20',
      statementFrom: '2026-07-24',
      statementThrough: '2026-08-20',
    }])).toThrow('did not match');
  });
});
