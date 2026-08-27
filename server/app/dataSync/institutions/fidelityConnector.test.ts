import { describe, expect, test } from 'bun:test';

import type {
  SyncAccountCoverage,
  SyncConnectorRunContext,
} from '../connector.ts';
import type { SyncEvent } from '../protocol.ts';
import type {
  FidelityDownloadedArtifact,
  FidelityProgressReporter,
  FidelitySyncConfig,
  FidelitySyncResult,
} from './fidelity.ts';
import {
  createFidelityConnector,
  fidelityConnector,
  matchesFidelityAccount,
  routeFidelityArtifacts,
} from './fidelityConnector.ts';

function account(
  id: number,
  overrides: Partial<SyncAccountCoverage> = {},
): SyncAccountCoverage {
  return {
    id,
    name: `Fidelity account ${id}`,
    institution: 'Fidelity',
    type: 'investment',
    latestFactDate: '2026-08-01',
    earliestFactDate: '2025-01-01',
    latestBalanceDate: '2026-07-31',
    earliestBalanceDate: '2025-01-31',
    balanceDates: ['2026-07-31'],
    sourceAccountName: null,
    sourceAccountNames: [],
    accountAliases: [],
    accountHolder: null,
    artifactFileNames: [],
    ...overrides,
  };
}

function artifact(
  accountKey: string,
  last4: string | null,
  fileName: string,
  overrides: Partial<FidelityDownloadedArtifact> = {},
): FidelityDownloadedArtifact {
  return {
    artifactType: 'activity-json',
    fileName,
    account: {
      surface: 'retail',
      kind: 'brokerage',
      accountKey,
      remoteAccountId: `fidelity:Z0000${last4 ?? '0000'}`,
      last4,
      label: last4 ? `Brokerage ${last4}` : 'Brokerage account',
    },
    coveredFrom: '2026-07-01',
    coveredThrough: '2026-08-20',
    path: `/tmp/${fileName}`,
    parserId: 'fidelity-activity-api-json',
    transactionCount: 1,
    balanceCount: 0,
    contentHash: 'a'.repeat(64),
    sourceAccounts: [{
      remoteAccountId: `fidelity:Z0000${last4 ?? '0000'}`,
      sourceAccountName: last4 ? `Brokerage ${last4}` : 'Brokerage account',
    }],
    ...overrides,
  };
}

function completeResult(
  artifacts: FidelityDownloadedArtifact[],
): Extract<FidelitySyncResult, { status: 'complete' }> {
  return {
    status: 'complete',
    accountsDiscovered: new Set(artifacts.map(item => item.account.accountKey)).size,
    artifacts,
    skipped: [],
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
    outputDir: '/tmp/easymoney-fidelity-connector-test',
    report,
  };
}

describe('Fidelity connector targeting', () => {
  test('matches Fidelity accounts and identifies one account holder', () => {
    const accounts = [
      account(1, { accountHolder: 'Example Owner' }),
      account(2, { accountHolder: 'Example Owner' }),
      account(3, { institution: 'Different Institution' }),
    ];

    expect(accounts.map(item => fidelityConnector.matchesAccount(item))).toEqual([true, true, false]);
    expect(fidelityConnector.listTargets({ today: '2026-08-20', accounts })).toEqual([
      { label: 'Fidelity (Example Owner)' },
    ]);
    expect(matchesFidelityAccount(accounts[0]!)).toBe(true);
  });

});

describe('Fidelity connector execution', () => {
  test('plans coverage, translates progress, and routes review artifacts', async () => {
    let capturedConfig: FidelitySyncConfig | undefined;
    const events: Array<Omit<SyncEvent, 'runId' | 'timestamp'>> = [];
    const connector = createFidelityConnector(async (
      config: FidelitySyncConfig,
      progress: FidelityProgressReporter = () => {},
    ) => {
      capturedConfig = config;
      progress({
        phase: 'authentication',
        step: 'session',
        status: 'started',
        message: 'Waiting for Fidelity authentication',
        timestamp: '2026-08-20T00:00:00.000Z',
      });
      progress({
        phase: 'download',
        step: 'activity-1',
        status: 'completed',
        message: 'Downloading Fidelity activity complete',
        timestamp: '2026-08-20T00:00:01.000Z',
        durationMs: 125,
        details: { index: 1, total: 2 },
      });
      return {
        ...completeResult([
          artifact('retail-one', '1111', 'fidelity-retail-brokerage-1111-activity.json'),
          artifact('retail-two', null, 'fidelity-retail-retirement-example-activity.json', {
            account: {
              surface: 'retail',
              kind: 'retirement',
              accountKey: 'retail-two',
              remoteAccountId: 'fidelity:retail-token:12345',
              last4: null,
              label: 'Example retirement plan',
            },
            sourceAccounts: [{
              remoteAccountId: 'fidelity:retail-token:12345',
              sourceAccountName: 'Fidelity retirement plan 12345',
            }],
          }),
        ]),
        skipped: ['Fidelity NetBenefits omitted one unsupported document'],
      };
    });
    const accounts = [
      account(10, {
        name: 'Brokerage 1111',
        latestFactDate: '2026-08-01',
      }),
      account(20, {
        name: 'Example 401(k) 2222',
        latestFactDate: '2026-07-15',
      }),
    ];

    await expect(connector.run(runContext(accounts, event => events.push(event)))).resolves.toEqual([
      {
        fileName: 'fidelity-retail-brokerage-1111-activity.json',
        accountRoutes: [{ remoteAccountId: 'fidelity:Z00001111' }],
      },
      {
        fileName: 'fidelity-retail-retirement-example-activity.json',
        accountRoutes: [{ remoteAccountId: 'fidelity:retail-token:12345' }],
      },
    ]);
    expect(capturedConfig).toEqual({
      outputDir: '/tmp/easymoney-fidelity-connector-test',
      from: '2026-07-08',
      through: '2026-08-20',
      session: 'fidelity-catchup',
    });
    expect(events).toContainEqual({
      type: 'action',
      message: 'Waiting for Fidelity authentication',
      data: { phase: 'authentication', step: 'session', status: 'started' },
    });
    expect(events).toContainEqual({
      type: 'phase',
      message: 'Downloading Fidelity activity complete',
      data: {
        phase: 'download',
        step: 'activity-1',
        status: 'completed',
        durationMs: 125,
        index: 1,
        total: 2,
      },
    });
    expect(events).toContainEqual({
      type: 'warning',
      message: 'Fidelity NetBenefits omitted one unsupported document',
    });
  });

  test('keeps authentication and maintenance failures distinct', async () => {
    const authentication = createFidelityConnector(async () => ({
      status: 'authentication-required',
      accountsDiscovered: 0,
      artifacts: [],
      skipped: [],
    }));
    const maintenance = createFidelityConnector(async () => ({
      status: 'institution-unavailable',
      accountsDiscovered: 0,
      artifacts: [],
      skipped: [],
    }));
    const accounts = [account(1)];

    await expect(authentication.run(runContext(accounts))).rejects.toThrow('authentication is required');
    await expect(maintenance.run(runContext(accounts))).rejects.toThrow('temporarily unavailable');
  });

  test('routes only exact parser-backed identities and rejects missing or repeated claims', () => {
    expect(routeFidelityArtifacts([
      artifact('remote-one', '1111', 'activity.json'),
    ])).toEqual([{
      fileName: 'activity.json',
      accountRoutes: [{ remoteAccountId: 'fidelity:Z00001111' }],
    }]);
    expect(() => routeFidelityArtifacts([
      artifact('remote-one', '1111', 'missing.json', { sourceAccounts: [] }),
    ])).toThrow('no parser-backed account claims');
    expect(() => routeFidelityArtifacts([
      artifact('remote-one', '1111', 'ambiguous.json', { sourceAccounts: [
        { remoteAccountId: 'fidelity:Z00001111', sourceAccountName: 'First' },
        { remoteAccountId: 'fidelity:Z00001111', sourceAccountName: 'Second' },
      ] }),
    ])).toThrow('ambiguous parser-backed account claims');
  });

  test('does not invoke Fidelity when no matching local account exists', async () => {
    let invoked = false;
    const connector = createFidelityConnector(async () => {
      invoked = true;
      return completeResult([]);
    });
    await expect(connector.run(runContext([
      account(1, { institution: 'Different Institution' }),
    ]))).rejects.toThrow('No active Fidelity accounts are available');
    expect(invoked).toBe(false);
  });
});
