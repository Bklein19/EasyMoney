import { describe, expect, test } from 'bun:test';

import type { SyncAccountCoverage, SyncConnectorRunContext } from '../connector.ts';
import type { SyncEvent } from '../protocol.ts';
import type {
  TiaaDownloadedArtifact,
  TiaaProgressEvent,
  TiaaRemoteAccountIdentity,
  TiaaSyncConfig,
  TiaaSyncResult,
} from './tiaa.ts';
import { tiaaActivityRemoteAccount } from './tiaa.ts';
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
  fileName: string,
  remoteAccounts: TiaaRemoteAccountIdentity[],
  artifactType: TiaaDownloadedArtifact['artifactType'] = 'activity',
): TiaaDownloadedArtifact {
  return {
    fileName,
    path: `/tmp/${fileName}`,
    kind: artifactType === 'activity' ? 'csv' : 'pdf',
    artifactType,
    parserId: artifactType === 'activity' ? 'tiaa-activity-csv' : 'tiaa-statement-pdf',
    account: { routingKey: 'aaaaaaaaaaaa', remoteAccounts },
    coveredFrom: '2026-01-01',
    coveredThrough: '2026-06-30',
    size: 1_000,
    transactionCount: 2,
    balanceCount: artifactType === 'statement' ? 1 : 0,
    source: 'downloaded',
  };
}

function result(artifacts: TiaaDownloadedArtifact[]): TiaaSyncResult {
  return {
    artifacts,
    accountsDiscovered: new Set(artifacts.flatMap(item =>
      item.account.remoteAccounts.map(remote => remote.claimKey)
    )).size,
    accountSelectionsDiscovered: 1,
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
  test('routes every consolidated parser claim independently without forcing a destination', () => {
    const claims = [tiaaActivityRemoteAccount('RET123'), tiaaActivityRemoteAccount('RET456')];
    expect(routeTiaaArtifacts([artifact('activity.csv', claims)])).toEqual([{
      fileName: 'activity.csv',
      accountRoutes: [
        { remoteAccountId: 'TIAA||Retirement Annuity RET123' },
        { remoteAccountId: 'TIAA||Retirement Annuity RET456' },
      ],
    }]);
  });

  test('fails closed for missing or ambiguous parser claim keys', () => {
    expect(() => routeTiaaArtifacts([artifact('empty.csv', [])]))
      .toThrow('no parser-backed account claims');
    const claim = tiaaActivityRemoteAccount('RET123');
    expect(() => routeTiaaArtifacts([artifact('duplicate.csv', [claim, claim])]))
      .toThrow('ambiguous parser-backed account claims');
  });
});

describe('TIAA connector execution', () => {
  test('combines activity and balance windows, translates PII-free progress, and preserves claim routes', async () => {
    const calls: TiaaSyncConfig[] = [];
    const events: Array<Omit<SyncEvent, 'runId' | 'timestamp'>> = [];
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
        data: { accountSelections: 1, sourceAccounts: 2 },
      });
      return result([artifact('activity.csv', [
        tiaaActivityRemoteAccount('RET123'),
        tiaaActivityRemoteAccount('RET456'),
      ])]);
    });
    const accounts = [account(10, {
      latestFactDate: '2026-08-10',
      latestBalanceDate: '2026-06-30',
    })];

    await expect(connector.run(runContext(accounts, event => events.push(event)))).resolves.toEqual([{
      fileName: 'activity.csv',
      accountRoutes: [
        { remoteAccountId: 'TIAA||Retirement Annuity RET123' },
        { remoteAccountId: 'TIAA||Retirement Annuity RET456' },
      ],
    }]);
    expect(calls).toEqual([{
      outputDir: '/tmp/tiaa-connector-test',
      from: '2026-06-23',
      through: '2026-08-24',
      session: 'tiaa-catchup',
    }]);
    expect(events.at(-1)).toEqual({
      type: 'phase',
      message: 'Validated 1 TIAA artifact',
      data: {
        accountsDiscovered: 2,
        accountSelectionsDiscovered: 1,
        activityPeriodsDiscovered: 2,
        statementsDiscovered: 0,
        emptyActivityExports: 1,
        timingsMs: { authentication: 10, validation: 30 },
      },
    });
    expect(JSON.stringify(events)).not.toContain('RET123');
    expect(JSON.stringify(events)).not.toContain('RET456');
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
