import { describe, expect, test } from 'bun:test';

import type { SyncAccountCoverage, SyncConnectorRunContext } from '../connector.ts';
import type { SyncEvent } from '../protocol.ts';
import type {
  TiaaDownloadedArtifact,
  TiaaProgressEvent,
  TiaaSyncConfig,
  TiaaSyncResult,
} from './tiaa.ts';
import {
  createTiaaConnector,
  matchesTiaaAccount,
  routeTiaaArtifacts,
  tiaaConnector,
} from './tiaaConnector.ts';

function account(id: number, overrides: Partial<SyncAccountCoverage> = {}): SyncAccountCoverage {
  return {
    id,
    name: `Retirement account ${id}`,
    institution: 'TIAA',
    type: 'investment',
    latestFactDate: '2026-08-10',
    earliestFactDate: '2024-01-01',
    latestBalanceDate: '2026-07-31',
    earliestBalanceDate: '2024-03-31',
    balanceDates: ['2026-07-31'],
    sourceAccountName: 'Retirement Annuity',
    sourceAccountNames: ['Retirement Annuity'],
    accountAliases: [],
    accountHolder: null,
    artifactFileNames: [],
    ...overrides,
  };
}

function artifact(
  routingKey: string,
  remoteAccountId: string | null,
  fileName: string,
  artifactType: TiaaDownloadedArtifact['artifactType'] = 'activity',
): TiaaDownloadedArtifact {
  return {
    fileName,
    path: `/tmp/${fileName}`,
    kind: artifactType === 'activity' ? 'csv' : 'pdf',
    artifactType,
    parserId: artifactType === 'activity' ? 'tiaa-activity-csv' : 'tiaa-statement-pdf',
    account: { routingKey, remoteAccountId },
    coveredFrom: '2026-01-01',
    coveredThrough: '2026-06-30',
    size: 1_000,
    source: 'downloaded',
  };
}

function result(artifacts: TiaaDownloadedArtifact[]): TiaaSyncResult {
  return {
    artifacts,
    accountsDiscovered: new Set(artifacts.map(item => item.account.routingKey)).size,
    activityPeriodsDiscovered: 2,
    statementsDiscovered: artifacts.filter(item => item.artifactType === 'statement').length,
    emptyActivityExports: 1,
    timingsMs: { authentication: 10, validation: 30 },
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
    outputDir: '/tmp/tiaa-connector-test',
    report,
  };
}

describe('TIAA connector targeting', () => {
  test('exposes one login action when any active TIAA account exists', () => {
    const accounts = [
      account(1),
      account(2),
      account(3, { institution: 'Different Institution' }),
    ];
    expect(accounts.map(matchesTiaaAccount)).toEqual([true, true, false]);
    expect(tiaaConnector.listTargets({ today: '2026-08-24', accounts })).toEqual([{ label: 'TIAA' }]);
    expect(tiaaConnector.listTargets({ today: '2026-08-24', accounts: [accounts[2]!] })).toEqual([]);
  });
});

describe('TIAA artifact routing', () => {
  test('routes multiple remote accounts using stable artifact keys and explicit local identity', () => {
    const firstKey = 'aaaaaaaaaaaa';
    const secondKey = 'bbbbbbbbbbbb';
    const accounts = [
      account(10, {
        artifactFileNames: [
          `tiaa-retirement-annuity-2025-account-${firstKey}-2025-01-01-to-2025-12-31.csv`,
        ],
      }),
      account(20, { accountAliases: ['TIAA-CREF account ending 2222'] }),
    ];
    const artifacts = [
      artifact(firstKey, 'RET1111', 'first.csv'),
      artifact(firstKey, 'RET1111', 'first-statement.pdf', 'statement'),
      artifact(secondKey, 'RETIREMENT-2222', 'second.csv'),
    ];

    expect(routeTiaaArtifacts(artifacts, accounts)).toEqual([
      { fileName: 'first.csv', accountId: 10 },
      { fileName: 'first-statement.pdf', accountId: 10 },
      { fileName: 'second.csv', accountId: 20 },
    ]);
  });

  test('uses old account-identifying filenames without logging or exposing the identity', () => {
    expect(routeTiaaArtifacts([
      artifact('cccccccccccc', 'Tiaa-Cref12345678', 'activity.csv'),
    ], [
      account(30, { artifactFileNames: ['tiaa-retirement-annuity-Tiaa-Cref12345678-2025.csv'] }),
      account(40, { accountAliases: ['TIAA-CREF account ending 9999'] }),
    ])).toEqual([{ fileName: 'activity.csv', accountId: 30 }]);
  });

  test('permits only the unambiguous single-account fallback', () => {
    const downloaded = [artifact('aaaaaaaaaaaa', null, 'statement.pdf', 'statement')];
    expect(routeTiaaArtifacts(downloaded, [account(10)]))
      .toEqual([{ fileName: 'statement.pdf', accountId: 10 }]);
    expect(() => routeTiaaArtifacts(downloaded, [account(10), account(20)]))
      .toThrow('no unambiguous local account route');
  });

  test('rejects conflicting identities and many-to-one account collapse', () => {
    expect(() => routeTiaaArtifacts([
      artifact('aaaaaaaaaaaa', 'RET1111', 'first.csv'),
      artifact('aaaaaaaaaaaa', 'RET2222', 'second.csv'),
    ], [account(10)])).toThrow('artifacts disagree');

    expect(() => routeTiaaArtifacts([
      artifact('aaaaaaaaaaaa', 'RET1111', 'first.csv'),
      artifact('bbbbbbbbbbbb', 'RET1111', 'second.csv'),
    ], [account(10, { accountAliases: ['TIAA RET1111'] })]))
      .toThrow('Multiple TIAA remote accounts map to the same local account');
  });
});

describe('TIAA connector execution', () => {
  test('combines activity and balance windows, translates PII-free progress, and routes artifacts', async () => {
    const calls: TiaaSyncConfig[] = [];
    const events: Array<Omit<SyncEvent, 'runId' | 'timestamp'>> = [];
    const routingKey = 'aaaaaaaaaaaa';
    const connector = createTiaaConnector(async (
      config: TiaaSyncConfig,
      progress: (event: TiaaProgressEvent) => void = () => {},
    ) => {
      calls.push(config);
      progress({
        phase: 'account-discovery',
        state: 'completed',
        message: 'TIAA account discovery is complete',
        elapsedMs: 125,
        phaseElapsedMs: 25,
        data: { accounts: 1 },
      });
      return result([artifact(routingKey, 'RET1111', 'activity.csv')]);
    });
    const accounts = [account(10, {
      latestFactDate: '2026-08-10',
      latestBalanceDate: '2026-06-30',
      artifactFileNames: [
        `tiaa-retirement-annuity-2025-account-${routingKey}-2025-01-01-to-2025-12-31.csv`,
      ],
    })];

    await expect(connector.run(runContext(accounts, event => events.push(event)))).resolves.toEqual([
      { fileName: 'activity.csv', accountId: 10 },
    ]);
    expect(calls).toEqual([{
      outputDir: '/tmp/tiaa-connector-test',
      from: '2026-06-23',
      through: '2026-08-24',
      session: 'tiaa-catchup',
    }]);
    expect(events).toEqual([
      {
        type: 'phase',
        message: 'Opening TIAA',
        data: {
          goal: 'current',
          accountCount: 1,
          from: '2026-06-23',
          through: '2026-08-24',
        },
      },
      {
        type: 'phase',
        message: 'TIAA account discovery is complete',
        data: {
          phase: 'account-discovery',
          state: 'completed',
          elapsedMs: 125,
          phaseElapsedMs: 25,
          accounts: 1,
        },
      },
      {
        type: 'phase',
        message: 'Validated 1 TIAA artifact',
        data: {
          accountsDiscovered: 1,
          activityPeriodsDiscovered: 2,
          statementsDiscovered: 0,
          emptyActivityExports: 1,
          timingsMs: { authentication: 10, validation: 30 },
        },
      },
    ]);
  });

  test('fails before opening a browser when no local TIAA account exists', async () => {
    let invoked = false;
    const connector = createTiaaConnector(async () => {
      invoked = true;
      return result([]);
    });
    await expect(connector.run(runContext([account(1, { institution: 'Different Institution' })])))
      .rejects.toThrow('No active TIAA accounts are available');
    expect(invoked).toBe(false);
  });
});
