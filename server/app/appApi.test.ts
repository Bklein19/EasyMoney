import { afterAll, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.EASYMONEY_DB_PATH = path.join(os.tmpdir(), `easymoney-app-api-${process.pid}.sqlite`);

const { createServer } = await import('../index.ts');
const { getDb, initDatabase, insertRow } = await import('../database.js');
const server = createServer({ port: 0 });
const TEST_URL = `http://localhost:${server.port}`;

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
      'transactionAnnotations',
      'transactions',
      'balanceSnapshots',
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

async function postImportPreview(fileName: string, text: string) {
  const form = new FormData();
  form.append('file', new File([text], fileName, { type: 'text/csv' }));

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
    SELECT date, amount, description, merchant, originalCategory, transactionKind, fingerprint, importBatchId
    FROM transactions
    WHERE accountId = ?
    ORDER BY fingerprint ASC
  `).all(accountId);
}

function resetMaterializedImports(accountId: number) {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM transactions WHERE accountId = ?').run(accountId);
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

  expect(body.transactions).toEqual([
    {
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
    },
  ]);
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
