import { expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
process.env.EASYMONEY_DB_PATH ||= path.join(os.tmpdir(), `easymoney-ledger-reads-${process.pid}.sqlite`);
const { getDb, initDatabase, insertRow } = await import('../database');
const { listTransactions, getTransactionCategorizationCoverage, categorizeTransactions } = await import('./transactions');
const { getNetWorthReport } = await import('./netWorth');
const { getInvestmentNetWorthReport, getSavingsRateReport } = await import('./investmentReports');
const { getAnalyticsReport } = await import('./analytics');

test('net worth income source report reads current annotations without altering balances or choices', () => {
  initDatabase();
  const db = getDb();
  const accountId = Number(insertRow('accounts', { name: `Income report ${crypto.randomUUID()}`, type: 'checking' }));
  const incomeCategoryId = insertRow('categories', { name: `Gifts received ${crypto.randomUUID()}`, type: 'income' });
  const transferCategoryId = insertRow('categories', { name: `Transfers ${crypto.randomUUID()}`, type: 'transfer' });
  const ledgerTransactionId = crypto.randomUUID();
  insertRow('ledgerTransactions', { accountId, ledgerTransactionId, date: '2026-09-01', amountCents: 100000, description: 'Online transfer from relative', transactionKind: 'internal_transfer' });
  insertRow('transactionAnnotations', { ledgerTransactionId, categoryId: incomeCategoryId });
  insertRow('ledgerBalances', { accountId, month: '2026-09', balanceCents: 250000 });
  const changesBefore = db.prepare('SELECT total_changes() AS n').get()?.n;
  const before = getInvestmentNetWorthReport();
  expect(before.income_sources.filter(row => row.account_id === accountId)).toEqual([
    expect.objectContaining({ account_id: accountId, amount_cents: 100000, month: '2026-09' }),
  ]);
  expect(db.prepare('SELECT total_changes() AS n').get()?.n).toBe(changesBefore);
  db.prepare('UPDATE transactionAnnotations SET categoryId = ? WHERE ledgerTransactionId = ?').run(transferCategoryId, ledgerTransactionId);
  const after = getInvestmentNetWorthReport();
  expect(after.income_sources.filter(row => row.account_id === accountId)).toEqual([]);
  expect(after.rows.filter(row => row.account_id === accountId)).toEqual(before.rows.filter(row => row.account_id === accountId));
  db.prepare('DELETE FROM transactionAnnotations WHERE ledgerTransactionId = ?').run(ledgerTransactionId);
  db.prepare('DELETE FROM ledgerTransactions WHERE accountId = ?').run(accountId);
  db.prepare('DELETE FROM ledgerBalances WHERE accountId = ?').run(accountId);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
  db.prepare('DELETE FROM categories WHERE id IN (?, ?)').run(incomeCategoryId, transferCategoryId);
});

test('statement contribution evidence replaces overlapping activity totals without adding transactions', () => {
  initDatabase();
  const accountId = insertRow('accounts', {name:`Retirement ${crypto.randomUUID()}`,type:'investment'});
  const fileId = insertRow('sourceFiles', {fileName:'synthetic.html',contentHash:crypto.randomUUID(),status:'committed'});
  const sourceAccountId = insertRow('sourceAccounts', {sourceFileId:fileId,sourceAccountKey:'retirement',accountId});
  const rawJson=JSON.stringify({statementCashFlow:{from:'2026-02-01',to:'2026-02-28',netContributionsCents:20000}});
  for(let i=0;i<2;i++) insertRow('sourceBalances',{sourceFileId:fileId,sourceAccountId,date:'2026-02-28',balanceCents:100000,rawJson});
  insertRow('ledgerBalances',{accountId,month:'2026-01',balanceCents:0});
  insertRow('ledgerBalances',{accountId,month:'2026-02',balanceCents:100000});
  insertRow('ledgerTransactions',{accountId,ledgerTransactionId:crypto.randomUUID(),date:'2026-02-12',amountCents:10000,description:'Employee contribution'});
  const rows=getInvestmentNetWorthReport().rows.filter(row=>row.account_id===accountId);
  expect(rows.reduce((s,r)=>s+r.contributions_cents,0)).toBe(20000);
  expect(rows.reduce((s,r)=>s+(r.gains_cents??0),0)).toBe(80000);
  expect(getDb().prepare('SELECT COUNT(*) AS n FROM ledgerTransactions WHERE accountId=?').get(accountId)?.n).toBe(1);
  getDb().prepare('DELETE FROM ledgerTransactions WHERE accountId=?').run(accountId);
  getDb().prepare('DELETE FROM sourceFiles WHERE id=?').run(fileId);
  getDb().prepare('DELETE FROM accounts WHERE id=?').run(accountId);
});

test('all card spellings report debt and no investment gains', () => {
  initDatabase();
  for (const type of ['credit', 'credit-card', 'credit_card']) {
    const accountId = insertRow('accounts', { name: `Card ${crypto.randomUUID()}`, type });
    insertRow('ledgerBalances', { accountId, month: '2026-07', balanceCents: -3100 });
    insertRow('ledgerBalances', { accountId, month: '2026-08', balanceCents: 0 });
    const report = getInvestmentNetWorthReport();
    expect(report.accounts.find(account => account.id === accountId)?.type).toBe('credit');
    const rows = report.rows.filter(row => row.account_id === accountId);
    expect(rows.map(row => row.contributions_cents)).toEqual([-3100, 3100]);
    expect(rows.every(row => row.gains_cents === 0)).toBe(true);
    expect(rows.reduce((sum, row) => sum + row.contributions_cents, 0)).toBe(0);
  }
});

test('reads never overwrite the ledger or resurrect legacy rows; annotations use only ledger identities', () => {
  initDatabase();
  const db = getDb();
  const accountId = insertRow('accounts', { name: `Read-only ${crypto.randomUUID()}`, type: 'checking' });
  const categoryId = insertRow('categories', { name: `Read category ${crypto.randomUUID()}`, type: 'expense' });
  const ledgerTransactionId = `txn_${crypto.randomUUID()}`;
  const legacyId = insertRow('transactions', { accountId, date: '2026-09-01', amount: -9999, description: 'Obsolete', ledgerTransactionId });
  insertRow('ledgerTransactions', { accountId, ledgerTransactionId, legacyTransactionId: legacyId, date: '2026-09-01', amountCents: -1234, description: 'Current ledger' });
  const orphan = insertRow('transactions', { accountId, date: '2026-09-02', amount: -1, description: 'Legacy only' });
  insertRow('ledgerBalances', { accountId, month: '2026-09', balanceCents: 50000 });
  insertRow('balanceSnapshots', { accountId, month: '2026-09', balance: 9999 });
  const changes = () => db.prepare('SELECT total_changes() AS value').get()?.value;
  const before = changes();
  expect(listTransactions({ accountId }).transactions).toHaveLength(1);
  expect(listTransactions({ accountId }).transactions[0]?.amount).toBe(-12.34);
  getTransactionCategorizationCoverage(); getNetWorthReport(); getInvestmentNetWorthReport(); getSavingsRateReport(); getAnalyticsReport({ accountId });
  expect(changes()).toBe(before);
  expect(() => categorizeTransactions({ transactionIds: [orphan], categoryId })).toThrow('active ledger');
  categorizeTransactions({ transactionIds: [String(legacyId)], categoryId });
  expect(db.prepare('SELECT categoryId FROM transactionAnnotations WHERE ledgerTransactionId = ?').get(ledgerTransactionId)?.categoryId).toBe(categoryId);
  expect(db.prepare('SELECT categoryId FROM transactions WHERE id = ?').get(legacyId)?.categoryId).toBeNull();
  initDatabase();
  expect(listTransactions({ accountId }).transactions).toHaveLength(1);
  expect(listTransactions({ accountId }).transactions[0]?.amount).toBe(-12.34);
  expect(db.prepare('SELECT balanceCents FROM ledgerBalances WHERE accountId = ?').get(accountId)?.balanceCents).toBe(50000);
});
