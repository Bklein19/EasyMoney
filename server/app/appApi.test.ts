import { afterAll, beforeEach, expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';

process.env.EASYMONEY_DB_PATH = path.join(os.tmpdir(), `easymoney-app-api-${process.pid}.sqlite`);

const { createServer } = await import('../index.js');
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
  insertRow('transactions', {
    accountId,
    categoryId,
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

  insertRow('transactions', {
    accountId,
    categoryId: foodId,
    date: '2026-06-14',
    amount: -20,
    description: 'Cafe',
    merchant: 'Blue Cafe',
    type: 'expense',
  });
  insertRow('transactions', {
    accountId,
    categoryId: incomeId,
    date: '2026-06-15',
    amount: 100,
    description: 'Payroll',
    merchant: 'Employer',
    type: 'income',
  });

  const body = await getJson('/api/app/transactions?type=expense&search=cafe&startDate=2026-06-01&endDate=2026-06-30');

  expect(body.transactions.map((transaction: { description: string }) => transaction.description)).toEqual(['Cafe']);
});
