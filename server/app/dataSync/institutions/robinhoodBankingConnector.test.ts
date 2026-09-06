import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SyncAccountCoverage, SyncConnectorRunContext } from '../connector.ts';
import {
  matchesRobinhoodBankingAccount,
  planRobinhoodMobileArtifacts,
  robinhoodAccountKind,
} from './robinhoodBankingConnector.ts';
import {
  discoverRobinhoodMobileExports,
  type RobinhoodMobileArtifact,
} from './robinhoodMobileExports.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function account(overrides: Partial<SyncAccountCoverage> = {}): SyncAccountCoverage {
  return {
    id: 1,
    name: 'Robinhood Joint Checking 4429',
    institution: 'Robinhood',
    type: 'checking',
    last4: '4429',
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

function runContext(accounts: SyncAccountCoverage[]): SyncConnectorRunContext {
  return {
    today: '2026-09-06',
    accounts,
    goal: { kind: 'current', overlapDays: 7 },
    outputDir: join(tmpdir(), 'easymoney-robinhood-test-output'),
    report: () => {},
  };
}

function artifact(overrides: Partial<RobinhoodMobileArtifact>): RobinhoodMobileArtifact {
  return {
    fileName: 'export.csv',
    sourcePath: join(tmpdir(), 'export.csv'),
    kind: 'banking-activity',
    coveredFrom: '2026-06-01',
    coveredTo: '2026-09-05',
    accountLast4: null,
    transactionCount: 1,
    balanceCount: 0,
    modifiedAtMs: 1,
    ...overrides,
  };
}

describe('Robinhood mobile export connector', () => {
  test('targets banking and Gold Card accounts but excludes brokerage accounts', () => {
    const banking = account();
    const credit = account({ id: 2, name: 'Robinhood Gold Card 8904', type: 'credit', last4: '8904' });
    const brokerage = account({ id: 3, name: 'Robinhood Individual', type: 'investment', last4: '1234' });

    expect(robinhoodAccountKind(banking)).toBe('banking');
    expect(robinhoodAccountKind(credit)).toBe('credit');
    expect(matchesRobinhoodBankingAccount(brokerage)).toBe(false);
  });

  test('selects the newest activity export and every missing statement balance', () => {
    const selected = planRobinhoodMobileArtifacts([
      artifact({ fileName: 'old.csv', coveredTo: '2026-09-03', modifiedAtMs: 1 }),
      artifact({ fileName: 'new.csv', coveredTo: '2026-09-05', modifiedAtMs: 2 }),
      artifact({ fileName: 'july.pdf', kind: 'banking-statement', coveredFrom: '2026-07-01', coveredTo: '2026-07-31', accountLast4: '4429', balanceCount: 1 }),
      artifact({ fileName: 'august.pdf', kind: 'banking-statement', coveredFrom: '2026-08-01', coveredTo: '2026-08-31', accountLast4: '4429', balanceCount: 1 }),
    ], runContext([account()]));

    expect(selected.map(item => item.artifact.fileName)).toEqual(['july.pdf', 'august.pdf', 'new.csv']);
  });

  test('recognizes both UUID CSV formats and excludes non-posted credit rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'easymoney-robinhood-exports-'));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, '11111111-1111-4111-8111-111111111111.csv'), [
      'Date,Description,Amount',
      '2026-09-03,Deposit,100.00',
    ].join('\n'));
    await writeFile(join(directory, '22222222-2222-4222-8222-222222222222.csv'), [
      'Date,Time,Cardholder,Amount,Points,Balance,Status,Type,Merchant,Description',
      '2026-09-04,12:00:00,Example Person,20.00,0,0,Posted,Purchase,Posted Shop,POSTED SHOP CA',
      '2026-09-05,12:00:00,Example Person,30.00,0,0,Pending,Purchase,Pending Shop,PENDING SHOP CA',
    ].join('\n'));
    await writeFile(join(directory, 'not-robinhood.csv'), 'Date,Description,Amount\n2026-09-01,Other,1.00');

    const discovered = await discoverRobinhoodMobileExports(directory);

    expect(discovered.map(item => ({ kind: item.kind, transactionCount: item.transactionCount }))).toEqual([
      { kind: 'banking-activity', transactionCount: 1 },
      { kind: 'credit-activity', transactionCount: 1 },
    ]);
  });
});
