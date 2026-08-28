import { describe, expect, test } from 'bun:test';

import type {
  SyncAccountCoverage,
  SyncConnectorContext,
  SyncConnectorRunContext,
} from '../connector.ts';
import type { SyncEvent } from '../protocol.ts';
import type {
  MarcusDownloadedArtifact,
  MarcusRemoteAccount,
  MarcusSyncConfig,
  MarcusSyncResult,
} from './marcus.ts';
import {
  createMarcusConnector,
  inferMarcusAccountKind,
  inferMarcusAccountLast4,
  marcusConnector,
  matchesMarcusAccount,
  planMarcusAccounts,
  routeMarcusArtifacts,
} from './marcusConnector.ts';

function account(overrides: Partial<SyncAccountCoverage> = {}): SyncAccountCoverage {
  return {
    id: 1,
    name: 'Online Savings 1111',
    institution: 'Marcus',
    type: 'savings',
    latestFactDate: '2026-07-31',
    earliestFactDate: '2025-01-01',
    latestBalanceDate: '2026-07-31',
    earliestBalanceDate: '2025-01-31',
    balanceDates: ['2026-07-31'],
    sourceAccountName: 'Online Savings - 1111',
    sourceAccountNames: [],
    accountAliases: [],
    accountHolder: null,
    artifactFileNames: [],
    ...overrides,
  };
}

function connectorContext(accounts: SyncAccountCoverage[]): SyncConnectorContext {
  return { today: '2026-08-20', accounts };
}

function runContext(
  accounts: SyncAccountCoverage[],
  report: SyncConnectorRunContext['report'] = () => {},
): SyncConnectorRunContext {
  return {
    ...connectorContext(accounts),
    goal: { kind: 'current', overlapDays: 7 },
    outputDir: '/tmp/easymoney-marcus-connector-test',
    report,
  };
}

function remoteSavings(last4 = '1111'): MarcusRemoteAccount {
  return {
    kind: 'savings',
    last4,
    sourceAccountKey: `marcus:savings:${last4}`,
    parserAccountName: `Online Savings - ${last4}`,
    supportedArtifactTypes: ['statement-pdf'],
    availableArtifactCount: 1,
  };
}

function completeResult(
  artifacts: MarcusDownloadedArtifact[] = [],
): Extract<MarcusSyncResult, { status: 'complete' }> {
  return {
    status: 'complete',
    accounts: [remoteSavings()],
    artifacts,
    unsupportedArtifactCount: 0,
    unmappedAccountCount: 0,
    unavailableAccountCount: 0,
  };
}

describe('Marcus connector', () => {
  test('discovers one login target only when matching accounts exist', () => {
    const marcus = account();
    const goldman = account({ id: 2, institution: 'Goldman Sachs Bank USA' });
    const other = account({ id: 3, institution: 'Other Bank' });

    expect(matchesMarcusAccount(marcus)).toBe(true);
    expect(matchesMarcusAccount(goldman)).toBe(true);
    expect(matchesMarcusAccount(other)).toBe(false);
    expect(marcusConnector.listTargets(connectorContext([marcus, goldman, other])))
      .toEqual([{ label: 'Marcus' }]);
    expect(marcusConnector.listTargets(connectorContext([other]))).toEqual([]);
  });

  test('infers supported account identity from durable source names and aliases', () => {
    expect(inferMarcusAccountKind(account())).toBe('savings');
    expect(inferMarcusAccountKind(account({
      name: 'Account 2222',
      type: 'asset',
      sourceAccountName: 'High-Yield CD - 2222',
    }))).toBe('deposit');
    expect(inferMarcusAccountLast4(account())).toBe('1111');
    expect(inferMarcusAccountLast4(account({
      sourceAccountName: null,
      name: 'Savings without suffix',
      accountAliases: ['Online Savings 2222', 'Online Savings 3333'],
    }))).toBeNull();
    expect(inferMarcusAccountLast4(account({
      name: 'Savings 2222',
      sourceAccountName: 'Online Savings Account ending in 1111',
    }))).toBeNull();
    expect(inferMarcusAccountLast4(account({
      name: 'Savings 2222',
      sourceAccountName: 'Online Savings Account ending in 1111',
      last4: '3333',
    }))).toBe('3333');
    expect(inferMarcusAccountKind(account({
      accountAliases: ['High-Yield CD - 1111'],
    }))).toBeNull();
  });

  test('plans every parser-supported savings account with independent coverage windows', () => {
    const events: Array<Omit<SyncEvent, 'runId' | 'timestamp'>> = [];
    const plans = planMarcusAccounts(connectorContext([
      account({ id: 10, name: 'Savings 1111', latestFactDate: '2026-07-31' }),
      account({
        id: 20,
        name: 'Savings 2222',
        sourceAccountName: 'Online Savings - 2222',
        latestFactDate: '2026-06-30',
      }),
      account({
        id: 30,
        name: 'CD 3333',
        type: 'deposit',
        sourceAccountName: 'High-Yield CD - 3333',
      }),
      account({
        id: 40,
        name: 'Savings without suffix',
        sourceAccountName: null,
      }),
    ]), { kind: 'current', overlapDays: 7 }, event => events.push(event));

    expect(plans).toEqual([
      { accountId: 10, kind: 'savings', last4: '1111', startDate: '2026-07-24' },
      { accountId: 20, kind: 'savings', last4: '2222', startDate: '2026-06-23' },
    ]);
    expect(events.filter(event => event.type === 'warning').map(event => event.data)).toEqual([
      { accountId: 30, reason: 'unsupported-account-kind' },
      { accountId: 40, reason: 'missing-identity' },
    ]);
  });

  test('rejects duplicate local account identities before launching a browser', async () => {
    let called = false;
    const connector = createMarcusConnector(async () => {
      called = true;
      return completeResult();
    });

    await expect(connector.run(runContext([
      account({ id: 10 }),
      account({ id: 20, name: 'Second savings 1111' }),
    ]))).rejects.toThrow('share one routing identity');
    expect(called).toBe(false);
  });

  test('runs one cache-aware session and returns account-routed parser-validated artifacts', async () => {
    let capturedConfig: MarcusSyncConfig | undefined;
    const events: Array<Omit<SyncEvent, 'runId' | 'timestamp'>> = [];
    const artifact: MarcusDownloadedArtifact = {
      fileName: 'marcus-online-savings-1111-2026-07-31-statement.pdf',
      path: '/tmp/easymoney-marcus-connector-test/marcus-online-savings-1111-2026-07-31-statement.pdf',
      artifactType: 'statement-pdf',
      accountId: 10,
      account: remoteSavings(),
      statementDate: '2026-07-31',
      parserId: 'marcus-statement-pdf',
      size: 100,
      transactionCount: 2,
      balanceCount: 1,
    };
    const connector = createMarcusConnector(async (config, report) => {
      capturedConfig = config;
      report?.({
        type: 'action',
        message: 'Checking Marcus cached authentication',
        data: { step: 'check-authentication', status: 'completed', durationMs: 12 },
      });
      return completeResult([artifact]);
    });

    await expect(connector.run(runContext([
      account({ id: 10 }),
    ], event => events.push(event)))).resolves.toEqual([{
      fileName: artifact.fileName,
      accountId: 10,
    }]);
    expect(capturedConfig).toEqual({
      outputDir: '/tmp/easymoney-marcus-connector-test',
      through: '2026-08-20',
      accounts: [{ accountId: 10, kind: 'savings', last4: '1111', startDate: '2026-07-24' }],
      session: 'marcus-catchup',
      allowInteractiveAuthentication: true,
    });
    expect(events).toContainEqual({
      type: 'action',
      message: 'Checking Marcus cached authentication',
      data: { step: 'check-authentication', status: 'completed', durationMs: 12 },
    });
  });

  test('rejects authentication-required and unplanned artifact results', async () => {
    const authConnector = createMarcusConnector(async () => ({
      status: 'authentication-required',
      reason: 'expired',
      accounts: [],
      artifacts: [],
    }));
    await expect(authConnector.run(runContext([account({ id: 10 })])))
      .rejects.toThrow('authentication is required');

    expect(() => routeMarcusArtifacts([{
      fileName: 'statement.pdf',
      accountId: 99,
    }], [{
      accountId: 10,
      kind: 'savings',
      last4: '1111',
      startDate: '2026-07-24',
    }])).toThrow('unplanned local account');
  });
});
