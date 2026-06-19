import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppRouter } from './router.ts';

process.env.EASYMONEY_DB_PATH = path.join(os.tmpdir(), `easymoney-app-api-${process.pid}.sqlite`);

const { createServer } = await import('../index.ts');
const { getDb, initDatabase, insertRow } = await import('../database.js');
const { buildLedgerFromSourceFacts, ledgerFingerprint, materializeLedger } = await import('./ledgerRebuild.ts');
const server = createServer({ port: 0 });
const TEST_URL = `http://localhost:${server.port}`;
const trpcClient = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${TEST_URL}/api/trpc` })],
});

afterAll(() => {
  server.stop();
});

function resetAppTables() {
  const db = getDb();
  initDatabase();
  db.transaction(() => {
    for (const table of [
      'sourceBalances',
      'sourceTransactions',
      'sourceAccounts',
      'sourceFiles',
      'importRows',
      'importFiles',
      'ledgerTransactions',
      'ledgerBalances',
      'transactionAnnotations',
      'transactions',
      'balanceSnapshots',
      'accountAliases',
      'budgets',
      'categorizationRules',
      'importProfiles',
      'categories',
      'accounts',
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
      db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(table);
    }
  })();
}

async function getJson(path: string) {
  const response = await fetch(`${TEST_URL}${path}`);
  expect(response.status).toBe(200);
  return response.json();
}

async function postJson(path: string, payload: unknown, expectedStatus = 200) {
  const response = await fetch(`${TEST_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(expectedStatus);
  return response.json();
}

async function putJson(path: string, payload: unknown, expectedStatus = 200) {
  const response = await fetch(`${TEST_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(expectedStatus);
  return response.json();
}

async function postImportPreview(fileName: string, text: string, profile: unknown = null) {
  const form = new FormData();
  form.append('file', new File([text], fileName, { type: 'text/csv' }));
  if (profile) form.append('profileJson', JSON.stringify(profile));

  const response = await fetch(`${TEST_URL}/api/app/imports/preview`, {
    method: 'POST',
    body: form,
  });
  expect(response.status).toBe(200);
  return response.json();
}

function csvFromRows(rows: string[]) {
  return [
    'Transaction Date,Post Date,Description,Category,Type,Amount',
    ...rows,
  ].join('\n');
}

function snapshotAccountTransactions(accountId: number) {
  return getDb().prepare(`
    SELECT date, amount, description, merchant, originalDescription, originalCategory, type, transactionKind, status, fingerprint, importBatchId, ledgerTransactionId, occurrenceIndex
    FROM transactions
    WHERE accountId = ?
    ORDER BY ledgerTransactionId ASC
  `).all(accountId);
}

function snapshotBalanceSnapshots(accountId: number) {
  return getDb().prepare(`
    SELECT accountId, month, balance, capturedAt
    FROM balanceSnapshots
    WHERE accountId = ?
    ORDER BY month ASC
  `).all(accountId);
}

function resetMaterializedImports(accountId: number) {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM transactions WHERE accountId = ?').run(accountId);
    db.prepare('DELETE FROM ledgerTransactions WHERE accountId = ?').run(accountId);
    db.prepare('UPDATE accounts SET currentBalance = 0 WHERE id = ?').run(accountId);
    db.prepare('UPDATE importRows SET fingerprint = NULL, transactionId = NULL').run();
    db.prepare("UPDATE importFiles SET status = 'previewed', importBatchId = NULL, committedAt = NULL").run();
  })();
}

beforeEach(() => {
  resetAppTables();
});

test('app accounts endpoint returns domain-shaped accounts', async () => {
  insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
    currentBalance: 1234.56,
    currency: 'USD',
    updatedAt: '2026-06-14T12:00:00.000Z',
  });

  const body = await getJson('/api/app/accounts');

  expect(body).toEqual({
    accounts: [
      {
        id: 1,
        name: 'Checking',
        institution: 'Local Bank',
        type: 'checking',
        balance: 1234.56,
        currency: 'USD',
        updatedAt: '2026-06-14T12:00:00.000Z',
      },
    ],
  });
});

test('app categories endpoint returns domain-shaped categories', async () => {
  insertRow('categories', {
    name: 'Groceries',
    parentId: null,
    type: 'expense',
    color: '#22c55e',
    icon: 'shopping-cart',
  });

  const body = await getJson('/api/app/categories');

  expect(body).toEqual({
    categories: [
      {
        id: 1,
        name: 'Groceries',
        parentId: null,
        type: 'expense',
        color: '#22c55e',
        icon: 'shopping-cart',
      },
    ],
  });
});

test('app transactions endpoint joins account and category details', async () => {
  const accountId = insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
    currentBalance: 0,
  });
  const categoryId = insertRow('categories', {
    name: 'Groceries',
    type: 'expense',
    color: '#22c55e',
    icon: 'shopping-cart',
  });
  const transactionId = insertRow('transactions', {
    accountId,
    date: '2026-06-14',
    amount: -42.5,
    description: 'Neighborhood Market',
    merchant: 'Market',
    originalDescription: 'POS MARKET 123',
    originalCategory: 'Shopping',
    type: 'expense',
    transactionKind: 'debit',
    status: 'cleared',
    importBatchId: 'batch-1',
    fingerprint: 'fingerprint-1',
    createdAt: '2026-06-14T12:00:00.000Z',
  });
  await putJson(`/api/transactions/${transactionId}`, {
    categoryId,
    notes: 'weekly shop',
  });

  const body = await getJson('/api/app/transactions');

  expect(body.transactions).toHaveLength(1);
  expect(body.transactions[0].ledgerTransactionId.startsWith('txn_')).toBe(true);
  expect(body.transactions[0]).toMatchObject({
    id: 1,
    account: {
      id: accountId,
      name: 'Checking',
      institution: 'Local Bank',
      type: 'checking',
    },
    category: {
      id: categoryId,
      name: 'Groceries',
      type: 'expense',
      color: '#22c55e',
      icon: 'shopping-cart',
    },
    date: '2026-06-14',
    amount: -42.5,
    description: 'Neighborhood Market',
    merchant: 'Market',
    originalDescription: 'POS MARKET 123',
    originalCategory: 'Shopping',
    type: 'expense',
    transactionKind: 'debit',
    status: 'cleared',
    notes: 'weekly shop',
    importBatchId: 'batch-1',
    fingerprint: 'fingerprint-1',
    createdAt: '2026-06-14T12:00:00.000Z',
  });
});

test('app transactions endpoint supports domain query filters', async () => {
  const accountId = insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
  });
  const foodId = insertRow('categories', { name: 'Food', type: 'expense' });
  const incomeId = insertRow('categories', { name: 'Income', type: 'income' });

  const cafeId = insertRow('transactions', {
    accountId,
    date: '2026-06-14',
    amount: -20,
    description: 'Cafe',
    merchant: 'Blue Cafe',
    type: 'expense',
  });
  await putJson(`/api/transactions/${cafeId}`, { categoryId: foodId });

  const payrollId = insertRow('transactions', {
    accountId,
    date: '2026-06-15',
    amount: 100,
    description: 'Payroll',
    merchant: 'Employer',
    type: 'income',
  });
  await putJson(`/api/transactions/${payrollId}`, { categoryId: incomeId });

  const body = await getJson('/api/app/transactions?type=expense&search=cafe&startDate=2026-06-01&endDate=2026-06-30');

  expect(body.transactions.map((transaction: { description: string }) => transaction.description)).toEqual(['Cafe']);
});

test('app transactions search includes notes', async () => {
  const accountId = insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
  });

  const transactionId = insertRow('transactions', {
    accountId,
    date: '2026-06-16',
    amount: -12,
    description: 'Card purchase',
    merchant: 'Store',
    type: 'expense',
  });
  await putJson(`/api/transactions/${transactionId}`, { notes: 'reimbursable team lunch' });

  const body = await getJson('/api/app/transactions?search=reimbursable');

  expect(body.transactions.map((transaction: { notes: string }) => transaction.notes)).toEqual(['reimbursable team lunch']);
});

test('app transactions ignore legacy category and notes columns without annotations', async () => {
  const accountId = insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
  });
  const categoryId = insertRow('categories', { name: 'Legacy Category', type: 'expense' });
  insertRow('transactions', {
    accountId,
    categoryId,
    date: '2026-06-16',
    amount: -12,
    description: 'Legacy row',
    merchant: 'Store',
    notes: 'legacy-only-note',
    type: 'expense',
  });

  const body = await getJson('/api/app/transactions');
  expect(body.transactions[0].category).toBeNull();
  expect(body.transactions[0].notes).toBeNull();

  const categoryFiltered = await getJson(`/api/app/transactions?categoryId=${categoryId}`);
  expect(categoryFiltered.transactions).toEqual([]);

  const searchFiltered = await getJson('/api/app/transactions?search=legacy-only-note');
  expect(searchFiltered.transactions).toEqual([]);
});

test('app transaction updates store category and notes only as annotations', async () => {
  const accountId = insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
  });
  const categoryId = insertRow('categories', { name: 'Groceries', type: 'expense' });
  const transactionId = insertRow('transactions', {
    accountId,
    date: '2026-06-16',
    amount: -12,
    description: 'Card purchase',
    merchant: 'Store',
    type: 'expense',
  });

  await putJson(`/api/transactions/${transactionId}`, {
    categoryId,
    notes: 'annotation-only',
  });

  const transaction = getDb().prepare('SELECT categoryId, notes FROM transactions WHERE id = ?').get(transactionId) as {
    categoryId: number | null;
    notes: string | null;
  };
  expect(transaction.categoryId).toBeNull();
  expect(transaction.notes).toBeNull();

  const body = await getJson('/api/app/transactions?search=annotation-only');
  expect(body.transactions[0].category.id).toBe(categoryId);
  expect(body.transactions[0].notes).toBe('annotation-only');
});

test('transaction annotations survive transaction row rebuild', async () => {
  const accountId = insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
  });
  const categoryId = insertRow('categories', { name: 'Groceries', type: 'expense' });
  const transactionId = insertRow('transactions', {
    accountId,
    date: '2026-06-16',
    amount: -12,
    description: 'Card purchase',
    merchant: 'Store',
    type: 'expense',
  });

  await putJson(`/api/transactions/${transactionId}`, {
    categoryId,
    notes: 'household groceries',
  });

  const annotation = getDb().prepare('SELECT * FROM transactionAnnotations').get() as {
    ledgerTransactionId: string;
    categoryId: number;
    notes: string;
  };
  expect(annotation.categoryId).toBe(categoryId);
  expect(annotation.notes).toBe('household groceries');

  getDb().prepare('DELETE FROM transactions WHERE id = ?').run(transactionId);
  insertRow('transactions', {
    accountId,
    ledgerTransactionId: annotation.ledgerTransactionId,
    date: '2026-06-16',
    amount: -12,
    description: 'Card purchase',
    merchant: 'Store',
    type: 'expense',
  });

  const body = await getJson('/api/app/transactions');
  expect(body.transactions[0].category.id).toBe(categoryId);
  expect(body.transactions[0].notes).toBe('household groceries');
});

test('app transactions endpoint reads and annotates ledger rows without legacy transaction rows', async () => {
  const accountId = Number(insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
  }));
  const categoryId = Number(insertRow('categories', { name: 'Dining', type: 'expense' }));
  const transactionId = Number(insertRow('transactions', {
    accountId,
    date: '2026-06-16',
    amount: -12.34,
    description: 'Ledger Cafe',
    merchant: 'Cafe',
    originalDescription: 'POS LEDGER CAFE',
    type: 'expense',
    status: 'cleared',
  }));

  await putJson(`/api/transactions/${transactionId}`, {
    categoryId,
    notes: 'before legacy delete',
  });

  const beforeDelete = await getJson('/api/app/transactions?search=Ledger Cafe');
  expect(beforeDelete.transactions).toHaveLength(1);
  const ledgerTransactionId = beforeDelete.transactions[0].ledgerTransactionId;
  expect(ledgerTransactionId.startsWith('txn_')).toBe(true);

  getDb().prepare('DELETE FROM transactions WHERE id = ?').run(transactionId);

  const ledgerOnly = await getJson('/api/app/transactions?search=Ledger Cafe');
  expect(ledgerOnly.transactions).toHaveLength(1);
  expect(ledgerOnly.transactions[0]).toMatchObject({
    ledgerTransactionId,
    account: {
      id: accountId,
      name: 'Checking',
    },
    category: {
      id: categoryId,
      name: 'Dining',
    },
    amount: -12.34,
    notes: 'before legacy delete',
  });
  expect((getDb().prepare('SELECT COUNT(*) AS count FROM transactions').get() as { count: number }).count).toBe(0);

  await putJson(`/api/transactions/${ledgerOnly.transactions[0].id}`, {
    notes: 'ledger-only annotation',
  });
  const updated = await getJson('/api/app/transactions?search=ledger-only annotation');
  expect(updated.transactions).toHaveLength(1);
  expect(updated.transactions[0].ledgerTransactionId).toBe(ledgerTransactionId);
});

test('trpc transactions procedures read and categorize transactions', async () => {
  const accountId = insertRow('accounts', { name: 'Checking', type: 'checking', currentBalance: 0 });
  const categoryId = insertRow('categories', { name: 'Food', type: 'expense' });
  const transactionId = Number(insertRow('transactions', {
    accountId,
    date: '2026-06-02',
    amount: -18.25,
    description: 'TRPC Cafe',
    type: 'expense',
    status: 'cleared',
  }));

  const before = await trpcClient.transactions.list.query({ search: 'TRPC Cafe', limit: 1 });
  expect(before.transactions).toHaveLength(1);
  expect(before.transactions[0].category).toBeNull();

  await trpcClient.transactions.categorize.mutate({
    transactionIds: [transactionId],
    categoryId,
  });

  const after = await trpcClient.transactions.list.query({ search: 'TRPC Cafe', limit: 1 });
  expect(after.transactions).toHaveLength(1);
  expect(after.transactions[0].category?.id).toBe(categoryId);
});

test('trpc net worth report is backend-owned and reads ledger balances', async () => {
  const checkingId = insertRow('accounts', {
    name: 'Checking',
    type: 'checking',
    currentBalance: 1500,
  });
  const creditId = insertRow('accounts', {
    name: 'Card',
    type: 'credit',
    currentBalance: 250,
  });

  insertRow('balanceSnapshots', {
    accountId: checkingId,
    month: '2026-05',
    balance: 1000,
    capturedAt: '2026-05-31T00:00:00.000Z',
  });
  insertRow('balanceSnapshots', {
    accountId: creditId,
    month: '2026-05',
    balance: 200,
    capturedAt: '2026-05-31T00:00:00.000Z',
  });

  const report = await trpcClient.netWorth.report.query();
  expect(report.currentNetWorth).toBe(1250);
  expect(report.history).toEqual([{ month: '2026-05', netWorth: 800 }]);
  expect(report.percentChange).toBeCloseTo(56.25);
});

test('init database backfills ledger read model from legacy app tables', () => {
  const accountId = Number(insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
  }));
  const categoryId = Number(insertRow('categories', { name: 'Dining', type: 'expense' }));
  const transactionId = Number(insertRow('transactions', {
    accountId,
    categoryId,
    date: '2026-06-14',
    amount: -18.42,
    description: 'Lunch',
    merchant: 'Cafe',
    originalDescription: 'POS CAFE',
    originalCategory: 'Food',
    type: 'expense',
    status: 'cleared',
    notes: 'legacy-note',
    fingerprint: 'legacy-fingerprint',
    createdAt: '2026-06-14T12:00:00.000Z',
  }));
  insertRow('balanceSnapshots', {
    accountId,
    month: '2026-06',
    balance: 1234.56,
    capturedAt: '2026-06-30T00:00:00.000Z',
  });

  initDatabase();

  const transaction = getDb().prepare('SELECT ledgerTransactionId FROM transactions WHERE id = ?').get(transactionId) as {
    ledgerTransactionId: string;
  };
  expect(transaction.ledgerTransactionId.startsWith('txn_')).toBe(true);

  const ledgerTransaction = getDb().prepare('SELECT * FROM ledgerTransactions WHERE legacyTransactionId = ?').get(transactionId) as {
    ledgerTransactionId: string;
    accountId: number;
    amountCents: number;
    description: string;
    originalDescription: string;
    fingerprint: string;
  };
  expect(ledgerTransaction).toMatchObject({
    ledgerTransactionId: transaction.ledgerTransactionId,
    accountId,
    amountCents: -1842,
    description: 'Lunch',
    originalDescription: 'POS CAFE',
    fingerprint: 'legacy-fingerprint',
  });

  const annotation = getDb().prepare('SELECT * FROM transactionAnnotations WHERE ledgerTransactionId = ?').get(transaction.ledgerTransactionId) as {
    categoryId: number;
    notes: string;
  };
  expect(annotation).toMatchObject({
    categoryId,
    notes: 'legacy-note',
  });

  const ledgerBalance = getDb().prepare('SELECT * FROM ledgerBalances WHERE accountId = ? AND month = ?').get(accountId, '2026-06') as {
    balanceCents: number;
    capturedAt: string;
  };
  expect(ledgerBalance).toMatchObject({
    balanceCents: 123456,
    capturedAt: '2026-06-30T00:00:00.000Z',
  });
});

test('app imports preview parses a Chase CSV on the backend', async () => {
  const csv = fs.readFileSync(path.resolve(import.meta.dir, '..', '..', 'sample-imports', 'chase-credit-card-demo.csv'), 'utf8');

  const body = await postImportPreview('chase-credit-card-demo.csv', csv);

  expect(body.requiresMapping).toBe(false);
  expect(body.profileUsed).toBe('Chase Credit Card');
  expect(body.importFileId).toBe(1);
  expect(body.headers).toEqual(['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount']);
  expect(body.balances).toEqual([]);
  expect(body.transactions).toHaveLength(10);
  expect(body.transactions[0]).toMatchObject({
    importFileId: 1,
    importRowId: 1,
    sourceRowIndex: 0,
    date: '2026-06-14T00:00:00.000Z',
    description: 'ACME PAYROLL',
    amount: 1250,
    originalCategory: 'Payment',
  });

  const sourceFile = getDb().prepare('SELECT * FROM sourceFiles WHERE importFileId = ?').get(body.importFileId) as {
    parserName: string;
    sourceType: string;
    status: string;
  };
  expect(sourceFile).toMatchObject({
    parserName: 'chase-credit-card-csv',
    sourceType: 'activity-export',
    status: 'previewed',
  });
  const sourceTransactionCount = getDb().prepare('SELECT COUNT(*) AS count FROM sourceTransactions').get() as { count: number };
  expect(sourceTransactionCount.count).toBe(10);
});

test('app imports preview requires explicit mapping for unknown CSVs', async () => {
  const csv = [
    'When,Details,Value',
    '06/14/2026,Coffee Shop,-6.75',
  ].join('\n');

  const unmapped = await postImportPreview('unknown-bank.csv', csv);
  expect(unmapped.requiresMapping).toBe(true);
  expect(unmapped.transactions).toBeUndefined();
  expect(unmapped.mapping).toMatchObject({
    dateColumn: '',
    descriptionColumn: 'Details',
    amountColumn: '',
  });

  const mapped = await postImportPreview('unknown-bank.csv', csv, {
    name: 'Custom CSV',
    statementType: 'bank',
    dateColumns: ['When'],
    dateFormats: ['MM/dd/yyyy'],
    descriptionColumn: 'Details',
    merchantColumn: 'Details',
    categoryColumn: null,
    amountConfig: { type: 'single', column: 'Value', negativeIsDebit: true },
  });

  expect(mapped.requiresMapping).toBe(false);
  expect(mapped.profileUsed).toBe('Custom CSV');
  expect(mapped.transactions).toHaveLength(1);
  expect(mapped.transactions[0]).toMatchObject({
    amount: -6.75,
    description: 'Coffee Shop',
    merchant: 'Coffee Shop',
  });
  const importFile = getDb().prepare('SELECT parserName FROM importFiles WHERE id = ?').get(mapped.importFileId) as { parserName: string };
  expect(importFile.parserName).toBe('custom-csv');
});

test('app imports commit inserts unique transactions and updates account balance', async () => {
  const csv = fs.readFileSync(path.resolve(import.meta.dir, '..', '..', 'sample-imports', 'chase-credit-card-demo.csv'), 'utf8');
  const accountId = insertRow('accounts', {
    name: 'Chase Sapphire',
    institution: 'Chase',
    type: 'credit',
    currentBalance: 100,
  });
  const preview = await postImportPreview('chase-credit-card-demo.csv', csv);

  const firstCommit = await postJson('/api/app/imports/commit', {
    accountId,
    importFileId: preview.importFileId,
    importRowIds: preview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
    importMeta: {
      importFileId: preview.importFileId,
      headers: preview.headers,
      profile: preview.profile,
      mapping: preview.mapping,
      profileName: preview.profileUsed,
    },
  }, 201);

  expect(firstCommit.importedCount).toBe(10);
  expect(firstCommit.skippedDuplicateCount).toBe(0);
  expect(firstCommit.insertedFingerprints).toHaveLength(10);

  const importFile = getDb().prepare('SELECT * FROM importFiles WHERE id = ?').get(preview.importFileId) as {
    status: string;
    parserName: string;
    sourceType: string;
    parserPriority: number;
    institution: string;
    rowCount: number;
    importBatchId: string;
  };
  expect(importFile).toMatchObject({
    status: 'committed',
    parserName: 'chase-credit-card-csv',
    sourceType: 'activity-export',
    parserPriority: 100,
    institution: 'Chase',
    rowCount: 10,
    importBatchId: firstCommit.importBatchId,
  });
  expect(
    (getDb().prepare('SELECT status FROM sourceFiles WHERE importFileId = ?').get(preview.importFileId) as { status: string }).status
  ).toBe('committed');

  const account = getDb().prepare('SELECT currentBalance FROM accounts WHERE id = ?').get(accountId) as { currentBalance: number };
  expect(account.currentBalance).toBeCloseTo(1350.22);

  const imported = getDb().prepare('SELECT * FROM transactions WHERE accountId = ? ORDER BY date DESC').all(accountId);
  expect(imported).toHaveLength(10);
  expect(imported[0]).toMatchObject({
    description: 'ACME PAYROLL',
    transactionKind: 'card_payment',
    fingerprint: firstCommit.insertedFingerprints[0],
  });

  const sourceRow = getDb().prepare('SELECT * FROM importRows WHERE id = ?').get(preview.transactions[0].importRowId) as {
    transactionId: number;
    fingerprint: string;
    rawJson: string;
    normalizedJson: string;
  };
  expect(sourceRow.transactionId).toBe(imported[0].id);
  expect(sourceRow.fingerprint).toBe(firstCommit.insertedFingerprints[0]);
  expect(JSON.parse(sourceRow.rawJson).Description).toBe('ACME PAYROLL');
  expect(JSON.parse(sourceRow.normalizedJson)).toMatchObject({
    amountCents: 125000,
    institution: 'Chase',
    sourceRole: 'activity',
    raw: {
      category: 'Payment',
    },
  });

  const ledgerRows = getDb().prepare(`
    SELECT lt.*, t.id AS transactionId
    FROM ledgerTransactions lt
    JOIN transactions t ON t.ledgerTransactionId = lt.ledgerTransactionId
    WHERE lt.accountId = ?
    ORDER BY lt.date DESC
  `).all(accountId) as Array<{
    transactionId: number;
    legacyTransactionId: number;
    amountCents: number;
    description: string;
    sourceRole: string;
    importRowId: number;
  }>;
  expect(ledgerRows).toHaveLength(10);
  expect(ledgerRows[0]).toMatchObject({
    transactionId: imported[0].id,
    legacyTransactionId: imported[0].id,
    amountCents: 125000,
    description: 'ACME PAYROLL',
    sourceRole: 'activity',
    importRowId: preview.transactions[0].importRowId,
  });

  const savedProfile = getDb().prepare('SELECT * FROM importProfiles').get();
  expect(savedProfile).toBeNull();

  const secondCommit = await postJson('/api/app/imports/commit', {
    accountId,
    importFileId: preview.importFileId,
    importRowIds: preview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
    importMeta: {
      importFileId: preview.importFileId,
      headers: preview.headers,
      profile: preview.profile,
      mapping: preview.mapping,
      profileName: preview.profileUsed,
    },
  }, 201);

  expect(secondCommit.importedCount).toBe(0);
  expect(secondCommit.skippedDuplicateCount).toBe(10);

  const forcedCommit = await postJson('/api/app/imports/commit', {
    accountId,
    importFileId: preview.importFileId,
    importRowIds: preview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
    forceImportRowIds: [preview.transactions[0].importRowId],
    importMeta: {
      importFileId: preview.importFileId,
      headers: preview.headers,
      profile: preview.profile,
      mapping: preview.mapping,
      profileName: preview.profileUsed,
    },
  }, 201);

  expect(forcedCommit.importedCount).toBe(1);
  expect(forcedCommit.skippedDuplicateCount).toBe(9);
  expect(getDb().prepare('SELECT COUNT(*) AS count FROM transactions WHERE accountId = ?').get(accountId)).toMatchObject({
    count: 11,
  });
});

test('app imports commit resolves parser-emitted accounts without selected account', async () => {
  const now = '2026-06-16T00:00:00.000Z';
  const importFileId = Number(insertRow('importFiles', {
    fileName: 'multi-account.csv',
    contentHash: 'multi-account-hash',
    parserName: 'test-parser',
    headerSignature: 'date|description|amount',
    rowCount: 2,
    sourceType: 'activity-export',
    parserPriority: 10,
    institution: 'Fixture Bank',
    status: 'previewed',
    createdAt: now,
  }));
  const sourceFileId = Number(insertRow('sourceFiles', {
    importFileId,
    fileName: 'multi-account.csv',
    contentHash: 'multi-account-hash',
    parserName: 'test-parser',
    sourceType: 'activity-export',
    parserPriority: 10,
    institution: 'Fixture Bank',
    coveredFrom: '2026-06-15',
    coveredTo: '2026-06-16',
    status: 'previewed',
    createdAt: now,
  }));
  const sourceAccountId = Number(insertRow('sourceAccounts', {
    sourceFileId,
    institution: 'Fixture Bank',
    sourceAccountKey: 'Fixture Bank|Rewards Card - 1234',
    sourceAccountName: 'Rewards Card - 1234',
    rawJson: '{}',
    createdAt: now,
  }));
  const transactionRowId = Number(insertRow('importRows', {
    importFileId,
    rowIndex: 0,
    rowType: 'transaction',
    rawJson: JSON.stringify({ row: 'charge' }),
    normalizedJson: JSON.stringify({
      sourceRowIndex: 0,
      date: '2026-06-15',
      amountCents: -4200,
      description: 'Parser emitted charge',
      institution: 'Fixture Bank',
      account: 'Rewards Card - 1234',
      sourceRole: 'activity',
      raw: {},
    }),
    createdAt: now,
  }));
  insertRow('sourceTransactions', {
    sourceFileId,
    sourceAccountId,
    importRowId: transactionRowId,
    stableSourceId: 'src_txn_fixture_account',
    date: '2026-06-15',
    amountCents: -4200,
    description: 'Parser emitted charge',
    sourceRole: 'activity',
    priority: 10,
    rawJson: '{}',
    createdAt: now,
  });

  const commit = await postJson('/api/app/imports/commit', {
    accountId: null,
    importFileId,
    importRowIds: [transactionRowId],
  }, 201);

  expect(commit.importedCount).toBe(1);
  const account = getDb().prepare(`
    SELECT *
    FROM accounts
    WHERE institution = 'Fixture Bank' AND name = 'Rewards Card - 1234'
  `).get() as { id: number; type: string; currentBalance: number };
  expect(account).toMatchObject({
    type: 'credit',
    currentBalance: -42,
  });
  const alias = getDb().prepare('SELECT accountId FROM accountAliases WHERE institution = ? AND alias = ?')
    .get('Fixture Bank', 'Rewards Card - 1234') as { accountId: number };
  expect(alias.accountId).toBe(account.id);
  const sourceAccount = getDb().prepare('SELECT accountId FROM sourceAccounts WHERE id = ?').get(sourceAccountId) as { accountId: number };
  expect(sourceAccount.accountId).toBe(account.id);
  const transaction = getDb().prepare(`
    SELECT t.accountId, t.amount
    FROM transactions t
    JOIN importRows ir ON ir.transactionId = t.id
    WHERE ir.id = ?
  `).get(transactionRowId) as {
    accountId: number;
    amount: number;
  };
  expect(transaction).toMatchObject({
    accountId: account.id,
    amount: -42,
  });
});

test('source facts can rebuild committed transaction app rows without losing annotations', async () => {
  const csv = fs.readFileSync(path.resolve(import.meta.dir, '..', '..', 'sample-imports', 'chase-credit-card-demo.csv'), 'utf8');
  const accountId = insertRow('accounts', {
    name: 'Chase Sapphire',
    institution: 'Chase',
    type: 'credit',
    currentBalance: 100,
  });
  const categoryId = insertRow('categories', {
    name: 'Income',
    type: 'income',
  });
  const preview = await postImportPreview('chase-credit-card-demo.csv', csv);
  await postJson('/api/app/imports/commit', {
    accountId,
    importFileId: preview.importFileId,
    importRowIds: preview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
  }, 201);

  const payroll = getDb().prepare("SELECT id, ledgerTransactionId FROM transactions WHERE description = 'ACME PAYROLL'").get() as {
    id: number;
    ledgerTransactionId: string;
  };
  await putJson(`/api/transactions/${payroll.id}`, {
    categoryId,
    notes: 'source-fact-safe',
  });

  const beforeTransactions = snapshotAccountTransactions(accountId);
  const beforeBalances = snapshotBalanceSnapshots(accountId);
  const builtLedger = buildLedgerFromSourceFacts(getDb());
  const firstFingerprint = ledgerFingerprint(builtLedger);
  expect(builtLedger.transactions).toHaveLength(10);

  getDb().transaction(() => {
    getDb().prepare('DELETE FROM transactions').run();
    getDb().prepare('DELETE FROM balanceSnapshots').run();
  })();

  const rebuiltLedger = buildLedgerFromSourceFacts(getDb());
  expect(ledgerFingerprint(rebuiltLedger)).toBe(firstFingerprint);
  materializeLedger(getDb(), rebuiltLedger);

  expect(snapshotAccountTransactions(accountId)).toEqual(beforeTransactions);
  expect(snapshotBalanceSnapshots(accountId)).toEqual(beforeBalances);

  const body = await getJson('/api/app/transactions?search=source-fact-safe');
  expect(body.transactions).toHaveLength(1);
  expect(body.transactions[0].category.id).toBe(categoryId);
  expect(body.transactions[0].notes).toBe('source-fact-safe');
  expect(body.transactions[0].description).toBe('ACME PAYROLL');
  expect(
    (getDb().prepare("SELECT ledgerTransactionId FROM transactions WHERE description = 'ACME PAYROLL'").get() as { ledgerTransactionId: string }).ledgerTransactionId
  ).toBe(payroll.ledgerTransactionId);
});

test('app imports commit materializes staged statement balances', async () => {
  const accountId = insertRow('accounts', {
    name: 'Fixture Account',
    institution: 'Fixture Bank',
    type: 'investment',
    currentBalance: 0,
  });
  const now = new Date().toISOString();
  const importFileId = Number(insertRow('importFiles', {
    fileName: 'fixture-statement.pdf',
    contentHash: 'fixture-hash',
    parserName: 'fixture-statement-parser',
    sourceType: 'statement',
    parserPriority: 50,
    institution: 'Fixture Bank',
    rowCount: 2,
    status: 'previewed',
    createdAt: now,
  }));
  const transactionRowId = Number(insertRow('importRows', {
    importFileId,
    rowIndex: 0,
    rowType: 'transaction',
    rawJson: JSON.stringify({ row: 'statement interest row' }),
    normalizedJson: JSON.stringify({
      sourceRowIndex: 0,
      date: '2026-06-15',
      amountCents: 12500,
      description: 'Statement interest',
      institution: 'Fixture Bank',
      account: 'Fixture Account',
      sourceRole: 'activity',
      raw: { row: 'statement interest row' },
    }),
    createdAt: now,
  }));
  const balanceRowId = Number(insertRow('importRows', {
    importFileId,
    rowIndex: 1,
    rowType: 'balance',
    rawJson: JSON.stringify({ row: 'statement balance row' }),
    normalizedJson: JSON.stringify({
      sourceRowIndex: 0,
      date: '2026-06-30',
      balanceCents: 987654,
      institution: 'Fixture Bank',
      account: 'Fixture Account',
      raw: { row: 'statement balance row' },
    }),
    createdAt: now,
  }));

  const commit = await postJson('/api/app/imports/commit', {
    accountId,
    importFileId,
    importRowIds: [],
    balanceRowIds: [balanceRowId],
  }, 201);

  expect(transactionRowId).toBe(1);
  expect(commit.importedCount).toBe(0);
  expect(commit.importedBalanceCount).toBe(1);

  const snapshot = getDb().prepare('SELECT * FROM balanceSnapshots WHERE accountId = ?').get(accountId) as {
    month: string;
    balance: number;
    capturedAt: string;
  };
  expect(snapshot).toMatchObject({
    month: '2026-06',
    balance: 9876.54,
    capturedAt: '2026-06-30T00:00:00.000Z',
  });

  const account = getDb().prepare('SELECT currentBalance FROM accounts WHERE id = ?').get(accountId) as { currentBalance: number };
  expect(account.currentBalance).toBe(9876.54);
  const transactionCount = getDb().prepare('SELECT COUNT(*) AS count FROM transactions WHERE accountId = ?').get(accountId) as { count: number };
  expect(transactionCount.count).toBe(0);

  const balanceRow = getDb().prepare("SELECT * FROM importRows WHERE rowType = 'balance'").get() as {
    rawJson: string;
    normalizedJson: string;
  };
  expect(JSON.parse(balanceRow.rawJson)).toEqual({ row: 'statement balance row' });
  expect(JSON.parse(balanceRow.normalizedJson)).toMatchObject({ balanceCents: 987654 });
});

test('app import preview allows native parsers to handle malformed institution CSV quoting', async () => {
  const preview = await postImportPreview('bofa-checking-1234-2026-01-01-to-2026-01-31.csv', [
    'Description,,Summary Amt.',
    'Opening Balance,,"1,000.00"',
    'Date,Description,Amount,Running Bal.',
    '01/05/2026,"Zelle payment from Renter for "JAN RENT"; Conf# ABC123","1,500.00","2,500.00"',
  ].join('\n'));

  expect(preview.profileUsed).toBe('Bank of America Activity');
  expect(preview.transactions).toHaveLength(1);
  expect(preview.transactions[0]).toMatchObject({
    date: '2026-01-05',
    amount: 1500,
    description: 'Zelle payment from Renter for JAN RENT; Conf# ABC123',
    account: 'Adv Plus Banking - 1234',
    sourceAccountId: expect.any(Number),
  });
  expect(preview.accountMappings).toEqual([{
    sourceAccountId: preview.transactions[0].sourceAccountId,
    institution: 'Bank of America',
    sourceAccountName: 'Adv Plus Banking - 1234',
    resolvedAccountId: null,
    resolution: 'auto-create',
    transactionCount: 1,
    balanceCount: 1,
  }]);
  expect(preview.balanceRowIds).toHaveLength(1);
});

test('app imports commit uses source account mapping overrides', async () => {
  const existingAccountId = Number(insertRow('accounts', {
    name: 'BofA Checking',
    institution: 'Bank of America',
    type: 'checking',
    currentBalance: 100,
    currency: 'USD',
  }));
  const preview = await postImportPreview('bofa-checking-1234-2026-01-01-to-2026-01-31.csv', [
    'Description,,Summary Amt.',
    'Opening Balance,,"1,000.00"',
    'Date,Description,Amount,Running Bal.',
    '01/05/2026,TRANSFER IN,"1,500.00","2,500.00"',
  ].join('\n'));

  const sourceAccountId = preview.accountMappings[0].sourceAccountId;
  const commit = await postJson('/api/app/imports/commit', {
    accountId: null,
    importFileId: preview.importFileId,
    importRowIds: preview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
    balanceRowIds: preview.balanceRowIds,
    accountMappings: [{
      sourceAccountId,
      accountId: existingAccountId,
    }],
  }, 201);

  expect(commit.importedCount).toBe(1);
  expect(commit.importedBalanceCount).toBe(1);

  const transactions = getDb().prepare('SELECT accountId, amount FROM transactions').all() as Array<{
    accountId: number;
    amount: number;
  }>;
  expect(transactions).toEqual([{ accountId: existingAccountId, amount: 1500 }]);

  const duplicateAccount = getDb().prepare(`
    SELECT id
    FROM accounts
    WHERE institution = 'Bank of America'
      AND name = 'Adv Plus Banking - 1234'
  `).get();
  expect(duplicateAccount).toBeNull();

  const alias = getDb().prepare(`
    SELECT accountId
    FROM accountAliases
    WHERE institution = ? AND alias = ?
  `).get('Bank of America', 'Adv Plus Banking - 1234') as { accountId: number };
  expect(alias.accountId).toBe(existingAccountId);

  const sourceAccount = getDb().prepare('SELECT accountId FROM sourceAccounts WHERE id = ?').get(sourceAccountId) as {
    accountId: number;
  };
  expect(sourceAccount.accountId).toBe(existingAccountId);
});

test('app import preview stages multiple source balances for the same account and date', async () => {
  const preview = await postImportPreview('bofa-savings-1234-2026-01-01-to-2026-01-31.csv', [
    'Description,,Summary Amt.',
    'Opening Balance,,"1,000.00"',
    'Date,Description,Amount,Running Bal.',
    '01/05/2026,TRANSFER IN,"1,500.00","2,500.00"',
    '01/05/2026,UTILITY BILL,"-125.50","2,374.50"',
  ].join('\n'));

  expect(preview.profileUsed).toBe('Bank of America Activity');
  expect(preview.transactions).toHaveLength(2);
  expect(preview.balanceRowIds).toHaveLength(2);

  const sourceBalances = getDb().prepare(`
    SELECT sb.date, sb.balanceCents
    FROM sourceBalances sb
    JOIN sourceFiles sf ON sf.id = sb.sourceFileId
    WHERE sf.importFileId = ?
    ORDER BY sb.importRowId ASC
  `).all(preview.importFileId);
  expect(sourceBalances).toEqual([
    { date: '2026-01-05', balanceCents: 250000 },
    { date: '2026-01-05', balanceCents: 237450 },
  ]);
});

test('app import materialization is independent of import file commit order', async () => {
  const accountId = insertRow('accounts', {
    name: 'Chase Sapphire',
    institution: 'Chase',
    type: 'credit',
    currentBalance: 0,
  });
  const rows = [
    '06/14/2026,06/14/2026,ACME PAYROLL,Payment,Payment,1250.00',
    '06/13/2026,06/14/2026,TACO TEMPLE,Food & Drink,Sale,-42.37',
    '06/12/2026,06/13/2026,WHOLE FOODS MARKET,Groceries,Sale,-132.18',
    '06/11/2026,06/12/2026,SHELL OIL 123456,Gas,Sale,-47.52',
  ];
  const previewA = await postImportPreview('chase-a.csv', csvFromRows(rows.slice(0, 3)));
  const previewB = await postImportPreview('chase-b.csv', csvFromRows(rows.slice(1, 4)));

  const commitPreview = (preview: { importFileId: number; transactions: Array<{ importRowId: number }> }) =>
    postJson('/api/app/imports/commit', {
      accountId,
      importFileId: preview.importFileId,
      importRowIds: preview.transactions.map(transaction => transaction.importRowId),
    }, 201);

  await commitPreview(previewA);
  await commitPreview(previewB);
  const forward = snapshotAccountTransactions(accountId);

  resetMaterializedImports(accountId);

  await commitPreview(previewB);
  await commitPreview(previewA);
  const reverse = snapshotAccountTransactions(accountId);

  expect(reverse).toEqual(forward);
});
