import { beforeEach, expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
process.env.EASYMONEY_DB_PATH ||= path.join(os.tmpdir(), `easymoney-completeness-${process.pid}.sqlite`);
const { getDb, initDatabase, insertRow } = await import('../database');
const { getDataCompleteness, uncoveredIntervals } = await import('./dataCompleteness');
let accountId: number;
beforeEach(() => {
  initDatabase();
  accountId = insertRow('accounts', { name: `Coverage ${crypto.randomUUID()}`, type: 'checking' });
});
function source(start: string, end: string, basis: string, status = 'committed') {
  const file = insertRow('sourceFiles', { fileName: 'coverage.csv', contentHash: crypto.randomUUID(), coveredFrom: start, coveredTo: end, coverageBasis: basis, status });
  const account = insertRow('sourceAccounts', { sourceFileId: file, accountId, sourceAccountKey: 'checking' });
  return { file, account };
}
test('overlapping and adjacent intervals preserve interior gaps', () => {
  expect(uncoveredIntervals([{ start: '2026-01-01', end: '2026-01-10' }, { start: '2026-01-08', end: '2026-01-15' },
    { start: '2026-01-16', end: '2026-01-20' }, { start: '2026-01-25', end: '2026-01-31' }], '2026-01-01', '2026-01-31'))
    .toEqual([{ start: '2026-01-21', end: '2026-01-24' }]);
});
test('recent activity does not hide stale balances or inferred coverage', () => {
  const { file, account } = source('2026-01-01', '2026-09-06', 'observed');
  insertRow('sourceTransactions', { sourceFileId: file, sourceAccountId: account, stableSourceId: crypto.randomUUID(), date: '2026-09-06', amountCents: -100 });
  insertRow('sourceBalances', { sourceFileId: file, sourceAccountId: account, date: '2026-01-01', balanceCents: 10000 });
  const report = getDataCompleteness({ accountIds: [accountId], startDate: '2026-01-01', today: '2026-09-06' });
  expect(report.accounts[0]).toMatchObject({ balanceStatus: 'stale', transactionCoverage: 'unverified', latestTransactionDate: '2026-09-06' });
});
test('inactive and consolidated file ranges cannot claim single-account coverage', () => {
  source('2026-01-01', '2026-01-31', 'declared', 'unimported');
  const { file } = source('2026-01-01', '2026-01-31', 'declared');
  insertRow('sourceAccounts', { sourceFileId: file, accountId, sourceAccountKey: 'another-account' });
  const input = { accountIds: [accountId], startDate: '2026-01-01', endDate: '2026-01-31', today: '2026-09-06' };
  expect(getDataCompleteness(input).accounts[0]?.transactionCoverage).toBe('unverified');
  source('2026-01-01', '2026-01-31', 'declared');
  expect(getDataCompleteness(input).accounts[0]?.transactionCoverage).toBe('declared');
  expect(getDataCompleteness({ ...input, accountIds: [] }).accounts).toEqual([]);
});
test('historical reports exclude later transactions and future periods never claim verified coverage', () => {
  const { file, account } = source('2026-01-01', '2026-09-30', 'observed');
  for (const date of ['2026-01-10', '2026-09-05']) {
    insertRow('sourceTransactions', { sourceFileId: file, sourceAccountId: account, stableSourceId: crypto.randomUUID(), date, amountCents: -100 });
  }
  const past = getDataCompleteness({ accountIds: [accountId], startDate: '2026-01-01', endDate: '2026-01-31', today: '2026-09-07' });
  expect(past.accounts[0]?.latestTransactionDate).toBe('2026-01-10');
  const future = getDataCompleteness({ accountIds: [accountId], startDate: '2026-10-01', endDate: '2026-10-31', today: '2026-09-07' });
  expect(future.accounts[0]?.transactionCoverage).toBe('future');
});
