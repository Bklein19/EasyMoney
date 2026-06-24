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
const {
  groupTransactionsForAiCategorization,
  shouldTreatInvestmentCategoryAsTransfer,
  shouldReviewInvestmentAccountTransferDecision,
} = await import('./aiCategorization.ts');
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
      'transactionCategoryUndoOperations',
      'transactionAnnotations',
      'merchantGroupingRules',
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

async function patchJson(path: string, payload: unknown, expectedStatus = 200) {
  const response = await fetch(`${TEST_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(expectedStatus);
  return response.json();
}

async function deleteJson(path: string, expectedStatus = 200) {
  const response = await fetch(`${TEST_URL}${path}`, { method: 'DELETE' });
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

test('init database records account owner schema migration', () => {
  const migration = getDb().prepare(
    "SELECT name FROM schemaMigrations WHERE name = '2026-06-20-account-owner'"
  ).get() as { name: string } | undefined;
  const accountColumns = getDb().prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>;

  expect(migration).toEqual({ name: '2026-06-20-account-owner' });
  expect(accountColumns.map(column => column.name)).toContain('accountHolder');
});

test('init database records category group schema migration', () => {
  const migration = getDb().prepare(
    "SELECT name FROM schemaMigrations WHERE name = '2026-06-22-category-groups'"
  ).get() as { name: string } | undefined;
  const categoryColumns = getDb().prepare('PRAGMA table_info(categories)').all() as Array<{ name: string }>;

  expect(migration).toEqual({ name: '2026-06-22-category-groups' });
  expect(categoryColumns.map(column => column.name)).toContain('categoryGroup');
});

test('init database records category description schema migration', () => {
  const migration = getDb().prepare(
    "SELECT name FROM schemaMigrations WHERE name = '2026-06-23-category-descriptions'"
  ).get() as { name: string } | undefined;
  const categoryColumns = getDb().prepare('PRAGMA table_info(categories)').all() as Array<{ name: string }>;

  expect(migration).toEqual({ name: '2026-06-23-category-descriptions' });
  expect(categoryColumns.map(column => column.name)).toContain('description');
});

test('init database records credit-card sign repair migration', () => {
  const migration = getDb().prepare(
    "SELECT name FROM schemaMigrations WHERE name = '2026-06-23-credit-card-cashflow-signs'"
  ).get() as { name: string } | undefined;

  expect(migration).toEqual({ name: '2026-06-23-credit-card-cashflow-signs' });
});

test('credit-card sign repair migration converts old money liability signs to cashflow signs', () => {
  const db = getDb();
  const accountId = Number(insertRow('accounts', {
    name: 'Credit Card',
    institution: 'Test Bank',
    type: 'credit',
    currency: 'USD',
  }));
  const importFileId = Number(insertRow('importFiles', {
    fileName: 'test-credit-card.pdf',
    contentHash: 'credit-card-sign-test',
    parserName: 'Test Credit Card',
    sourceType: 'statement',
    status: 'committed',
  }));
  const sourceFileId = Number(insertRow('sourceFiles', {
    importFileId,
    fileName: 'test-credit-card.pdf',
    contentHash: 'credit-card-sign-test',
    parserName: 'Test Credit Card',
    sourceType: 'statement',
    status: 'committed',
  }));
  const sourceAccountId = Number(insertRow('sourceAccounts', {
    sourceFileId,
    accountId,
    institution: 'Test Bank',
    sourceAccountKey: 'Test Bank|Credit Card',
    sourceAccountName: 'Credit Card',
  }));
  const purchaseImportRowId = Number(insertRow('importRows', {
    importFileId,
    rowIndex: 0,
    rowType: 'transaction',
    rawJson: '{}',
    normalizedJson: JSON.stringify({
      sourceRowIndex: 0,
      date: '2026-06-01',
      amountCents: 1250,
      description: 'Coffee shop',
      institution: 'Test Bank',
      account: 'Credit Card',
      sourceRole: 'activity',
      raw: { moneyCategory: 'activity', type: 'credit-card-activity' },
    }),
    fingerprint: 'bad-purchase',
  }));
  const paymentImportRowId = Number(insertRow('importRows', {
    importFileId,
    rowIndex: 1,
    rowType: 'transaction',
    rawJson: '{}',
    normalizedJson: JSON.stringify({
      sourceRowIndex: 1,
      date: '2026-06-02',
      amountCents: -50000,
      description: 'ONLINE PAYMENT THANK YOU',
      institution: 'Test Bank',
      account: 'Credit Card',
      sourceRole: 'activity',
      raw: { moneyCategory: 'activity', type: 'credit-card-activity' },
    }),
    fingerprint: 'bad-payment',
  }));
  const purchaseSourceTransactionId = Number(insertRow('sourceTransactions', {
    sourceFileId,
    sourceAccountId,
    importRowId: purchaseImportRowId,
    stableSourceId: 'bad-purchase-source-id',
    date: '2026-06-01',
    amountCents: 1250,
    description: 'Coffee shop',
    sourceRole: 'activity',
    priority: 50,
    rawJson: JSON.stringify({ moneyCategory: 'activity', type: 'credit-card-activity' }),
  }));
  const paymentSourceTransactionId = Number(insertRow('sourceTransactions', {
    sourceFileId,
    sourceAccountId,
    importRowId: paymentImportRowId,
    stableSourceId: 'bad-payment-source-id',
    date: '2026-06-02',
    amountCents: -50000,
    description: 'ONLINE PAYMENT THANK YOU',
    sourceRole: 'activity',
    priority: 50,
    rawJson: JSON.stringify({ moneyCategory: 'activity', type: 'credit-card-activity' }),
  }));
  const purchaseTransactionId = Number(insertRow('transactions', {
    accountId,
    date: '2026-06-01',
    amount: 12.50,
    description: 'Coffee shop',
    type: 'credit',
    transactionKind: 'card_payment',
    ledgerTransactionId: 'txn_purchase_old',
    fingerprint: 'bad-purchase',
  }));
  const paymentTransactionId = Number(insertRow('transactions', {
    accountId,
    date: '2026-06-02',
    amount: -500,
    description: 'ONLINE PAYMENT THANK YOU',
    type: 'debit',
    transactionKind: null,
    ledgerTransactionId: 'txn_payment_old',
    fingerprint: 'bad-payment',
  }));
  insertRow('ledgerTransactions', {
    ledgerTransactionId: 'txn_purchase_old',
    legacyTransactionId: purchaseTransactionId,
    accountId,
    date: '2026-06-01',
    amountCents: 1250,
    description: 'Coffee shop',
    type: 'credit',
    transactionKind: 'card_payment',
    fingerprint: 'bad-purchase',
    sourceRole: 'activity',
    importFileId,
    importRowId: purchaseImportRowId,
    sourceTransactionId: purchaseSourceTransactionId,
  });
  insertRow('ledgerTransactions', {
    ledgerTransactionId: 'txn_payment_old',
    legacyTransactionId: paymentTransactionId,
    accountId,
    date: '2026-06-02',
    amountCents: -50000,
    description: 'ONLINE PAYMENT THANK YOU',
    type: 'debit',
    transactionKind: null,
    fingerprint: 'bad-payment',
    sourceRole: 'activity',
    importFileId,
    importRowId: paymentImportRowId,
    sourceTransactionId: paymentSourceTransactionId,
  });

  db.prepare("DELETE FROM schemaMigrations WHERE name = '2026-06-23-credit-card-cashflow-signs'").run();
  initDatabase();

  expect(db.prepare('SELECT amountCents FROM sourceTransactions WHERE id = ?').get(purchaseSourceTransactionId)).toEqual({ amountCents: -1250 });
  expect(db.prepare('SELECT amountCents FROM sourceTransactions WHERE id = ?').get(paymentSourceTransactionId)).toEqual({ amountCents: 50000 });
  expect(db.prepare('SELECT amount, type, transactionKind FROM transactions WHERE id = ?').get(purchaseTransactionId)).toEqual({
    amount: -12.5,
    type: 'debit',
    transactionKind: null,
  });
  expect(db.prepare('SELECT amount, type, transactionKind FROM transactions WHERE id = ?').get(paymentTransactionId)).toEqual({
    amount: 500,
    type: 'credit',
    transactionKind: 'card_payment',
  });
});

test('app accounts endpoint returns domain-shaped accounts', async () => {
  const accountId = Number(insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
    currentBalance: 1234.56,
    currency: 'USD',
    accountHolder: 'Alex',
    updatedAt: '2026-06-14T12:00:00.000Z',
  }));
  insertRow('ledgerBalances', {
    accountId,
    month: '2026-06',
    balanceCents: 234567,
    capturedAt: '2026-06-30T00:00:00.000Z',
  });
  insertRow('accountAliases', {
    institution: 'Local Bank',
    alias: 'Everyday Checking - 1234',
    accountId,
    createdAt: '2026-06-14T12:00:00.000Z',
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
        balance: 2345.67,
        latestBalanceMonth: '2026-06',
        isClosed: false,
        currency: 'USD',
        accountHolder: 'Alex',
        status: 'active',
        archivedAt: null,
        updatedAt: '2026-06-14T12:00:00.000Z',
        aliases: [
          {
            id: 1,
            institution: 'Local Bank',
            alias: 'Everyday Checking - 1234',
          },
        ],
      },
    ],
  });
});

test('app accounts endpoint derives closed accounts from zero ledger balances', async () => {
  const accountId = Number(insertRow('accounts', {
    name: 'Closed Card',
    institution: 'Local Bank',
    type: 'credit-card',
    currentBalance: 12.34,
    currency: 'USD',
    updatedAt: '2026-06-14T12:00:00.000Z',
  }));
  insertRow('ledgerBalances', {
    accountId,
    month: '2026-06',
    balanceCents: 0,
    capturedAt: '2026-06-30T00:00:00.000Z',
  });

  const body = await getJson('/api/app/accounts') as {
    accounts: Array<{ id: number; balance: number; latestBalanceMonth: string | null; isClosed: boolean; status: string }>;
  };

  expect(body.accounts).toEqual([
    expect.objectContaining({
      id: accountId,
      balance: 0,
      latestBalanceMonth: '2026-06',
      isClosed: true,
      status: 'active',
    }),
  ]);
});

test('app accounts endpoint updates account owner metadata', async () => {
  const accountId = Number(insertRow('accounts', {
    name: 'Joint Brokerage',
    institution: 'Vanguard',
    type: 'investment',
    currentBalance: 0,
  }));

  await patchJson(`/api/app/accounts/${accountId}`, { accountHolder: 'Example Owner' });
  expect(await getJson('/api/app/accounts')).toMatchObject({
    accounts: [expect.objectContaining({
      id: accountId,
      accountHolder: 'Example Owner',
    })],
  });

  await patchJson(`/api/app/accounts/${accountId}`, { accountHolder: '' });
  expect(await getJson('/api/app/accounts')).toMatchObject({
    accounts: [expect.objectContaining({
      id: accountId,
      accountHolder: null,
    })],
  });
});

test('app account archive hides defaults without deleting source links or annotations', async () => {
  const accountId = Number(insertRow('accounts', {
    name: 'Archive Me',
    institution: 'Local Bank',
    type: 'checking',
    currentBalance: 0,
  }));
  const importFileId = Number(insertRow('importFiles', {
    fileName: 'archive.csv',
    contentHash: 'archive-hash',
    parserName: 'fixture',
    status: 'committed',
    createdAt: new Date().toISOString(),
    committedAt: new Date().toISOString(),
  }));
  const sourceFileId = Number(insertRow('sourceFiles', {
    importFileId,
    fileName: 'archive.csv',
    contentHash: 'archive-hash',
    parserName: 'fixture',
    status: 'committed',
    createdAt: new Date().toISOString(),
    committedAt: new Date().toISOString(),
  }));
  const sourceAccountId = Number(insertRow('sourceAccounts', {
    sourceFileId,
    accountId,
    institution: 'Local Bank',
    sourceAccountKey: 'local|archive',
    sourceAccountName: 'Archive Me',
    rawJson: '{}',
    createdAt: new Date().toISOString(),
  }));
  insertRow('sourceTransactions', {
    sourceFileId,
    sourceAccountId,
    stableSourceId: 'archive-txn',
    date: '2026-06-01',
    amountCents: -1200,
    description: 'Archived transaction',
    sourceRole: 'activity',
    priority: 1,
    rawJson: '{}',
    createdAt: new Date().toISOString(),
  });
  materializeLedger(getDb(), buildLedgerFromSourceFacts(getDb()));
  const ledgerTransaction = getDb().prepare('SELECT ledgerTransactionId FROM ledgerTransactions WHERE accountId = ?').get(accountId) as {
    ledgerTransactionId: string;
  };
  insertRow('transactionAnnotations', {
    ledgerTransactionId: ledgerTransaction.ledgerTransactionId,
    notes: 'keep archived note',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await postJson(`/api/app/accounts/${accountId}/archive`, {});

  expect(await getJson('/api/app/accounts')).toEqual({ accounts: [] });
  const withArchived = await getJson('/api/app/accounts?includeArchived=true') as { accounts: Array<{ id: number; status: string; archivedAt: string | null }> };
  expect(withArchived.accounts).toMatchObject([{ id: accountId, status: 'archived' }]);
  expect(withArchived.accounts[0].archivedAt).toEqual(expect.any(String));
  expect(await getJson('/api/app/transactions')).toMatchObject({ transactions: [] });
  expect(getDb().prepare('SELECT accountId FROM sourceAccounts WHERE id = ?').get(sourceAccountId)).toMatchObject({ accountId });
  expect(getDb().prepare('SELECT notes FROM transactionAnnotations WHERE ledgerTransactionId = ?').get(ledgerTransaction.ledgerTransactionId)).toMatchObject({
    notes: 'keep archived note',
  });

  await postJson(`/api/app/accounts/${accountId}/unarchive`, {});
  expect(await getJson('/api/app/accounts')).toMatchObject({
    accounts: [expect.objectContaining({ id: accountId, status: 'active', archivedAt: null })],
  });
  await patchJson(`/api/app/accounts/${accountId}`, { name: 'Archive Restored' });
  expect(await getJson('/api/app/accounts')).toMatchObject({
    accounts: [expect.objectContaining({ name: 'Archive Restored' })],
  });
});

test('app categories endpoint returns domain-shaped categories', async () => {
  insertRow('categories', {
    name: 'Groceries',
    parentId: null,
    type: 'expense',
    categoryGroup: 'variable',
    description: 'Groceries and household staples.',
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
        categoryGroup: 'variable',
        description: 'Groceries and household staples.',
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

test('app transactions endpoint supports infinite-scroll paging metadata', async () => {
  const accountId = insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
  });

  insertRow('transactions', {
    accountId,
    date: '2026-06-16',
    amount: -30,
    description: 'Newest',
    type: 'expense',
  });
  insertRow('transactions', {
    accountId,
    date: '2026-06-15',
    amount: 100,
    description: 'Middle',
    type: 'income',
  });
  insertRow('transactions', {
    accountId,
    date: '2026-06-14',
    amount: -20,
    description: 'Oldest',
    type: 'expense',
  });

  const firstPage = await getJson('/api/app/transactions?limit=2&offset=0') as {
    transactions: Array<{ description: string }>;
    totalCount: number;
    hasMore: boolean;
    nextOffset: number | null;
    totals: { income: number; expenses: number; net: number };
  };
  const secondPage = await getJson('/api/app/transactions?limit=2&offset=2') as {
    transactions: Array<{ description: string }>;
    totalCount: number;
    hasMore: boolean;
    nextOffset: number | null;
  };

  expect(firstPage.transactions.map(transaction => transaction.description)).toEqual(['Newest', 'Middle']);
  expect(firstPage.totalCount).toBe(3);
  expect(firstPage.hasMore).toBe(true);
  expect(firstPage.nextOffset).toBe(2);
  expect(firstPage.totals).toMatchObject({ income: 100, expenses: 50, net: 50 });
  expect(secondPage.transactions.map(transaction => transaction.description)).toEqual(['Oldest']);
  expect(secondPage.totalCount).toBe(3);
  expect(secondPage.hasMore).toBe(false);
  expect(secondPage.nextOffset).toBeNull();
});

test('app transactions endpoint filters uncategorized transactions by missing or explicit uncategorized category', async () => {
  const accountId = insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
  });
  const uncategorizedId = insertRow('categories', { name: 'Uncategorized', type: 'expense' });
  const foodId = insertRow('categories', { name: 'Food', type: 'expense' });

  const missingCategoryId = insertRow('transactions', {
    accountId,
    date: '2026-06-14',
    amount: -10,
    description: 'Missing category',
    type: 'expense',
  });
  const explicitUncategorizedId = insertRow('transactions', {
    accountId,
    date: '2026-06-15',
    amount: -20,
    description: 'Explicit uncategorized',
    type: 'expense',
  });
  await putJson(`/api/transactions/${explicitUncategorizedId}`, { categoryId: uncategorizedId });
  const categorizedId = insertRow('transactions', {
    accountId,
    date: '2026-06-16',
    amount: -30,
    description: 'Categorized',
    type: 'expense',
  });
  await putJson(`/api/transactions/${categorizedId}`, { categoryId: foodId });

  const body = await getJson('/api/app/transactions?categoryId=uncategorized');

  expect(body.transactions.map((transaction: { description: string }) => transaction.description)).toEqual([
    'Explicit uncategorized',
    'Missing category',
  ]);
  expect(body.transactions.map((transaction: { id: number }) => transaction.id)).toEqual([
    explicitUncategorizedId,
    missingCategoryId,
  ]);
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
  expect(before.totalCount).toBe(1);
  expect(before.hasMore).toBe(false);
  expect(before.nextOffset).toBeNull();
  expect(before.transactions[0].category).toBeNull();

  await trpcClient.transactions.categorize.mutate({
    transactionIds: [transactionId],
    categoryId,
  });

  const after = await trpcClient.transactions.list.query({ search: 'TRPC Cafe', limit: 1 });
  expect(after.transactions).toHaveLength(1);
  expect(after.transactions[0].category?.id).toBe(categoryId);
});

test('trpc transactions categorize matching applies to the full filtered result set', async () => {
  const accountId = insertRow('accounts', { name: 'Checking', type: 'checking', currentBalance: 0 });
  const categoryId = insertRow('categories', { name: 'Coffee', type: 'expense' });
  insertRow('transactions', {
    accountId,
    date: '2026-06-03',
    amount: -4.25,
    description: 'Bulk Coffee One',
    type: 'expense',
    status: 'cleared',
  });
  insertRow('transactions', {
    accountId,
    date: '2026-06-04',
    amount: -5.75,
    description: 'Bulk Coffee Two',
    type: 'expense',
    status: 'cleared',
  });
  insertRow('transactions', {
    accountId,
    date: '2026-06-05',
    amount: -18.25,
    description: 'Unmatched Lunch',
    type: 'expense',
    status: 'cleared',
  });

  const previewPage = await trpcClient.transactions.list.query({ search: 'Bulk Coffee', limit: 1 });
  expect(previewPage.transactions).toHaveLength(1);
  expect(previewPage.totalCount).toBe(2);

  const result = await trpcClient.transactions.categorizeMatching.mutate({
    query: { search: 'Bulk Coffee' },
    categoryId,
  });
  expect(result.ok).toBe(true);
  expect(result.count).toBe(2);
  expect(result.undoOperation).toMatchObject({
    categoryName: 'Coffee',
    count: 2,
  });
  expect(typeof result.undoOperation?.id).toBe('number');

  const pendingUndo = await trpcClient.transactions.latestCategoryUndo.query();
  expect(pendingUndo).toEqual(result.undoOperation);

  const matching = await trpcClient.transactions.list.query({ search: 'Bulk Coffee' });
  expect(matching.transactions).toHaveLength(2);
  expect(matching.transactions.every(transaction => transaction.category?.id === categoryId)).toBe(true);

  const unmatched = await trpcClient.transactions.list.query({ search: 'Unmatched Lunch' });
  expect(unmatched.transactions).toHaveLength(1);
  expect(unmatched.transactions[0].category).toBeNull();

  const undo = await trpcClient.transactions.restoreCategories.mutate({
    undoOperationId: result.undoOperation?.id ?? 0,
  });
  expect(undo).toEqual({ ok: true, count: 2 });
  expect(await trpcClient.transactions.latestCategoryUndo.query()).toBeNull();

  const restored = await trpcClient.transactions.list.query({ search: 'Bulk Coffee' });
  expect(restored.transactions).toHaveLength(2);
  expect(restored.transactions.every(transaction => transaction.category === null)).toBe(true);
});

test('trpc transactions categorization coverage summarizes categorized count and money', async () => {
  const accountId = Number(insertRow('accounts', { name: 'Checking', type: 'checking', currentBalance: 0 }));
  const archivedAccountId = Number(insertRow('accounts', {
    name: 'Archived Checking',
    type: 'checking',
    currentBalance: 0,
    status: 'archived',
  }));
  const foodCategoryId = Number(insertRow('categories', { name: 'Food', type: 'expense' }));
  const uncategorizedCategoryId = Number(insertRow('categories', { name: 'Uncategorized', type: 'expense' }));
  const now = new Date().toISOString();
  const insertLedger = (ledgerTransactionId: string, amountCents: number, account = accountId) => {
    insertRow('ledgerTransactions', {
      ledgerTransactionId,
      accountId: account,
      date: '2026-06-01',
      amountCents,
      description: ledgerTransactionId,
      type: amountCents >= 0 ? 'income' : 'expense',
      transactionKind: 'activity',
      createdAt: now,
    });
  };

  insertLedger('coverage_food', -1000);
  insertLedger('coverage_uncategorized', -2500);
  insertLedger('coverage_null', 3000);
  insertLedger('coverage_archived', -5000, archivedAccountId);
  insertRow('transactionAnnotations', {
    ledgerTransactionId: 'coverage_food',
    categoryId: foodCategoryId,
    createdAt: now,
    updatedAt: now,
  });
  insertRow('transactionAnnotations', {
    ledgerTransactionId: 'coverage_uncategorized',
    categoryId: uncategorizedCategoryId,
    createdAt: now,
    updatedAt: now,
  });
  insertRow('transactionAnnotations', {
    ledgerTransactionId: 'coverage_archived',
    categoryId: foodCategoryId,
    createdAt: now,
    updatedAt: now,
  });

  const coverage = await trpcClient.transactions.categorizationCoverage.query();

  expect(coverage).toEqual({
    totalCount: 3,
    categorizedCount: 1,
    uncategorizedCount: 2,
    transactionPercent: 1 / 3,
    totalAmountCents: 6500,
    categorizedAmountCents: 1000,
    uncategorizedAmountCents: 5500,
    amountPercent: 1000 / 6500,
  });
});


test('ai categorization apply writes transaction annotations by ledger id', async () => {
  const oldCategoryId = Number(insertRow('categories', { name: 'Uncategorized', type: 'expense' }));
  const categoryId = Number(insertRow('categories', { name: 'Dining', type: 'expense' }));
  const accountId = Number(insertRow('accounts', {
    name: 'AI Test Checking',
    type: 'checking',
    currentBalance: 0,
  }));
  insertRow('ledgerTransactions', {
    ledgerTransactionId: 'txn_ai_apply',
    accountId,
    date: '2026-06-01',
    amountCents: -1800,
    description: 'Cafe Test',
    merchant: 'Cafe Test',
    type: 'expense',
    transactionKind: 'activity',
    createdAt: new Date().toISOString(),
  });
  insertRow('transactionAnnotations', {
    ledgerTransactionId: 'txn_ai_apply',
    categoryId: oldCategoryId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const result = await trpcClient.transactions.applyAiCategorization.mutate({
    suggestions: [{ transactionId: 'txn_ai_apply', categoryId }],
  });

  expect(result).toMatchObject({
    count: 1,
    requested: 1,
    appliedTransactionIds: ['txn_ai_apply'],
    skipped: [],
    undoOperation: {
      categoryName: 'Dining',
      count: 1,
    },
  });
  expect(
    getDb().prepare('SELECT categoryId FROM transactionAnnotations WHERE ledgerTransactionId = ?').get('txn_ai_apply')
  ).toMatchObject({ categoryId });

  expect(result.undoOperation).not.toBeNull();
  await trpcClient.transactions.restoreCategories.mutate({
    undoOperationId: result.undoOperation!.id,
  });
  expect(
    getDb().prepare('SELECT categoryId FROM transactionAnnotations WHERE ledgerTransactionId = ?').get('txn_ai_apply')
  ).toMatchObject({ categoryId: oldCategoryId });
});

test('ai categorization apply reports skipped already categorized transactions', async () => {
  const oldCategoryId = Number(insertRow('categories', { name: 'Old Category', type: 'expense' }));
  const newCategoryId = Number(insertRow('categories', { name: 'New Category', type: 'expense' }));
  const accountId = Number(insertRow('accounts', {
    name: 'AI Test Checking',
    type: 'checking',
    currentBalance: 0,
  }));
  insertRow('ledgerTransactions', {
    ledgerTransactionId: 'txn_ai_skip',
    accountId,
    date: '2026-06-01',
    amountCents: -1800,
    description: 'Already Done',
    merchant: 'Already Done',
    type: 'expense',
    transactionKind: 'activity',
    createdAt: new Date().toISOString(),
  });
  insertRow('transactionAnnotations', {
    ledgerTransactionId: 'txn_ai_skip',
    categoryId: oldCategoryId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const result = await trpcClient.transactions.applyAiCategorization.mutate({
    suggestions: [{ transactionId: 'txn_ai_skip', categoryId: newCategoryId }],
  });

  expect(result).toMatchObject({
    count: 0,
    requested: 1,
    skipped: [{ transactionId: 'txn_ai_skip', reason: 'Already categorized' }],
  });
  expect(
    getDb().prepare('SELECT categoryId FROM transactionAnnotations WHERE ledgerTransactionId = ?').get('txn_ai_skip')
  ).toMatchObject({ categoryId: oldCategoryId });
});

test('ai categorization preview excludes explicitly uncategorized transactions', async () => {
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = '';
  const uncategorizedId = Number(insertRow('categories', { name: 'Uncategorized', type: 'expense' }));
  const accountId = Number(insertRow('accounts', {
    name: 'AI Review Checking',
    type: 'checking',
    currentBalance: 0,
  }));
  insertRow('ledgerTransactions', {
    ledgerTransactionId: 'txn_ai_empty',
    accountId,
    date: '2026-06-01',
    amountCents: -1000,
    description: 'Needs Review Coffee',
    merchant: 'Needs Review Coffee',
    type: 'expense',
    transactionKind: 'activity',
    createdAt: new Date().toISOString(),
  });
  insertRow('ledgerTransactions', {
    ledgerTransactionId: 'txn_ai_explicit_uncategorized',
    accountId,
    date: '2026-06-02',
    amountCents: -2000,
    description: 'Leave Uncategorized',
    merchant: 'Leave Uncategorized',
    type: 'expense',
    transactionKind: 'activity',
    createdAt: new Date().toISOString(),
  });
  insertRow('transactionAnnotations', {
    ledgerTransactionId: 'txn_ai_explicit_uncategorized',
    categoryId: uncategorizedId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  try {
    const result = await trpcClient.transactions.aiCategorizationPreview.mutate({ limit: 32 });

    expect(result).toMatchObject({
      configured: false,
      scanned: 1,
      groupCount: 1,
      reviewedGroupCount: 1,
    });
  } finally {
    if (previousOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
  }
});

test('ai categorization groups uncategorized transactions by merchant before model review', () => {
  const groups = groupTransactionsForAiCategorization([
    {
      id: 1,
      ledgerTransactionId: 'check_123',
      accountName: 'Checking',
      accountInstitution: 'Bank',
      accountType: 'checking',
      date: '2026-06-01',
      amountCents: -20000,
      description: 'Check 123',
      merchant: 'Check 123',
      originalDescription: 'Check 123',
      originalCategory: null,
      transactionKind: 'activity',
    },
    {
      id: 2,
      ledgerTransactionId: 'check_124',
      accountName: 'Checking',
      accountInstitution: 'Bank',
      accountType: 'checking',
      date: '2026-06-08',
      amountCents: -20000,
      description: 'Check 124',
      merchant: 'Check 124',
      originalDescription: 'Check 124',
      originalCategory: null,
      transactionKind: 'activity',
    },
    {
      id: 3,
      ledgerTransactionId: 'coffee_1',
      accountName: 'Checking',
      accountInstitution: 'Bank',
      accountType: 'checking',
      date: '2026-06-09',
      amountCents: -575,
      description: 'Starbucks #999',
      merchant: 'Starbucks #999',
      originalDescription: 'Starbucks #999',
      originalCategory: null,
      transactionKind: 'activity',
    },
  ]);

  expect(groups[0]).toMatchObject({
    merchantName: 'Check',
    transactionIds: ['check_124', 'check_123'],
    transactionCount: 2,
    totalAmount: -400,
    absoluteAmount: 400,
  });
  expect(groups[1]).toMatchObject({
    merchantName: 'Starbucks',
    transactionIds: ['coffee_1'],
    transactionCount: 1,
  });
});

test('ai categorization persists merchant grouping rules for generic processor descriptions', async () => {
  const processorRows = [
    {
      id: 1,
      ledgerTransactionId: 'processor_uber',
      accountName: 'BofA Checking',
      accountInstitution: 'Bank of America',
      accountType: 'checking',
      date: '2026-06-01',
      amountCents: -3993,
      description: 'PROCESSOR DES:INST XFER ID:UBER INDN:TEST USER CO ID:PAYPALTEST WEB',
      merchant: 'PROCESSOR DES:INST XFER ID:UBER INDN:TEST USER CO ID:PAYPALTEST WEB',
      originalDescription: 'PROCESSOR DES:INST XFER ID:UBER INDN:TEST USER CO ID:PAYPALTEST WEB',
      originalCategory: null,
      transactionKind: 'activity',
    },
    {
      id: 2,
      ledgerTransactionId: 'processor_suit',
      accountName: 'BofA Checking',
      accountInstitution: 'Bank of America',
      accountType: 'checking',
      date: '2026-06-02',
      amountCents: -16594,
      description: 'PROCESSOR DES:INST XFER ID:SUITSUPPLYU 041 INDN:TEST USER CO ID:PAYPALTEST WEB',
      merchant: 'PROCESSOR DES:INST XFER ID:SUITSUPPLYU 041 INDN:TEST USER CO ID:PAYPALTEST WEB',
      originalDescription: 'PROCESSOR DES:INST XFER ID:SUITSUPPLYU 041 INDN:TEST USER CO ID:PAYPALTEST WEB',
      originalCategory: null,
      transactionKind: 'activity',
    },
  ];

  const [combinedGroup] = groupTransactionsForAiCategorization(processorRows);
  expect(combinedGroup).toMatchObject({
    merchantName: 'Processor Des Inst Xfer Indn Test User Co Web',
    transactionCount: 2,
    sourceMerchantKey: 'PROCESSOR DES INST XFER INDN TEST USER CO WEB',
  });

  const rule = await trpcClient.transactions.createMerchantGroupingRule.mutate({
    sourceMerchantKey: combinedGroup!.sourceMerchantKey,
  });
  expect(rule).toMatchObject({
    sourceMerchantKey: 'PROCESSOR DES INST XFER INDN TEST USER CO WEB',
    strategy: 'bank_description_counterparty',
  });

  const splitGroups = groupTransactionsForAiCategorization(processorRows);
  expect(splitGroups.map(group => ({
    merchantName: group.merchantName,
    transactionIds: group.transactionIds,
  }))).toEqual([
    { merchantName: 'Suitsupplyu', transactionIds: ['processor_suit'] },
    { merchantName: 'Uber', transactionIds: ['processor_uber'] },
  ]);
});

test('ai categorization normalizes PayPal processor descriptions to counterparties', () => {
  const groups = groupTransactionsForAiCategorization([
    {
      id: 1,
      ledgerTransactionId: 'paypal_apple_purchase',
      accountName: 'BofA Checking',
      accountInstitution: 'Bank of America',
      accountType: 'checking',
      date: '2026-05-19',
      amountCents: -1593,
      description: 'PAYPAL DES:PURCHASE ID:APPLE.COM BILL INDN:TEST USER CO ID:PAYPALTEST WEB',
      merchant: 'PAYPAL DES:PURCHASE ID:APPLE.COM BILL INDN:TEST USER CO ID:PAYPALTEST WEB',
      originalDescription: 'PAYPAL DES:PURCHASE ID:APPLE.COM BILL INDN:TEST USER CO ID:PAYPALTEST WEB',
      originalCategory: null,
      transactionKind: 'activity',
    },
    {
      id: 2,
      ledgerTransactionId: 'paypal_apple_inst_xfer',
      accountName: 'BofA Checking',
      accountInstitution: 'Bank of America',
      accountType: 'checking',
      date: '2026-03-19',
      amountCents: -2867,
      description: 'PAYPAL DES:INST XFER ID:APPLE.COM BILL INDN:TEST USER CO ID:PAYPALTEST WEB',
      merchant: 'PAYPAL DES:INST XFER ID:APPLE.COM BILL INDN:TEST USER CO ID:PAYPALTEST WEB',
      originalDescription: 'PAYPAL DES:INST XFER ID:APPLE.COM BILL INDN:TEST USER CO ID:PAYPALTEST WEB',
      originalCategory: null,
      transactionKind: 'activity',
    },
    {
      id: 3,
      ledgerTransactionId: 'paypal_uber',
      accountName: 'BofA Checking',
      accountInstitution: 'Bank of America',
      accountType: 'checking',
      date: '2026-04-17',
      amountCents: -3293,
      description: 'PAYPAL DES:PURCHASE ID:UBER INDN:TEST USER CO ID:PAYPALTEST WEB',
      merchant: 'PAYPAL DES:PURCHASE ID:UBER INDN:TEST USER CO ID:PAYPALTEST WEB',
      originalDescription: 'PAYPAL DES:PURCHASE ID:UBER INDN:TEST USER CO ID:PAYPALTEST WEB',
      originalCategory: null,
      transactionKind: 'activity',
    },
    {
      id: 4,
      ledgerTransactionId: 'paypal_digital_ocean',
      accountName: 'BofA Checking',
      accountInstitution: 'Bank of America',
      accountType: 'checking',
      date: '2025-12-04',
      amountCents: -171,
      description: 'PAYPAL *DIGITALOCEA 4029357733 NY',
      merchant: 'PAYPAL *DIGITALOCEA 4029357733 NY',
      originalDescription: 'PAYPAL *DIGITALOCEA 4029357733 NY',
      originalCategory: null,
      transactionKind: 'activity',
    },
  ]);

  expect(groups.map(group => ({
    merchantName: group.merchantName,
    transactionIds: group.transactionIds,
  }))).toEqual([
    { merchantName: 'Apple Com Bill', transactionIds: ['paypal_apple_purchase', 'paypal_apple_inst_xfer'] },
    { merchantName: 'Uber', transactionIds: ['paypal_uber'] },
    { merchantName: 'Digitalocea', transactionIds: ['paypal_digital_ocean'] },
  ]);
});

test('ai categorization reviews investment-account transfer decisions instead of auto-applying transfer', () => {
  const [cashTransferGroup] = groupTransactionsForAiCategorization([
    {
      id: 1,
      ledgerTransactionId: 'sequoia_transfer_1',
      accountName: 'BofA Checking',
      accountInstitution: 'Bank of America',
      accountType: 'checking',
      date: '2026-06-01',
      amountCents: -40000,
      description: '0051 SEQUOIA DES:INVESTMENT ID:111111 INDN:TEST USER CO WEB',
      merchant: '0051 Sequoia Des Investment Indn Test User Co Web',
      originalDescription: '0051 SEQUOIA DES:INVESTMENT ID:111111 INDN:TEST USER CO WEB',
      originalCategory: null,
      transactionKind: 'activity',
    },
  ]);
  const [investmentAccountGroup] = groupTransactionsForAiCategorization([
    {
      id: 2,
      ledgerTransactionId: 'vanguard_buy_1',
      accountName: 'Brokerage',
      accountInstitution: 'Vanguard',
      accountType: 'investment',
      date: '2026-06-01',
      amountCents: -40000,
      description: 'Buy Vanguard Total Stock Market Index Fund',
      merchant: 'Buy Vanguard Total Stock Market Index Fund',
      originalDescription: 'Buy Vanguard Total Stock Market Index Fund',
      originalCategory: null,
      transactionKind: 'activity',
    },
  ]);
  const [retirementContributionGroup] = groupTransactionsForAiCategorization([
    {
      id: 3,
      ledgerTransactionId: 'fidelity_401k_contribution_1',
      accountName: 'Fidelity 401(k)',
      accountInstitution: 'Fidelity',
      accountType: '401k',
      date: '2026-05-31',
      amountCents: 250000,
      description: '401(k) contributions (employee + employer)',
      merchant: '401(k) contributions (employee + employer)',
      originalDescription: '401(k) contributions (employee + employer)',
      originalCategory: null,
      transactionKind: 'activity',
    },
  ]);
  const investmentCategory = {
    id: 1,
    name: 'Investment',
    parentId: null,
    type: 'investment',
    categoryGroup: 'savings_investment',
    description: null,
    color: '#f59e0b',
    icon: 'trending-up',
  };

  expect(shouldTreatInvestmentCategoryAsTransfer({
    group: cashTransferGroup!,
    category: investmentCategory,
  })).toBe(true);
  expect(shouldTreatInvestmentCategoryAsTransfer({
    group: investmentAccountGroup!,
    category: investmentCategory,
  })).toBe(false);
  expect(shouldReviewInvestmentAccountTransferDecision({
    group: retirementContributionGroup!,
  })).toBe(true);
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
  expect(report.currentNetWorth).toBe(800);
  expect(report.history).toEqual([{ month: '2026-05', netWorth: 800 }]);
  expect(report.percentChange).toBeCloseTo(0);
});

test('investment report endpoints expose money-style ledger reports', async () => {
  const accountId = Number(insertRow('accounts', {
    name: 'Brokerage',
    institution: 'Vanguard',
    type: 'investment',
    accountHolder: 'Alex',
    currentBalance: 0,
  }));
  insertRow('ledgerTransactions', {
    ledgerTransactionId: 'txn_report_contribution',
    accountId,
    date: '2026-01-15',
    amountCents: 100000,
    description: 'ACH contribution',
    sourceRole: 'activity',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  insertRow('ledgerTransactions', {
    ledgerTransactionId: 'txn_report_dividend',
    accountId,
    date: '2026-02-15',
    amountCents: 5000,
    description: 'Dividend received',
    sourceRole: 'activity',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  insertRow('ledgerBalances', {
    accountId,
    month: '2026-01',
    balanceCents: 100000,
    capturedAt: '2026-01-31T00:00:00.000Z',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  insertRow('ledgerBalances', {
    accountId,
    month: '2026-02',
    balanceCents: 112000,
    capturedAt: '2026-02-28T00:00:00.000Z',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const netWorth = await getJson('/api/networth') as {
    accounts: Array<{ id: number; name: string; institution: string; type: string; account_holder: string | null }>;
    rows: Array<{
      month: string;
      account_id: number;
      contributions_cents: number;
      dividends_cents: number;
      gains_cents: number | null;
      end_balance_cents: number | null;
    }>;
    returns: Array<{ account_id: number; ending_balance_cents: number }>;
  };
  expect(netWorth.accounts).toContainEqual(expect.objectContaining({
    id: accountId,
    name: 'Brokerage',
    institution: 'Vanguard',
    type: 'investment',
    account_holder: 'Alex',
  }));
  expect(netWorth.rows).toContainEqual(expect.objectContaining({
    month: '2026-01',
    account_id: accountId,
    contributions_cents: 100000,
    end_balance_cents: 100000,
  }));
  expect(netWorth.rows).toContainEqual(expect.objectContaining({
    month: '2026-02',
    account_id: accountId,
    dividends_cents: 5000,
    gains_cents: 7000,
    end_balance_cents: 112000,
  }));
  expect(netWorth.returns).toContainEqual(expect.objectContaining({
    account_id: accountId,
    ending_balance_cents: 112000,
  }));

  const savingsRate = await getJson('/api/savings-rate') as {
    account_months: Array<{
      account_id: number;
      month: string;
      income_cents: number;
      market_income_cents: number;
      investment_delta_cents: number;
    }>;
    income_sources: Array<{ label: string; amount_cents: number; is_market_income: boolean }>;
  };
  expect(savingsRate.account_months).toContainEqual(expect.objectContaining({
    account_id: accountId,
    month: '2026-02',
    income_cents: 5000,
    market_income_cents: 5000,
    investment_delta_cents: 0,
  }));
  expect(savingsRate.income_sources).toContainEqual(expect.objectContaining({
    label: 'Dividends',
    amount_cents: 5000,
    is_market_income: true,
  }));
});

test('investment report carries basis and gains across Roth IRA transfers', async () => {
  const fidelityRothId = Number(insertRow('accounts', {
    name: 'Roth Individual',
    institution: 'Fidelity',
    type: 'investment',
    currentBalance: 0,
  }));
  const robinhoodRothId = Number(insertRow('accounts', {
    name: 'Robinhood Roth IRA - 8978',
    institution: 'Robinhood',
    type: 'investment',
    currentBalance: 0,
  }));
  const now = new Date().toISOString();

  for (const row of [
    { accountId: fidelityRothId, month: '2023-01', balanceCents: 943634, capturedAt: '2023-01-31T00:00:00.000Z' },
    { accountId: fidelityRothId, month: '2024-03', balanceCents: 3760135, capturedAt: '2024-03-31T00:00:00.000Z' },
    { accountId: fidelityRothId, month: '2024-04', balanceCents: 52074, capturedAt: '2024-04-30T00:00:00.000Z' },
    { accountId: robinhoodRothId, month: '2024-04', balanceCents: 3565305, capturedAt: '2024-04-30T00:00:00.000Z' },
  ]) {
    insertRow('ledgerBalances', {
      ...row,
      createdAt: now,
      updatedAt: now,
    });
  }

  for (const row of [
    {
      ledgerTransactionId: 'fidelity-roth-acat-out',
      accountId: fidelityRothId,
      date: '2024-04-22',
      amountCents: -3626685,
      description: 'Fidelity transfer out: securities transferred out',
    },
    {
      ledgerTransactionId: 'robinhood-roth-acat-cash-in',
      accountId: robinhoodRothId,
      date: '2024-04-22',
      amountCents: 2122,
      description: 'ACATI ACAT IN control_num = 20241070049362',
    },
    {
      ledgerTransactionId: 'robinhood-roth-match',
      accountId: robinhoodRothId,
      date: '2024-04-22',
      amountCents: 108271,
      description: 'MTCH Interest on Contribution (IRA Match)',
    },
    {
      ledgerTransactionId: 'robinhood-roth-spy-buy',
      accountId: robinhoodRothId,
      date: '2024-04-22',
      amountCents: -110393,
      description: 'Buy SPDR S&P 500 ETF',
    },
  ]) {
    insertRow('ledgerTransactions', {
      ...row,
      sourceRole: 'activity',
      createdAt: now,
      updatedAt: now,
    });
  }

  const netWorth = await getJson('/api/networth') as {
    rows: Array<{
      month: string;
      account_id: number;
      contributions_cents: number;
      interest_cents: number;
      gains_cents: number | null;
      end_balance_cents: number | null;
    }>;
    transfer_links: Array<{
      source_account_id: number;
      destination_account_id: number;
      amount_cents: number;
      basis_cents: number;
      gains_cents: number;
    }>;
  };

  expect(netWorth.transfer_links).toContainEqual(expect.objectContaining({
    source_account_id: fidelityRothId,
    destination_account_id: robinhoodRothId,
    amount_cents: 3457034,
    basis_cents: 943634,
    gains_cents: 2513400,
  }));
  expect(netWorth.rows).toContainEqual(expect.objectContaining({
    month: '2024-04',
    account_id: robinhoodRothId,
    contributions_cents: 943634,
    interest_cents: 108271,
    gains_cents: 2513400,
    end_balance_cents: 3565305,
  }));
  expect(netWorth.rows).toContainEqual(expect.objectContaining({
    month: '2024-04',
    account_id: fidelityRothId,
    contributions_cents: -943634,
    gains_cents: -2764427,
    end_balance_cents: 52074,
  }));
});

test('net worth uses balance snapshots rather than transaction activity for cash accounts', async () => {
  const checkingWithoutBalancesId = Number(insertRow('accounts', {
    name: 'CSV-only Checking',
    institution: 'Wells Fargo',
    type: 'checking',
    currentBalance: 0,
  }));
  const checkingWithBalancesId = Number(insertRow('accounts', {
    name: 'Statement Checking',
    institution: 'Wells Fargo',
    type: 'checking',
    currentBalance: 0,
  }));
  const now = new Date().toISOString();

  for (const row of [
    {
      ledgerTransactionId: 'csv-only-checking-spend',
      accountId: checkingWithoutBalancesId,
      date: '2026-01-10',
      amountCents: -2500,
      description: 'Coffee shop',
    },
    {
      ledgerTransactionId: 'statement-checking-payroll',
      accountId: checkingWithBalancesId,
      date: '2026-01-15',
      amountCents: 100000,
      description: 'Payroll deposit',
    },
    {
      ledgerTransactionId: 'statement-checking-rent',
      accountId: checkingWithBalancesId,
      date: '2026-02-01',
      amountCents: -180000,
      description: 'Rent payment',
    },
  ]) {
    insertRow('ledgerTransactions', {
      ...row,
      sourceRole: 'activity',
      createdAt: now,
      updatedAt: now,
    });
  }

  for (const row of [
    { accountId: checkingWithBalancesId, month: '2026-01', balanceCents: 500000, capturedAt: '2026-01-31T00:00:00.000Z' },
    { accountId: checkingWithBalancesId, month: '2026-02', balanceCents: 425000, capturedAt: '2026-02-28T00:00:00.000Z' },
  ]) {
    insertRow('ledgerBalances', {
      ...row,
      createdAt: now,
      updatedAt: now,
    });
  }

  const netWorth = await getJson('/api/networth') as {
    rows: Array<{
      month: string;
      account_id: number;
      contributions_cents: number;
      gains_cents: number | null;
      end_balance_cents: number | null;
    }>;
  };

  expect(netWorth.rows.some(row => row.account_id === checkingWithoutBalancesId)).toBe(false);
  expect(netWorth.rows).toContainEqual(expect.objectContaining({
    month: '2026-01',
    account_id: checkingWithBalancesId,
    contributions_cents: 500000,
    gains_cents: 0,
    end_balance_cents: 500000,
  }));
  expect(netWorth.rows).toContainEqual(expect.objectContaining({
    month: '2026-02',
    account_id: checkingWithBalancesId,
    contributions_cents: -75000,
    gains_cents: 0,
    end_balance_cents: 425000,
  }));
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

test('app import history lists committed files and can unimport one', async () => {
  const csv = fs.readFileSync(path.resolve(import.meta.dir, '..', '..', 'sample-imports', 'chase-credit-card-demo.csv'), 'utf8');
  const accountId = insertRow('accounts', {
    name: 'Chase Sapphire',
    institution: 'Chase',
    type: 'credit',
    currentBalance: 100,
  });
  const preview = await postImportPreview('chase-credit-card-demo.csv', csv);

  await postJson('/api/app/imports/commit', {
    accountId,
    importFileId: preview.importFileId,
    importRowIds: preview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
  }, 201);
  const annotatedTransaction = getDb().prepare(`
    SELECT ledgerTransactionId
    FROM ledgerTransactions
    WHERE importFileId = ?
    ORDER BY ledgerTransactionId ASC
    LIMIT 1
  `).get(preview.importFileId) as { ledgerTransactionId: string };
  insertRow('transactionAnnotations', {
    ledgerTransactionId: annotatedTransaction.ledgerTransactionId,
    notes: 'keep this user note',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const history = await getJson('/api/app/imports') as {
    imports: Array<{
      id: number;
      fileName: string;
      status: string;
      transactionCount: number;
    }>;
  };
  expect(history.imports[0]).toMatchObject({
    id: preview.importFileId,
    fileName: 'chase-credit-card-demo.csv',
    status: 'committed',
    transactionCount: 10,
  });

  await deleteJson(`/api/app/imports/${preview.importFileId}`);

  expect(getDb().prepare('SELECT COUNT(*) AS count FROM transactions WHERE accountId = ?').get(accountId)).toMatchObject({ count: 0 });
  expect(getDb().prepare('SELECT COUNT(*) AS count FROM ledgerTransactions WHERE accountId = ?').get(accountId)).toMatchObject({ count: 0 });
  expect(getDb().prepare('SELECT status FROM importFiles WHERE id = ?').get(preview.importFileId)).toMatchObject({ status: 'unimported' });
  expect(getDb().prepare('SELECT status FROM sourceFiles WHERE importFileId = ?').get(preview.importFileId)).toMatchObject({ status: 'unimported' });
  expect(getDb().prepare('SELECT accountId FROM sourceAccounts WHERE sourceFileId = (SELECT id FROM sourceFiles WHERE importFileId = ?)').get(preview.importFileId)).toMatchObject({ accountId });
  expect(getDb().prepare('SELECT notes FROM transactionAnnotations WHERE ledgerTransactionId = ?').get(annotatedTransaction.ledgerTransactionId)).toMatchObject({
    notes: 'keep this user note',
  });

  const reimport = await postJson(`/api/app/imports/${preview.importFileId}/reimport`, {});
  expect(reimport).toMatchObject({
    ok: true,
    importFileId: preview.importFileId,
    transactionCount: 10,
  });
  expect(getDb().prepare('SELECT COUNT(*) AS count FROM transactions WHERE accountId = ?').get(accountId)).toMatchObject({ count: 10 });
  expect(getDb().prepare('SELECT status FROM importFiles WHERE id = ?').get(preview.importFileId)).toMatchObject({ status: 'committed' });
  expect(getDb().prepare('SELECT status FROM sourceFiles WHERE importFileId = ?').get(preview.importFileId)).toMatchObject({ status: 'committed' });
  expect(getDb().prepare('SELECT accountId FROM sourceAccounts WHERE sourceFileId = (SELECT id FROM sourceFiles WHERE importFileId = ?)').get(preview.importFileId)).toMatchObject({ accountId });
  expect(getDb().prepare('SELECT notes FROM transactionAnnotations WHERE ledgerTransactionId = ?').get(annotatedTransaction.ledgerTransactionId)).toMatchObject({
    notes: 'keep this user note',
  });
});

test('app import history can bulk unimport and reimport committed source facts', async () => {
  const accountId = insertRow('accounts', {
    name: 'Chase Sapphire',
    institution: 'Chase',
    type: 'credit',
    currentBalance: 100,
  });
  const firstCsv = csvFromRows([
    '06/14/2026,06/14/2026,TACO TEMPLE,Food & Drink,Sale,-42.37',
  ]);
  const secondCsv = csvFromRows([
    '06/15/2026,06/15/2026,WHOLE FOODS MARKET,Groceries,Sale,-132.18',
  ]);
  const firstPreview = await postImportPreview('chase-credit-card-first.csv', firstCsv);
  const secondPreview = await postImportPreview('chase-credit-card-second.csv', secondCsv);

  await postJson('/api/app/imports/commit', {
    accountId,
    importFileId: firstPreview.importFileId,
    importRowIds: firstPreview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
  }, 201);
  await postJson('/api/app/imports/commit', {
    accountId,
    importFileId: secondPreview.importFileId,
    importRowIds: secondPreview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
  }, 201);

  expect(getDb().prepare('SELECT COUNT(*) AS count FROM ledgerTransactions WHERE accountId = ?').get(accountId)).toMatchObject({ count: 2 });

  const importFileIds = [firstPreview.importFileId, secondPreview.importFileId];
  const unimport = await postJson('/api/app/imports/bulk-unimport', { importFileIds });
  expect(unimport).toMatchObject({ ok: true, count: 2, importFileIds });
  expect(getDb().prepare('SELECT COUNT(*) AS count FROM ledgerTransactions WHERE accountId = ?').get(accountId)).toMatchObject({ count: 0 });
  expect(getDb().prepare("SELECT COUNT(*) AS count FROM importFiles WHERE status = 'unimported'").get()).toMatchObject({ count: 2 });
  expect(getDb().prepare('SELECT COUNT(*) AS count FROM sourceAccounts WHERE accountId = ?').get(accountId)).toMatchObject({ count: 2 });

  const reimport = await postJson('/api/app/imports/bulk-reimport', { importFileIds });
  expect(reimport).toMatchObject({ ok: true, count: 2, importFileIds, transactionCount: 2 });
  expect(getDb().prepare('SELECT COUNT(*) AS count FROM ledgerTransactions WHERE accountId = ?').get(accountId)).toMatchObject({ count: 2 });
  expect(getDb().prepare("SELECT COUNT(*) AS count FROM importFiles WHERE status = 'committed'").get()).toMatchObject({ count: 2 });
  expect(getDb().prepare('SELECT COUNT(*) AS count FROM sourceAccounts WHERE accountId = ?').get(accountId)).toMatchObject({ count: 2 });
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
    resolvedAccountStatus: null,
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

test('app import preview reports archived matches and commit requires explicit unarchive decision', async () => {
  const archivedAccountId = Number(insertRow('accounts', {
    name: 'Adv Plus Banking - 1234',
    institution: 'Bank of America',
    type: 'checking',
    currentBalance: 0,
    currency: 'USD',
    status: 'archived',
    archivedAt: '2026-06-01T00:00:00.000Z',
  }));
  insertRow('accountAliases', {
    institution: 'Bank of America',
    alias: 'Adv Plus Banking - 1234',
    accountId: archivedAccountId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const preview = await postImportPreview('bofa-checking-1234-2026-01-01-to-2026-01-31.csv', [
    'Description,,Summary Amt.',
    'Opening Balance,,"1,000.00"',
    'Date,Description,Amount,Running Bal.',
    '01/05/2026,TRANSFER IN,"1,500.00","2,500.00"',
  ].join('\n'));

  expect(preview.accountMappings[0]).toMatchObject({
    resolvedAccountId: archivedAccountId,
    resolvedAccountStatus: 'archived',
    resolution: 'archived-match',
  });

  const rejected = await fetch(`${TEST_URL}/api/app/imports/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
    accountId: null,
    importFileId: preview.importFileId,
    importRowIds: preview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
    accountMappings: [{ sourceAccountId: preview.accountMappings[0].sourceAccountId, mode: 'auto' }],
    }),
  });
  expect(rejected.status).toBe(500);

  const commit = await postJson('/api/app/imports/commit', {
    accountId: null,
    importFileId: preview.importFileId,
    importRowIds: preview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
    balanceRowIds: preview.balanceRowIds,
    accountMappings: [{
      sourceAccountId: preview.accountMappings[0].sourceAccountId,
      mode: 'unarchive',
      accountId: archivedAccountId,
    }],
  }, 201);

  expect(commit.importedCount).toBe(1);
  expect(getDb().prepare('SELECT status, archivedAt FROM accounts WHERE id = ?').get(archivedAccountId)).toMatchObject({
    status: 'active',
    archivedAt: null,
  });
  expect(getDb().prepare('SELECT accountId FROM sourceAccounts WHERE id = ?').get(preview.accountMappings[0].sourceAccountId)).toMatchObject({
    accountId: archivedAccountId,
  });
});

test('app imports commit creates accounts from explicit source account mapping decisions', async () => {
  const preview = await postImportPreview('bofa-savings-4321-2026-01-01-to-2026-01-31.csv', [
    'Description,,Summary Amt.',
    'Opening Balance,,"1,000.00"',
    'Date,Description,Amount,Running Bal.',
    '01/05/2026,TRANSFER IN,"1,500.00","2,500.00"',
  ].join('\n'));

  const commit = await postJson('/api/app/imports/commit', {
    accountId: null,
    importFileId: preview.importFileId,
    importRowIds: preview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
    balanceRowIds: preview.balanceRowIds,
    accountMappings: [{
      sourceAccountId: preview.accountMappings[0].sourceAccountId,
      mode: 'create',
      account: {
        name: 'Imported Savings',
        institution: 'Bank of America',
        type: 'savings',
        currency: 'USD',
      },
    }],
  }, 201);

  expect(commit.importedCount).toBe(1);
  const account = getDb().prepare("SELECT * FROM accounts WHERE name = 'Imported Savings'").get() as {
    id: number;
    institution: string;
    type: string;
    status: string;
  };
  expect(account).toMatchObject({
    institution: 'Bank of America',
    type: 'savings',
    status: 'active',
  });
  expect(getDb().prepare('SELECT accountId FROM sourceAccounts WHERE id = ?').get(preview.accountMappings[0].sourceAccountId)).toMatchObject({
    accountId: account.id,
  });
  expect(getDb().prepare('SELECT accountId FROM accountAliases WHERE alias = ?').get('Advantage Savings - 4321')).toMatchObject({
    accountId: account.id,
  });
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
