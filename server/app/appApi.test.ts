import { beforeEach, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.EASYMONEY_DB_PATH = path.join(os.tmpdir(), `easymoney-app-api-${process.pid}.sqlite`);
process.env.EASYMONEY_SYNC_ROOT = path.join(os.tmpdir(), `easymoney-sync-runs-${process.pid}`);

const { appRouter } = await import('./router.ts');
const { getDb, initDatabase, insertRow } = await import('../database.ts');
const { buildLedgerFromSourceFacts, ledgerFingerprint, materializeLedger } = await import('./ledgerRebuild.ts');
const { buildSyncArtifactReview, stageSyncArtifact } = await import('./dataSync/review.ts');
const { upsertTransactionAnnotation } = await import('./transactionAnnotations.ts');
const {
  groupTransactionsForAiCategorization,
  shouldTreatInvestmentCategoryAsTransfer,
  shouldReviewInvestmentAccountTransferDecision,
} = await import('./aiCategorization.ts');
const caller = appRouter.createCaller({});

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

async function postImportPreview(fileName: string, text: string, profile: unknown = null): Promise<any> {
  const fileBytes = new TextEncoder().encode(text);
  const fileBase64 = Buffer.from(fileBytes).toString('base64');
  return caller.imports.preview({
    fileName,
    text,
    fileBase64,
    customProfile: profile,
  });
}

async function updateTransactionForTest(
  transactionId: number | string,
  changes: { categoryId?: number | string | null; notes?: string | null }
) {
  upsertTransactionAnnotation(transactionId, changes);
  return { ok: true };
}

const listAccountsForTest = (input?: { includeArchived?: boolean }): Promise<any> => caller.accounts.list(input);
const listCategoriesForTest = (): Promise<any> => caller.categories.list();
const listTransactionsForTest = (input?: Parameters<typeof caller.transactions.list>[0]): Promise<any> =>
  caller.transactions.list(input);
const netWorthReportForTest = (): Promise<any> => caller.reports.netWorth();
const savingsRateReportForTest = (): Promise<any> => caller.reports.savingsRate();
const listImportHistoryForTest = (): Promise<any> => caller.imports.history();
const dataFreshnessForTest = (today?: string): Promise<any> => caller.dataFreshness.report(today ? { today } : undefined);
const dataCatchUpForTest = (today?: string): Promise<any> => caller.dataFreshness.catchUp(today ? { today } : undefined);
const commitImportForTest = (input: Parameters<typeof caller.imports.commit>[0]): Promise<any> =>
  caller.imports.commit(input);

function csvFromRows(rows: string[]) {
  return [
    'Transaction Date,Post Date,Description,Category,Type,Amount',
    ...rows,
  ].join('\n');
}

async function saveAwaitingSyncReview(review: {
  runId: string;
  institutionId: 'bank-of-america' | 'vanguard' | 'sequoia-fund';
  downloaded: number;
  readyToImport: number;
  alreadyImported: number;
  artifacts: unknown[];
}) {
  const directory = path.join(process.env.EASYMONEY_SYNC_ROOT!, review.runId);
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(path.join(directory, 'run.json'), `${JSON.stringify({
    runId: review.runId,
    institutionId: review.institutionId,
    goal: { kind: 'current', overlapDays: 7 },
    status: 'awaiting-confirmation',
    message: 'Downloads are ready to review',
    startedAt: '2026-08-19T00:00:00.000Z',
    completedAt: null,
    events: [],
    review,
    result: null,
    error: null,
  }, null, 2)}\n`);
}

let consolidatedSyncFixtureSequence = 0;

function stageConsolidatedSyncFacts(claims: Array<{
  remoteAccountId: string;
  accountName: string;
  amountCents?: number;
  balanceCents?: number;
}>, requestedFileName?: string) {
  const fileName = requestedFileName || `consolidated-${++consolidatedSyncFixtureSequence}.csv`;
  const createdAt = '2026-08-20T00:00:00.000Z';
  const importFileId = Number(insertRow('importFiles', {
    fileName,
    contentHash: `hash-${fileName}`,
    parserName: 'test-consolidated-parser',
    sourceType: 'activity-export',
    institution: 'Example Institution',
    status: 'previewed',
    createdAt,
  }));
  const sourceFileId = Number(insertRow('sourceFiles', {
    importFileId,
    fileName,
    contentHash: `hash-${fileName}`,
    parserName: 'test-consolidated-parser',
    sourceType: 'activity-export',
    institution: 'Example Institution',
    coveredFrom: '2026-08-01',
    coveredTo: '2026-08-01',
    status: 'previewed',
    createdAt,
  }));
  const sourceAccountIds = claims.map((claim, index) => {
    const sourceAccountId = Number(insertRow('sourceAccounts', {
      sourceFileId,
      institution: 'Example Institution',
      sourceAccountKey: claim.remoteAccountId,
      sourceAccountName: claim.accountName,
      rawJson: JSON.stringify({ remoteAccountId: claim.remoteAccountId }),
      createdAt,
    }));
    const amountCents = claim.amountCents ?? (index + 1) * 1000;
    const importRowId = Number(insertRow('importRows', {
      importFileId,
      rowIndex: index,
      rowType: 'transaction',
      rawJson: '{}',
      normalizedJson: JSON.stringify({
        sourceRowIndex: index,
        date: '2026-08-01',
        amountCents,
        description: `Example transaction ${index + 1}`,
        institution: 'Example Institution',
        account: claim.accountName,
        remoteAccountId: claim.remoteAccountId,
        sourceRole: 'activity',
        raw: {},
      }),
      createdAt,
    }));
    insertRow('sourceTransactions', {
      sourceFileId,
      sourceAccountId,
      importRowId,
      stableSourceId: `${claim.remoteAccountId}:transaction`,
      date: '2026-08-01',
      amountCents,
      description: `Example transaction ${index + 1}`,
      sourceRole: 'activity',
      rawJson: '{}',
      createdAt,
    });
    if (claim.balanceCents !== undefined) {
      const balanceRowId = Number(insertRow('importRows', {
        importFileId,
        rowIndex: claims.length + index,
        rowType: 'balance',
        rawJson: '{}',
        normalizedJson: JSON.stringify({
          sourceRowIndex: null,
          date: '2026-08-01',
          balanceCents: claim.balanceCents,
          institution: 'Example Institution',
          account: claim.accountName,
          remoteAccountId: claim.remoteAccountId,
          raw: {},
        }),
        createdAt,
      }));
      insertRow('sourceBalances', {
        sourceFileId,
        sourceAccountId,
        importRowId: balanceRowId,
        date: '2026-08-01',
        balanceCents: claim.balanceCents,
        rawJson: '{}',
        createdAt,
      });
    }
    return sourceAccountId;
  });
  return { importFileId, sourceAccountIds, fileName };
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

test('init database records source account owner schema migration', () => {
  const migration = getDb().prepare(
    "SELECT name FROM schemaMigrations WHERE name = '2026-07-06-source-account-owner'"
  ).get() as { name: string } | undefined;
  const sourceAccountColumns = getDb().prepare('PRAGMA table_info(sourceAccounts)').all() as Array<{ name: string }>;

  expect(migration).toEqual({ name: '2026-07-06-source-account-owner' });
  expect(sourceAccountColumns.map(column => column.name)).toContain('accountHolder');
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
    accountHolder: 'Example Owner',
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

  const body = await listAccountsForTest();

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
        accountHolder: 'Example Owner',
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

  const body = await listAccountsForTest() as {
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

  await caller.accounts.updateMetadata({ id: accountId, changes: { accountHolder: 'Example Owner' } });
  expect(await listAccountsForTest()).toMatchObject({
    accounts: [expect.objectContaining({
      id: accountId,
      accountHolder: 'Example Owner',
    })],
  });

  await caller.accounts.updateMetadata({ id: accountId, changes: { accountHolder: '' } });
  expect(await listAccountsForTest()).toMatchObject({
    accounts: [expect.objectContaining({
      id: accountId,
      accountHolder: null,
    })],
  });
});

test('trpc accounts mutations update metadata and archive state', async () => {
  const accountId = Number(insertRow('accounts', {
    name: 'TRPC Checking',
    institution: 'Bank',
    type: 'checking',
    currentBalance: 0,
  }));

  await caller.accounts.updateMetadata({
    id: accountId,
    changes: { name: 'TRPC Cash', accountHolder: 'M' },
  });
  expect(await caller.accounts.list()).toMatchObject({
    accounts: [expect.objectContaining({ id: accountId, name: 'TRPC Cash', accountHolder: 'M' })],
  });

  await caller.accounts.archive({ id: accountId });
  expect(await caller.accounts.list()).toMatchObject({ accounts: [] });
  expect(await caller.accounts.list({ includeArchived: true })).toMatchObject({
    accounts: [expect.objectContaining({ id: accountId, status: 'archived' })],
  });

  await caller.accounts.unarchive({ id: accountId });
  expect(await caller.accounts.list()).toMatchObject({
    accounts: [expect.objectContaining({ id: accountId, status: 'active' })],
  });

  await caller.accounts.markClosed({ id: accountId });
  expect(await caller.accounts.list()).toMatchObject({
    accounts: [expect.objectContaining({ id: accountId, status: 'closed', isClosed: true })],
  });

  await caller.accounts.unarchive({ id: accountId });
  expect(await caller.accounts.list()).toMatchObject({
    accounts: [expect.objectContaining({ id: accountId, status: 'active' })],
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

  await caller.accounts.archive({ id: accountId });

  expect(await listAccountsForTest()).toEqual({ accounts: [] });
  const withArchived = await listAccountsForTest({ includeArchived: true }) as { accounts: Array<{ id: number; status: string; archivedAt: string | null }> };
  expect(withArchived.accounts).toMatchObject([{ id: accountId, status: 'archived' }]);
  expect(withArchived.accounts[0].archivedAt).toEqual(expect.any(String));
  expect(await listTransactionsForTest()).toMatchObject({ transactions: [] });
  expect(getDb().prepare('SELECT accountId FROM sourceAccounts WHERE id = ?').get(sourceAccountId)).toMatchObject({ accountId });
  expect(getDb().prepare('SELECT notes FROM transactionAnnotations WHERE ledgerTransactionId = ?').get(ledgerTransaction.ledgerTransactionId)).toMatchObject({
    notes: 'keep archived note',
  });

  await caller.accounts.unarchive({ id: accountId });
  expect(await listAccountsForTest()).toMatchObject({
    accounts: [expect.objectContaining({ id: accountId, status: 'active', archivedAt: null })],
  });
  await caller.accounts.updateMetadata({ id: accountId, changes: { name: 'Archive Restored' } });
  expect(await listAccountsForTest()).toMatchObject({
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

  const body = await listCategoriesForTest();

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

test('category delete reassigns annotations to Uncategorized and protects Uncategorized', async () => {
  const accountId = insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
  });
  const uncategorizedId = insertRow('categories', { name: 'Uncategorized', type: 'expense' });
  const groceriesId = insertRow('categories', { name: 'Groceries', type: 'expense' });
  const transactionId = insertRow('transactions', {
    accountId,
    date: '2026-06-16',
    amount: -25,
    description: 'Market',
    type: 'expense',
  });
  await updateTransactionForTest(transactionId, { categoryId: groceriesId });

  await caller.categories.delete({ id: groceriesId });

  expect(getDb().prepare('SELECT id FROM categories WHERE id = ?').get(groceriesId)).toBeNull();
  expect(getDb().prepare('SELECT categoryId FROM transactionAnnotations').get()).toEqual({
    categoryId: uncategorizedId,
  });

  await expect(caller.categories.delete({ id: uncategorizedId })).rejects.toThrow('Uncategorized cannot be deleted.');
  expect(getDb().prepare('SELECT id FROM categories WHERE id = ?').get(uncategorizedId)).toEqual({
    id: uncategorizedId,
  });
});

test('trpc categories and categorization rules expose typed crud', async () => {
  const created = await caller.categories.create({
    name: 'TRPC Category',
    type: 'expense',
    categoryGroup: 'variable',
    description: 'Created through tRPC',
    color: '#123456',
    icon: 'tag',
  });
  await caller.categories.update({
    id: created.id,
    name: 'TRPC Category Updated',
    description: 'Updated through tRPC',
  });
  expect(await caller.categories.list()).toMatchObject({
    categories: [expect.objectContaining({
      id: created.id,
      name: 'TRPC Category Updated',
      description: 'Updated through tRPC',
    })],
  });

  const rule = await caller.categorizationRules.create({
    categoryId: created.id,
    pattern: 'trpc-rule',
    matchType: 'contains',
    priority: 42,
  });
  await caller.categorizationRules.update({ id: rule.id, priority: 84 });
  expect(await caller.categorizationRules.list()).toEqual([
    expect.objectContaining({ id: rule.id, categoryId: created.id, pattern: 'trpc-rule', priority: 84 }),
  ]);
  await caller.categorizationRules.delete({ id: rule.id });
  expect(await caller.categorizationRules.list()).toEqual([]);

  await caller.categories.delete({ id: created.id });
  expect((await caller.categories.list()).categories).toEqual([]);
});

test('trpc category delete reassigns annotations to Uncategorized', async () => {
  const accountId = insertRow('accounts', {
    name: 'Checking',
    type: 'checking',
    currentBalance: 0,
  });
  const uncategorizedId = insertRow('categories', { name: 'Uncategorized', type: 'expense' });
  const diningId = insertRow('categories', { name: 'Dining', type: 'expense' });
  insertRow('transactions', {
    accountId,
    date: '2026-06-01',
    amount: -12,
    description: 'Dinner',
    ledgerTransactionId: 'trpc-category-delete',
  });
  insertRow('transactionAnnotations', {
    ledgerTransactionId: 'trpc-category-delete',
    categoryId: diningId,
  });

  await caller.categories.delete({ id: diningId });
  expect(getDb().prepare('SELECT categoryId FROM transactionAnnotations WHERE ledgerTransactionId = ?').get('trpc-category-delete')).toMatchObject({
    categoryId: uncategorizedId,
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
  await updateTransactionForTest(transactionId, {
    categoryId,
    notes: 'weekly shop',
  });

  const body = await listTransactionsForTest();

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
  await updateTransactionForTest(cafeId, { categoryId: foodId });

  const payrollId = insertRow('transactions', {
    accountId,
    date: '2026-06-15',
    amount: 100,
    description: 'Payroll',
    merchant: 'Employer',
    type: 'income',
  });
  await updateTransactionForTest(payrollId, { categoryId: incomeId });

  const body = await listTransactionsForTest({
    type: 'expense',
    search: 'cafe',
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  });

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

  const firstPage = await listTransactionsForTest({ limit: 2, offset: 0 }) as {
    transactions: Array<{ description: string }>;
    totalCount: number;
    hasMore: boolean;
    nextOffset: number | null;
    totals: { income: number; expenses: number; net: number };
  };
  const secondPage = await listTransactionsForTest({ limit: 2, offset: 2 }) as {
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

test('trpc transaction totals classify bank-side card payments and investment transfers outside spending', async () => {
  const checkingId = insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
  });
  insertRow('accounts', {
    name: 'Chase Sapphire',
    institution: 'Chase',
    type: 'credit-card',
  });
  insertRow('accounts', {
    name: 'Vanguard Brokerage',
    institution: 'Vanguard',
    type: 'investment',
  });

  insertRow('transactions', {
    accountId: checkingId,
    date: '2026-06-16',
    amount: -300,
    description: 'CHASE CREDIT CARD PAYMENT',
    merchant: 'Chase Card',
    type: 'expense',
  });
  insertRow('transactions', {
    accountId: checkingId,
    date: '2026-06-17',
    amount: -400,
    description: 'VANGUARD BROKERAGE TRANSFER',
    merchant: 'Vanguard',
    type: 'expense',
  });
  insertRow('transactions', {
    accountId: checkingId,
    date: '2026-06-18',
    amount: -25,
    description: 'Coffee',
    merchant: 'Cafe',
    type: 'expense',
  });

  const body = await listTransactionsForTest();

  expect(body.totals).toMatchObject({
    income: 0,
    expenses: 25,
    internalMovement: 300,
    investments: 400,
    net: -25,
  });
});

test('trpc analytics report aggregates backend-owned cashflow semantics', async () => {
  const checkingId = insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
  });
  insertRow('accounts', {
    name: 'Vanguard Brokerage',
    institution: 'Vanguard',
    type: 'investment',
  });
  const diningId = insertRow('categories', {
    name: 'Dining',
    type: 'expense',
    color: '#f97316',
  });
  const incomeId = insertRow('categories', {
    name: 'Income',
    type: 'income',
    color: '#22c55e',
  });

  const cafeId = insertRow('transactions', {
    accountId: checkingId,
    date: '2026-06-10',
    amount: -25,
    description: 'Cafe',
    merchant: 'Blue Cafe',
    type: 'expense',
  });
  await updateTransactionForTest(cafeId, { categoryId: diningId });
  const payrollId = insertRow('transactions', {
    accountId: checkingId,
    date: '2026-06-15',
    amount: 1000,
    description: 'Payroll',
    merchant: 'ACME Payroll',
    type: 'income',
  });
  await updateTransactionForTest(payrollId, { categoryId: incomeId });
  insertRow('transactions', {
    accountId: checkingId,
    date: '2026-06-16',
    amount: -400,
    description: 'VANGUARD BROKERAGE TRANSFER',
    merchant: 'Vanguard',
    type: 'expense',
  });

  const report = await caller.analytics.report({
    startDate: '2026-06-01',
    endDate: '2026-06-30',
    groupMode: 'Monthly',
  });

  expect(report.summary).toMatchObject({
    income: 1000,
    expenses: 25,
    investments: 400,
    net: 975,
    transactionCount: 3,
  });
  expect(report.cashFlow).toEqual([
    expect.objectContaining({
      key: '2026-06',
      income: 1000,
      expenses: 25,
      net: 975,
      categoryAmounts: { Dining: 25 },
    }),
  ]);
  expect(report.spendingByCategory).toEqual([
    expect.objectContaining({ id: String(diningId), name: 'Dining', amount: 25 }),
  ]);
  expect(report.topMerchants).toEqual([
    expect.objectContaining({ name: 'Blue Cafe', amount: 25, count: 1 }),
  ]);
  expect(report.incomeStreams).toEqual([
    expect.objectContaining({ name: 'ACME Payroll', amount: 1000, count: 1 }),
  ]);
  expect(report.investments).toEqual([
    expect.objectContaining({ key: '2026-06', amount: 400 }),
  ]);

  const diningOnly = await caller.analytics.report({
    categoryFilterIds: [diningId],
    categoryFilterMode: 'include',
  });
  expect(diningOnly.summary).toMatchObject({ income: 0, expenses: 25, net: -25 });
});

test('app transactions endpoint supports column sort keys', async () => {
  const checkingId = insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
  });
  const savingsId = insertRow('accounts', {
    name: 'Savings',
    institution: 'Local Bank',
    type: 'savings',
  });
  const groceriesId = insertRow('categories', { name: 'Groceries', type: 'expense' });
  const travelId = insertRow('categories', { name: 'Travel', type: 'expense' });

  const betaId = insertRow('transactions', {
    accountId: savingsId,
    date: '2026-06-15',
    amount: -20,
    description: 'Beta merchant',
    type: 'expense',
  });
  await updateTransactionForTest(betaId, { categoryId: travelId });

  const alphaId = insertRow('transactions', {
    accountId: checkingId,
    date: '2026-06-16',
    amount: -10,
    description: 'Alpha merchant',
    type: 'expense',
  });
  await updateTransactionForTest(alphaId, { categoryId: groceriesId });

  const descriptionAsc = await listTransactionsForTest({ sortBy: 'description_asc' }) as {
    transactions: Array<{ description: string }>;
  };
  const accountDesc = await listTransactionsForTest({ sortBy: 'account_desc' }) as {
    transactions: Array<{ account: { name: string } }>;
  };
  const categoryDesc = await listTransactionsForTest({ sortBy: 'category_desc' }) as {
    transactions: Array<{ category: { name: string } }>;
  };

  expect(descriptionAsc.transactions.map(transaction => transaction.description)).toEqual(['Alpha merchant', 'Beta merchant']);
  expect(accountDesc.transactions.map(transaction => transaction.account.name)).toEqual(['Savings', 'Checking']);
  expect(categoryDesc.transactions.map(transaction => transaction.category.name)).toEqual(['Travel', 'Groceries']);
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
  await updateTransactionForTest(explicitUncategorizedId, { categoryId: uncategorizedId });
  const categorizedId = insertRow('transactions', {
    accountId,
    date: '2026-06-16',
    amount: -30,
    description: 'Categorized',
    type: 'expense',
  });
  await updateTransactionForTest(categorizedId, { categoryId: foodId });

  const body = await listTransactionsForTest({ categoryId: 'uncategorized' });

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
  await updateTransactionForTest(transactionId, { notes: 'reimbursable team lunch' });

  const body = await listTransactionsForTest({ search: 'reimbursable' });

  expect(body.transactions.map((transaction: { notes: string }) => transaction.notes)).toEqual(['reimbursable team lunch']);
});

test('app transactions search includes signed and unsigned amounts with optional thousands separators', async () => {
  const accountId = insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
  });

  insertRow('transactions', {
    accountId,
    date: '2026-06-17',
    amount: -1234.56,
    description: 'Large expense',
    type: 'expense',
  });
  insertRow('transactions', {
    accountId,
    date: '2026-06-18',
    amount: 1234.56,
    description: 'Large income',
    type: 'income',
  });
  insertRow('transactions', {
    accountId,
    date: '2026-06-19',
    amount: -12.34,
    description: 'Small expense',
    type: 'expense',
  });

  const unsignedWithoutSeparator = await listTransactionsForTest({ search: '1234.56' });
  const unsignedWithSeparator = await listTransactionsForTest({ search: '1,234.56' });
  const signedNegative = await listTransactionsForTest({ search: '-1234.56' });

  expect(unsignedWithoutSeparator.transactions.map((transaction: { description: string }) => transaction.description)).toEqual([
    'Large income',
    'Large expense',
  ]);
  expect(unsignedWithSeparator.transactions.map((transaction: { description: string }) => transaction.description)).toEqual([
    'Large income',
    'Large expense',
  ]);
  expect(signedNegative.transactions.map((transaction: { description: string }) => transaction.description)).toEqual([
    'Large expense',
  ]);
});

test('app transactions search requires all terms to match', async () => {
  const accountId = insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
  });

  insertRow('transactions', {
    accountId,
    date: '2026-06-17',
    amount: -930,
    description: 'Check 1234',
    type: 'expense',
  });
  insertRow('transactions', {
    accountId,
    date: '2026-06-18',
    amount: -930,
    description: 'Online transfer',
    type: 'expense',
  });
  insertRow('transactions', {
    accountId,
    date: '2026-06-19',
    amount: -120,
    description: 'Check 5678',
    type: 'expense',
  });

  const body = await listTransactionsForTest({ search: 'check 930.00' });

  expect(body.transactions.map((transaction: { description: string }) => transaction.description)).toEqual([
    'Online transfer',
    'Check 1234',
  ]);
});

test('app transactions search supports quoted phrase terms', async () => {
  const accountId = insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
  });

  insertRow('transactions', {
    accountId,
    date: '2026-06-17',
    amount: -9000,
    description: 'Customer Withdrawal Image',
    type: 'expense',
  });
  insertRow('transactions', {
    accountId,
    date: '2026-06-18',
    amount: -9000,
    description: 'Customer Deposit Image',
    type: 'expense',
  });

  const body = await listTransactionsForTest({ search: '"customer withdrawal" 9000' });

  expect(body.transactions.map((transaction: { description: string }) => transaction.description)).toEqual([
    'Customer Withdrawal Image',
  ]);
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

  const body = await listTransactionsForTest();
  expect(body.transactions[0].category).toBeNull();
  expect(body.transactions[0].notes).toBeNull();

  const categoryFiltered = await listTransactionsForTest({ categoryId });
  expect(categoryFiltered.transactions).toEqual([]);

  const searchFiltered = await listTransactionsForTest({ search: 'legacy-only-note' });
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

  await updateTransactionForTest(transactionId, {
    categoryId,
    notes: 'annotation-only',
  });

  const transaction = getDb().prepare('SELECT categoryId, notes FROM transactions WHERE id = ?').get(transactionId) as {
    categoryId: number | null;
    notes: string | null;
  };
  expect(transaction.categoryId).toBeNull();
  expect(transaction.notes).toBeNull();

  const body = await listTransactionsForTest({ search: 'annotation-only' });
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

  await updateTransactionForTest(transactionId, {
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

  const body = await listTransactionsForTest();
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

  await updateTransactionForTest(transactionId, {
    categoryId,
    notes: 'before legacy delete',
  });

  const beforeDelete = await listTransactionsForTest({ search: 'Ledger Cafe' });
  expect(beforeDelete.transactions).toHaveLength(1);
  const ledgerTransactionId = beforeDelete.transactions[0].ledgerTransactionId;
  expect(ledgerTransactionId.startsWith('txn_')).toBe(true);

  getDb().prepare('DELETE FROM transactions WHERE id = ?').run(transactionId);

  const ledgerOnly = await listTransactionsForTest({ search: 'Ledger Cafe' });
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

  await updateTransactionForTest(ledgerOnly.transactions[0].id, {
    notes: 'ledger-only annotation',
  });
  const updated = await listTransactionsForTest({ search: 'ledger-only annotation' });
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

  const before = await caller.transactions.list({ search: 'TRPC Cafe', limit: 1 });
  expect(before.transactions).toHaveLength(1);
  expect(before.totalCount).toBe(1);
  expect(before.hasMore).toBe(false);
  expect(before.nextOffset).toBeNull();
  expect(before.transactions[0].category).toBeNull();

  await caller.transactions.categorize({
    transactionIds: [transactionId],
    categoryId,
  });

  const after = await caller.transactions.list({ search: 'TRPC Cafe', limit: 1 });
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

  const previewPage = await caller.transactions.list({ search: 'Bulk Coffee', limit: 1 });
  expect(previewPage.transactions).toHaveLength(1);
  expect(previewPage.totalCount).toBe(2);

  const result = await caller.transactions.categorizeMatching({
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

  const pendingUndo = await caller.transactions.latestCategoryUndo();
  expect(pendingUndo).toEqual(result.undoOperation);

  const matching = await caller.transactions.list({ search: 'Bulk Coffee' });
  expect(matching.transactions).toHaveLength(2);
  expect(matching.transactions.every(transaction => transaction.category?.id === categoryId)).toBe(true);

  const unmatched = await caller.transactions.list({ search: 'Unmatched Lunch' });
  expect(unmatched.transactions).toHaveLength(1);
  expect(unmatched.transactions[0].category).toBeNull();

  const undo = await caller.transactions.restoreCategories({
    undoOperationId: result.undoOperation?.id ?? 0,
  });
  expect(undo).toEqual({ ok: true, count: 2 });
  expect(await caller.transactions.latestCategoryUndo()).toBeNull();

  const restored = await caller.transactions.list({ search: 'Bulk Coffee' });
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

  const coverage = await caller.transactions.categorizationCoverage();

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

test('trpc budgets and import profiles expose typed crud', async () => {
  const categoryId = Number(insertRow('categories', { name: 'Food', type: 'expense' }));

  const set = await caller.budgets.set({ categoryId, month: '2026-06', amount: 450 }) as { id: number };
  const budgetId = Number(set.id);
  expect(Number.isFinite(budgetId)).toBe(true);
  expect(await caller.budgets.list({ month: '2026-06' })).toEqual([
    expect.objectContaining({ id: budgetId, categoryId, month: '2026-06', amount: 450 }),
  ]);
  await caller.budgets.delete({ id: budgetId });
  expect(await caller.budgets.list({ month: '2026-06' })).toEqual([]);

  const profile = await caller.importProfiles.upsert({
    headerSignature: 'trpc-profile',
    profileName: 'TRPC Profile',
    profileJson: JSON.stringify({ name: 'TRPC Profile' }),
    mappingJson: JSON.stringify({ dateColumn: 'Date' }),
    lastAccountId: null,
  });
  await caller.importProfiles.upsert({
    headerSignature: 'trpc-profile',
    profileName: 'TRPC Profile Updated',
    profileJson: JSON.stringify({ name: 'TRPC Profile Updated' }),
    mappingJson: JSON.stringify({ dateColumn: 'Posted' }),
    lastAccountId: null,
  });
  expect(await caller.importProfiles.list()).toEqual([
    expect.objectContaining({ id: profile.id, headerSignature: 'trpc-profile', profileName: 'TRPC Profile Updated' }),
  ]);
});

test('trpc budgeting report computes period actuals and variance on the backend', async () => {
  const checkingId = insertRow('accounts', {
    name: 'Checking',
    institution: 'Local Bank',
    type: 'checking',
  });
  insertRow('accounts', {
    name: 'Vanguard Brokerage',
    institution: 'Vanguard',
    type: 'investment',
  });
  const diningId = Number(insertRow('categories', {
    name: 'Dining',
    type: 'expense',
    color: '#f97316',
  }));
  const incomeId = Number(insertRow('categories', {
    name: 'Income',
    type: 'income',
  }));
  await caller.budgets.set({ categoryId: diningId, month: '2026-06', amount: 100 });

  const cafeId = insertRow('transactions', {
    accountId: checkingId,
    date: '2026-06-10',
    amount: -126,
    description: 'Cafe',
    merchant: 'Blue Cafe',
    type: 'expense',
  });
  await updateTransactionForTest(cafeId, { categoryId: diningId });
  const payrollId = insertRow('transactions', {
    accountId: checkingId,
    date: '2026-06-15',
    amount: 1000,
    description: 'Payroll',
    merchant: 'ACME Payroll',
    type: 'income',
  });
  await updateTransactionForTest(payrollId, { categoryId: incomeId });
  insertRow('transactions', {
    accountId: checkingId,
    date: '2026-06-16',
    amount: -400,
    description: 'VANGUARD BROKERAGE TRANSFER',
    merchant: 'Vanguard',
    type: 'expense',
  });

  const report = await caller.budgets.report({
    startDate: '2026-06-01',
    endDate: '2026-06-30',
    month: '2026-06',
  });

  expect(report.cashFlow).toMatchObject({
    income: 1000,
    expenses: 126,
    byCategory: { [String(diningId)]: 126 },
  });
  expect(report.summary).toMatchObject({
    income: 1000,
    expenses: 126,
    budgetRemaining: 874,
    unplannedCount: 0,
    overCount: 1,
  });
  expect(report.rows).toContainEqual(expect.objectContaining({
    actual: 126,
    budgetAmount: 100,
    variance: 26,
    status: 'over',
    category: expect.objectContaining({ id: diningId, name: 'Dining' }),
  }));
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

  const result = await caller.transactions.applyAiCategorization({
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
  await caller.transactions.restoreCategories({
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

  const result = await caller.transactions.applyAiCategorization({
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
    const result = await caller.transactions.aiCategorizationPreview({ limit: 32 });

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

test('ai categorization auto-apply reports missing server key without categorizing', async () => {
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = '';
  const accountId = Number(insertRow('accounts', {
    name: 'AI Auto Checking',
    type: 'checking',
    currentBalance: 0,
  }));
  insertRow('ledgerTransactions', {
    ledgerTransactionId: 'txn_ai_auto_no_key',
    accountId,
    date: '2026-06-03',
    amountCents: -2500,
    description: 'Auto Apply Coffee',
    merchant: 'Auto Apply Coffee',
    type: 'expense',
    transactionKind: 'activity',
    createdAt: new Date().toISOString(),
  });

  try {
    const result = await caller.transactions.autoApplyAiCategorization({ sort: 'count' });

    expect(result).toMatchObject({
      configured: false,
      scanned: 1,
      groupCount: 1,
      reviewedGroupCount: 0,
      unresolvedGroupCount: 1,
      appliedCount: 0,
      requested: 0,
      skippedCount: 0,
      undoOperation: null,
    });
    expect(
      getDb().prepare('SELECT categoryId FROM transactionAnnotations WHERE ledgerTransactionId = ?').get('txn_ai_auto_no_key')
    ).toBeNull();
  } finally {
    if (previousOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
  }
});

test('ai categorization auto-apply job reports progress without blocking on missing key', async () => {
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = '';
  const accountId = Number(insertRow('accounts', {
    name: 'AI Auto Job Checking',
    type: 'checking',
    currentBalance: 0,
  }));
  insertRow('ledgerTransactions', {
    ledgerTransactionId: 'txn_ai_auto_job_no_key',
    accountId,
    date: '2026-06-04',
    amountCents: -2600,
    description: 'Auto Apply Job Coffee',
    merchant: 'Auto Apply Job Coffee',
    type: 'expense',
    transactionKind: 'activity',
    createdAt: new Date().toISOString(),
  });

  try {
    const job = await caller.transactions.startAutoApplyAiCategorization({ sort: 'count' });
    expect(['queued', 'running']).toContain(job.status);
    expect(job.sort).toBe('count');

    let finalJob = job;
    for (let attempt = 0; attempt < 10 && finalJob.status !== 'completed'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      finalJob = await caller.transactions.autoApplyAiCategorizationJob({ jobId: job.id });
    }

    expect(finalJob).toMatchObject({
      status: 'completed',
      configured: false,
      scanned: 1,
      groupCount: 1,
      appliedCount: 0,
      requested: 0,
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

test('ai categorization can sort merchant groups by money instead of count', () => {
  const baseRow = {
    accountName: 'Checking',
    accountInstitution: 'Bank',
    accountType: 'checking',
    originalCategory: null,
    transactionKind: 'activity',
  };
  const rows = [
    {
      ...baseRow,
      id: 1,
      ledgerTransactionId: 'coffee_1',
      date: '2026-06-01',
      amountCents: -500,
      description: 'Coffee',
      merchant: 'Coffee',
      originalDescription: 'Coffee',
    },
    {
      ...baseRow,
      id: 2,
      ledgerTransactionId: 'coffee_2',
      date: '2026-06-02',
      amountCents: -500,
      description: 'Coffee',
      merchant: 'Coffee',
      originalDescription: 'Coffee',
    },
    {
      ...baseRow,
      id: 3,
      ledgerTransactionId: 'rent_1',
      date: '2026-06-03',
      amountCents: -250000,
      description: 'Rent',
      merchant: 'Rent',
      originalDescription: 'Rent',
    },
  ];

  expect(groupTransactionsForAiCategorization(rows).map(group => group.merchantName)).toEqual([
    'Coffee',
    'Rent',
  ]);
  expect(groupTransactionsForAiCategorization(rows, { sort: 'money' }).map(group => group.merchantName)).toEqual([
    'Rent',
    'Coffee',
  ]);
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

  const rule = await caller.transactions.createMerchantGroupingRule({
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

test('ai categorization normalizes Money Line EFT reference suffixes', () => {
  const rows = [
    {
      id: 1,
      ledgerTransactionId: 'money_line_1',
      accountName: 'Brokerage',
      accountInstitution: 'Fidelity',
      accountType: 'investment',
      date: '2026-06-01',
      amountCents: -40000,
      description: 'Money Line Paid EFT FUNDS PAID ED84859299',
      merchant: 'Money Line Paid EFT FUNDS PAID ED84859299',
      originalDescription: 'Money Line Paid EFT FUNDS PAID ED84859299',
      originalCategory: null,
      transactionKind: 'activity',
    },
    {
      id: 2,
      ledgerTransactionId: 'money_line_2',
      accountName: 'Brokerage',
      accountInstitution: 'Fidelity',
      accountType: 'investment',
      date: '2026-06-02',
      amountCents: -40000,
      description: 'Money Line Paid EFT FUNDS PAID ED68854613 /WEB',
      merchant: 'Money Line Paid EFT FUNDS PAID ED68854613 /WEB',
      originalDescription: 'Money Line Paid EFT FUNDS PAID ED68854613 /WEB',
      originalCategory: null,
      transactionKind: 'activity',
    },
  ];

  const groups = groupTransactionsForAiCategorization(rows);

  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({
    merchantName: 'Money Line Paid Eft Funds Paid',
    normalizedMerchant: 'MONEY LINE PAID EFT FUNDS PAID',
    transactionIds: ['money_line_2', 'money_line_1'],
  });
});

test('ai categorization can split a merchant into individual transaction review groups', async () => {
  const rows = [
    {
      id: 1,
      ledgerTransactionId: 'venmo_rent',
      accountName: 'Checking',
      accountInstitution: 'Bank',
      accountType: 'checking',
      date: '2026-06-01',
      amountCents: -120000,
      description: 'Venmo',
      merchant: 'Venmo',
      originalDescription: 'Venmo',
      originalCategory: null,
      transactionKind: 'activity',
    },
    {
      id: 2,
      ledgerTransactionId: 'venmo_dinner',
      accountName: 'Checking',
      accountInstitution: 'Bank',
      accountType: 'checking',
      date: '2026-06-02',
      amountCents: -4500,
      description: 'Venmo',
      merchant: 'Venmo',
      originalDescription: 'Venmo',
      originalCategory: null,
      transactionKind: 'activity',
    },
  ];

  const [combinedGroup] = groupTransactionsForAiCategorization(rows);
  expect(combinedGroup).toMatchObject({
    merchantName: 'Venmo',
    transactionIds: ['venmo_dinner', 'venmo_rent'],
  });

  const rule = await caller.transactions.createMerchantGroupingRule({
    sourceMerchantKey: combinedGroup!.sourceMerchantKey,
    strategy: 'individual_transactions',
  });
  expect(rule).toMatchObject({
    sourceMerchantKey: 'VENMO',
    strategy: 'individual_transactions',
  });

  const splitGroups = groupTransactionsForAiCategorization(rows);
  expect(splitGroups.map(group => ({
    merchantName: group.merchantName,
    transactionIds: group.transactionIds,
    transactionCount: group.transactionCount,
  }))).toEqual([
    { merchantName: 'Venmo', transactionIds: ['venmo_rent'], transactionCount: 1 },
    { merchantName: 'Venmo', transactionIds: ['venmo_dinner'], transactionCount: 1 },
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

  const report = await caller.netWorth.report();
  expect(report.currentNetWorth).toBe(800);
  expect(report.history).toEqual([{ month: '2026-05', netWorth: 800 }]);
  expect(report.percentChange).toBeCloseTo(0);
});

test('investment report endpoints expose money-style ledger reports', async () => {
  const accountId = Number(insertRow('accounts', {
    name: 'Brokerage',
    institution: 'Vanguard',
    type: 'investment',
    accountHolder: 'Example Owner',
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

  const netWorth = await netWorthReportForTest() as {
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
    account_holder: 'Example Owner',
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

  const savingsRate = await savingsRateReportForTest() as {
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

  const trpcNetWorth = await caller.reports.netWorth();
  expect(trpcNetWorth.rows).toContainEqual(expect.objectContaining({
    month: '2026-02',
    account_id: accountId,
    dividends_cents: 5000,
    gains_cents: 7000,
    end_balance_cents: 112000,
  }));
  const trpcSavingsRate = await caller.reports.savingsRate();
  expect(trpcSavingsRate.income_sources).toContainEqual(expect.objectContaining({
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

  const netWorth = await netWorthReportForTest() as {
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

  const netWorth = await netWorthReportForTest() as {
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

test('trpc imports preview and history use the backend parser path', async () => {
  const csv = fs.readFileSync(path.resolve(import.meta.dir, '..', '..', 'sample-imports', 'chase-credit-card-demo.csv'), 'utf8');

  const preview = await caller.imports.preview({
    fileName: 'chase-credit-card-demo.csv',
    text: csv,
    fileBase64: Buffer.from(csv).toString('base64'),
    customProfile: null,
  }) as Awaited<ReturnType<typeof postImportPreview>>;

  expect(preview).toMatchObject({
    requiresMapping: false,
    profileUsed: 'Chase Credit Card',
    importFileId: 1,
  });
  expect(preview.transactions).toHaveLength(10);

  const accountId = insertRow('accounts', {
    name: 'Chase Sapphire',
    institution: 'Chase',
    type: 'credit',
    currentBalance: 0,
  });
  const commit = await caller.imports.commit({
    accountId,
    importFileId: preview.importFileId,
    importRowIds: preview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
    forceImportRowIds: [],
    balanceRowIds: [],
    accountMappings: [],
    importMeta: {
      importFileId: preview.importFileId,
      headers: preview.headers,
      profile: preview.profile,
      mapping: preview.mapping,
      profileName: preview.profileUsed,
    },
  });

  expect(commit.importedCount).toBe(10);
  expect(await caller.imports.history()).toMatchObject({
    imports: [expect.objectContaining({ id: preview.importFileId, status: 'committed', transactionCount: 10 })],
  });
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

  const firstCommit = await commitImportForTest( {
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
  });

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

  const secondCommit = await commitImportForTest( {
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
  });

  expect(secondCommit.importedCount).toBe(0);
  expect(secondCommit.skippedDuplicateCount).toBe(10);

  const forcedCommit = await commitImportForTest( {
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
  });

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
    accountHolder: 'Example Owner',
  });
  const preview = await postImportPreview('chase-credit-card-demo.csv', csv);

  await commitImportForTest( {
    accountId,
    importFileId: preview.importFileId,
    importRowIds: preview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
  });
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

  const history = await listImportHistoryForTest() as {
    imports: Array<{
      id: number;
      fileName: string;
      status: string;
      transactionCount: number;
      sourceKind: string;
      accounts: Array<{
        id: number | null;
        name: string | null;
        accountHolder: string | null;
      }>;
    }>;
  };
  expect(history.imports[0]).toMatchObject({
    id: preview.importFileId,
    fileName: 'chase-credit-card-demo.csv',
    status: 'committed',
    transactionCount: 10,
    sourceKind: 'activity',
    accounts: [{
      id: accountId,
      name: 'Chase Sapphire',
      accountHolder: 'Example Owner',
    }],
  });

  await caller.imports.unimport({ importFileId: preview.importFileId });

  expect(getDb().prepare('SELECT COUNT(*) AS count FROM transactions WHERE accountId = ?').get(accountId)).toMatchObject({ count: 0 });
  expect(getDb().prepare('SELECT COUNT(*) AS count FROM ledgerTransactions WHERE accountId = ?').get(accountId)).toMatchObject({ count: 0 });
  expect(getDb().prepare('SELECT status FROM importFiles WHERE id = ?').get(preview.importFileId)).toMatchObject({ status: 'unimported' });
  expect(getDb().prepare('SELECT status FROM sourceFiles WHERE importFileId = ?').get(preview.importFileId)).toMatchObject({ status: 'unimported' });
  expect(getDb().prepare('SELECT accountId FROM sourceAccounts WHERE sourceFileId = (SELECT id FROM sourceFiles WHERE importFileId = ?)').get(preview.importFileId)).toMatchObject({ accountId });
  expect(getDb().prepare('SELECT notes FROM transactionAnnotations WHERE ledgerTransactionId = ?').get(annotatedTransaction.ledgerTransactionId)).toMatchObject({
    notes: 'keep this user note',
  });

  const reimport = await caller.imports.reimport({ importFileId: preview.importFileId });
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

test('app import history returns each consolidated file once with deduplicated account metadata', async () => {
  const csv = fs.readFileSync(path.resolve(import.meta.dir, '..', '..', 'sample-imports', 'chase-credit-card-demo.csv'), 'utf8');
  const primaryAccountId = insertRow('accounts', {
    name: 'Primary Card',
    institution: 'Chase',
    type: 'credit',
    currentBalance: 100,
    accountHolder: 'Example Owner',
  });
  const secondaryAccountId = insertRow('accounts', {
    name: 'Household Card',
    institution: 'Chase',
    type: 'credit',
    currentBalance: 50,
    accountHolder: 'Another Owner',
  });
  const preview = await postImportPreview('consolidated-cards.csv', csv);

  await commitImportForTest({
    accountId: primaryAccountId,
    importFileId: preview.importFileId,
    importRowIds: preview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
  });

  const sourceFile = getDb().prepare('SELECT id FROM sourceFiles WHERE importFileId = ?').get(preview.importFileId) as {
    id: number;
  };
  insertRow('sourceAccounts', {
    sourceFileId: sourceFile.id,
    accountId: primaryAccountId,
    institution: 'Chase',
    sourceAccountKey: 'primary-alias',
    sourceAccountName: 'Primary Card Alias',
    accountHolder: 'Parsed Owner',
  });
  insertRow('sourceAccounts', {
    sourceFileId: sourceFile.id,
    accountId: secondaryAccountId,
    institution: 'Chase',
    sourceAccountKey: 'secondary',
    sourceAccountName: 'Household Card',
    accountHolder: 'Another Owner',
  });

  const history = await caller.imports.history();
  expect(history.imports).toHaveLength(1);
  expect(history.imports[0]?.accounts).toEqual([
    {
      id: secondaryAccountId,
      name: 'Household Card',
      accountHolder: 'Another Owner',
    },
    {
      id: primaryAccountId,
      name: 'Primary Card',
      accountHolder: 'Example Owner',
    },
  ]);
});

test('app data freshness reports latest source fact dates by account', async () => {
  const checkingId = Number(insertRow('accounts', {
    name: 'Fresh Checking',
    institution: 'Bank of America',
    type: 'checking',
    currentBalance: 0,
  }));
  const staleCardId = Number(insertRow('accounts', {
    name: 'Old Card',
    institution: 'Chase',
    type: 'credit-card',
    currentBalance: 0,
  }));
  const noDataId = Number(insertRow('accounts', {
    name: 'Never Imported',
    institution: 'Marcus',
    type: 'savings',
    currentBalance: 0,
  }));
  const closedId = Number(insertRow('accounts', {
    name: 'Closed Brokerage',
    institution: 'Vanguard',
    type: 'investment',
    status: 'closed',
    currentBalance: 0,
  }));
  insertRow('accounts', {
    name: 'Archived Account',
    institution: 'Bank of America',
    type: 'checking',
    status: 'archived',
    currentBalance: 0,
  });

  const freshImportFileId = Number(insertRow('importFiles', {
    fileName: 'bofa-checking.csv',
    contentHash: 'fresh-hash',
    parserName: 'Bank of America Activity',
    institution: 'Bank of America',
    sourceType: 'activity-export',
    status: 'committed',
    committedAt: '2026-06-25T12:00:00.000Z',
  }));
  const freshSourceFileId = Number(insertRow('sourceFiles', {
    importFileId: freshImportFileId,
    fileName: 'bofa-checking.csv',
    contentHash: 'fresh-hash',
    parserName: 'Bank of America Activity',
    institution: 'Bank of America',
    sourceType: 'activity-export',
    status: 'committed',
    committedAt: '2026-06-25T12:00:00.000Z',
  }));
  const freshSourceAccountId = Number(insertRow('sourceAccounts', {
    sourceFileId: freshSourceFileId,
    accountId: checkingId,
    institution: 'Bank of America',
    sourceAccountKey: 'bofa-checking',
    sourceAccountName: 'Fresh Checking',
  }));
  insertRow('sourceTransactions', {
    sourceFileId: freshSourceFileId,
    sourceAccountId: freshSourceAccountId,
    stableSourceId: 'fresh-transaction',
    date: '2026-06-20',
    amountCents: -1200,
    description: 'Fresh Coffee',
    sourceRole: 'activity',
    priority: 100,
  });
  insertRow('sourceBalances', {
    sourceFileId: freshSourceFileId,
    sourceAccountId: freshSourceAccountId,
    date: '2026-06-25',
    balanceCents: 100000,
    priority: 100,
  });

  const staleImportFileId = Number(insertRow('importFiles', {
    fileName: 'chase.csv',
    contentHash: 'stale-hash',
    parserName: 'Chase Credit Card',
    institution: 'Chase',
    sourceType: 'activity-export',
    status: 'committed',
    committedAt: '2026-04-01T12:00:00.000Z',
  }));
  const staleSourceFileId = Number(insertRow('sourceFiles', {
    importFileId: staleImportFileId,
    fileName: 'chase.csv',
    contentHash: 'stale-hash',
    parserName: 'Chase Credit Card',
    institution: 'Chase',
    sourceType: 'activity-export',
    status: 'committed',
    committedAt: '2026-04-01T12:00:00.000Z',
  }));
  const staleSourceAccountId = Number(insertRow('sourceAccounts', {
    sourceFileId: staleSourceFileId,
    accountId: staleCardId,
    institution: 'Chase',
    sourceAccountKey: 'chase-card',
    sourceAccountName: 'Old Card',
  }));
  insertRow('sourceTransactions', {
    sourceFileId: staleSourceFileId,
    sourceAccountId: staleSourceAccountId,
    stableSourceId: 'stale-transaction',
    date: '2026-04-01',
    amountCents: -3400,
    description: 'Old Dinner',
    sourceRole: 'activity',
    priority: 100,
  });

  const body = await dataFreshnessForTest('2026-07-01');
  const checking = body.accounts.find((account: { accountId: number }) => account.accountId === checkingId);
  const staleCard = body.accounts.find((account: { accountId: number }) => account.accountId === staleCardId);
  const noData = body.accounts.find((account: { accountId: number }) => account.accountId === noDataId);
  const closed = body.accounts.find((account: { accountId: number }) => account.accountId === closedId);

  expect(body.summary).toMatchObject({
    totalAccounts: 4,
    currentAccounts: 1,
    staleAccounts: 1,
    noDataAccounts: 1,
    closedAccounts: 1,
  });
  expect(checking).toMatchObject({
    latestTransactionDate: '2026-06-20',
    latestBalanceDate: '2026-06-25',
    latestFactDate: '2026-06-25',
    status: 'current',
    latestImportFileName: 'bofa-checking.csv',
  });
  expect(checking.suggestedDownloads).toContain('Activity CSV');
  expect(checking.suggestedDownloads).toContain('Statement PDF');
  expect(staleCard).toMatchObject({
    latestFactDate: '2026-04-01',
    status: 'stale',
  });
  expect(staleCard.suggestedDownloads).toContain('Credit-card activity CSV');
  expect(noData).toMatchObject({
    latestFactDate: null,
    status: 'no-data',
  });
  expect(closed).toMatchObject({
    latestFactDate: null,
    status: 'closed',
    accountStatus: 'closed',
  });
  expect(body.catchUp).toMatchObject({
    generatedAt: '2026-07-01',
    totalItems: 2,
  });
  expect(body.catchUp.items).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: `account-${staleCardId}`,
      accountId: staleCardId,
      institution: 'Chase',
      status: 'stale',
      latestFactDate: '2026-04-01',
      downloadWindow: {
        startDate: '2026-03-25',
        endDate: '2026-07-01',
        overlapDays: 7,
        label: '2026-03-25 through 2026-07-01',
      },
      suggestedDownloads: expect.arrayContaining(['Credit-card activity CSV']),
    }),
    expect.objectContaining({
      id: `account-${noDataId}`,
      accountId: noDataId,
      institution: 'Marcus',
      status: 'no-data',
      latestFactDate: null,
      downloadWindow: {
        startDate: '2025-07-01',
        endDate: '2026-07-01',
        overlapDays: 0,
        label: 'last 12 months through 2026-07-01',
      },
      suggestedDownloads: expect.arrayContaining(['Activity CSV', 'Statement PDF']),
    }),
  ]));
  expect(body.catchUp.groups).toEqual(expect.arrayContaining([
    expect.objectContaining({
      institution: 'Chase',
      statuses: { due: 0, stale: 1, noData: 0 },
    }),
    expect.objectContaining({
      institution: 'Marcus',
      statuses: { due: 0, stale: 0, noData: 1 },
    }),
  ]));

  const catchUp = await dataCatchUpForTest('2026-07-01');
  expect(catchUp).toMatchObject({
    generatedAt: '2026-07-01',
    totalItems: 2,
  });
  expect(catchUp.items.map((item: { accountId: number }) => item.accountId).sort()).toEqual([noDataId, staleCardId].sort());
  expect(catchUp.items.map((item: { accountId: number }) => item.accountId)).not.toContain(closedId);

  const trpcReport = await caller.dataFreshness.report({ today: '2026-07-01' });
  expect(trpcReport.summary).toMatchObject({
    totalAccounts: 4,
    currentAccounts: 1,
    staleAccounts: 1,
    noDataAccounts: 1,
    closedAccounts: 1,
  });
  const trpcCatchUp = await caller.dataFreshness.catchUp({ today: '2026-07-01' });
  expect(trpcCatchUp).toMatchObject({
    generatedAt: '2026-07-01',
    totalItems: 2,
  });
});

test('Vanguard sync targets survive reversible unimport provenance', async () => {
  const accountId = Number(insertRow('accounts', {
    name: 'Vanguard',
    institution: 'Vanguard',
    type: 'investment',
    accountHolder: 'Example Holder',
    currentBalance: 0,
  }));
  const sourceFileId = Number(insertRow('sourceFiles', {
    fileName: '2026-07-31-Brokerage---account-2.pdf',
    contentHash: 'unimported-vanguard-profile',
    parserName: 'vanguard-statement',
    sourceType: 'statement',
    institution: 'Vanguard',
    status: 'unimported',
    createdAt: '2026-08-01T00:00:00.000Z',
  }));
  insertRow('sourceAccounts', {
    sourceFileId,
    accountId,
    institution: 'Vanguard',
    sourceAccountKey: 'brokerage-1234',
    sourceAccountName: 'Brokerage - 1234',
    accountHolder: 'Example Holder',
    createdAt: '2026-08-01T00:00:00.000Z',
  });

  expect(await caller.dataSync.targets()).toContainEqual({
    id: 'vanguard:account-2',
    institutionId: 'vanguard',
    connectionId: 'account-2',
    label: 'Vanguard (Example Holder)',
  });
});

test('institution catch-up stages reviewable claims before explicit confirmation', async () => {
  const accountId = Number(insertRow('accounts', {
    name: 'Primary Checking',
    institution: 'Bank of America',
    type: 'checking',
    currentBalance: 0,
    currency: 'USD',
    status: 'active',
  }));
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'easymoney-sync-review-'));
  const fileName = 'bofa-checking-1234-2026-01-01-to-2026-01-31.csv';
  const filePath = path.join(directory, fileName);
  await fs.promises.writeFile(filePath, [
    'Description,,Summary Amt.',
    'Opening Balance,,1000.00',
    'Date,Description,Amount,Running Bal.',
    '01/05/2026,EXAMPLE PAYROLL,2500.00,3500.00',
    '01/06/2026,EXAMPLE UTILITY,-125.50,3374.50',
  ].join('\n'));

  try {
    const artifact = await stageSyncArtifact({ path: filePath, accountId });
    expect(artifact).toMatchObject({
      fileName,
      status: 'ready',
      accountId,
      accountName: 'Primary Checking',
      parserName: 'bofa-activity-csv',
      coveredFrom: '2026-01-05',
      coveredTo: '2026-01-06',
      transactionCount: 2,
      balanceCount: 2,
      inflowCents: 250000,
      outflowCents: 12550,
      netAmountCents: 237450,
    });
    expect(artifact.accountClaims).toEqual([expect.objectContaining({
      remoteAccountId: 'Bank of America||Adv Plus Banking - 1234',
      accountName: 'Adv Plus Banking - 1234',
      resolvedAccountId: accountId,
      resolution: 'connector',
      transactionCount: 2,
      balanceCount: 2,
    })]);
    expect(artifact.transactionSamples).toHaveLength(2);
    expect(artifact.balanceClaims).toHaveLength(2);
    expect(getDb().prepare('SELECT status FROM importFiles WHERE id = ?').get(artifact.importFileId))
      .toEqual({ status: 'previewed' });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM ledgerTransactions').get()).toEqual({ count: 0 });
    expect((await listImportHistoryForTest()).imports).toHaveLength(0);

    const repeatedPreview = await stageSyncArtifact({ path: filePath, accountId });
    expect(repeatedPreview).toMatchObject({
      importFileId: artifact.importFileId,
      status: 'ready',
    });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM importFiles').get()).toEqual({ count: 1 });

    const review = {
      runId: 'sync-test-review',
      institutionId: 'bank-of-america' as const,
      downloaded: 1,
      readyToImport: 1,
      alreadyImported: 0,
      artifacts: [artifact],
    };
    await saveAwaitingSyncReview(review);
    const persistedJob = await caller.dataSync.status({ runId: review.runId });
    expect(persistedJob).toMatchObject({
      status: 'awaiting-confirmation',
      review: { readyToImport: 1 },
    });
    const confirmedJob = await caller.dataSync.confirm({ runId: review.runId });
    expect(confirmedJob).toMatchObject({
      status: 'complete',
      result: {
        recordedTransactionFacts: 2,
        recordedBalanceFacts: 2,
        skippedArtifacts: 0,
      },
    });
    expect(getDb().prepare('SELECT status FROM importFiles WHERE id = ?').get(artifact.importFileId))
      .toEqual({ status: 'committed' });
    expect(getDb().prepare('SELECT DISTINCT accountId FROM sourceAccounts').all()).toEqual([{ accountId }]);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM accounts').get()).toEqual({ count: 1 });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM ledgerTransactions').get()).toEqual({ count: 2 });
    expect((await listImportHistoryForTest()).imports).toHaveLength(1);

    const duplicate = await stageSyncArtifact({ path: filePath, accountId });
    expect(duplicate.status).toBe('already-imported');
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM importFiles').get()).toEqual({ count: 1 });
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('catch-up commits two consolidated source-account claims to independent local accounts', async () => {
  const firstAccountId = Number(insertRow('accounts', {
    name: 'First Local Account',
    institution: 'Example Institution',
    type: 'checking',
    currentBalance: 0,
    currency: 'USD',
    status: 'active',
  }));
  const secondAccountId = Number(insertRow('accounts', {
    name: 'Second Local Account',
    institution: 'Example Institution',
    type: 'savings',
    currentBalance: 0,
    currency: 'USD',
    status: 'active',
  }));
  const staged = stageConsolidatedSyncFacts([
    { remoteAccountId: 'remote:first', accountName: 'Remote Checking', amountCents: -1200 },
    { remoteAccountId: 'remote:second', accountName: 'Remote Savings', amountCents: 3400 },
  ], 'consolidated-two-account-review.csv');
  const artifact = buildSyncArtifactReview({
    importFileId: staged.importFileId,
    fileName: staged.fileName,
    status: 'ready',
    accountRoutes: [
      { remoteAccountId: 'remote:first', accountId: firstAccountId },
      { remoteAccountId: 'remote:second', accountId: secondAccountId },
    ],
  });

  expect(artifact).toMatchObject({ accountId: null, accountName: null, transactionCount: 2 });
  expect(artifact.accountClaims).toEqual([
    expect.objectContaining({
      remoteAccountId: 'remote:first',
      resolvedAccountId: firstAccountId,
      resolution: 'connector',
    }),
    expect.objectContaining({
      remoteAccountId: 'remote:second',
      resolvedAccountId: secondAccountId,
      resolution: 'connector',
    }),
  ]);

  const review = {
    runId: 'sync-consolidated-two-account',
    institutionId: 'bank-of-america' as const,
    downloaded: 1,
    readyToImport: 1,
    alreadyImported: 0,
    artifacts: [artifact],
  };
  await saveAwaitingSyncReview(review);
  const confirmed = await caller.dataSync.confirm({
    runId: review.runId,
    accountMappings: artifact.accountClaims.map(claim => ({
      sourceAccountId: claim.sourceAccountId,
      mode: 'auto',
    })),
  });

  expect(confirmed.status).toBe('complete');
  expect(getDb().prepare('SELECT accountId FROM sourceAccounts ORDER BY id').all()).toEqual([
    { accountId: firstAccountId },
    { accountId: secondAccountId },
  ]);
  expect(getDb().prepare('SELECT accountId, COUNT(*) AS count FROM ledgerTransactions GROUP BY accountId ORDER BY accountId').all()).toEqual([
    { accountId: firstAccountId, count: 1 },
    { accountId: secondAccountId, count: 1 },
  ]);
});

test('catch-up requires explicit choices for partial and destinationless connector routes', async () => {
  const routedAccountId = Number(insertRow('accounts', {
    name: 'Routed Local Account',
    institution: 'Example Institution',
    type: 'checking',
    currentBalance: 0,
    currency: 'USD',
    status: 'active',
  }));
  const suggestedAccountId = Number(insertRow('accounts', {
    name: 'Suggested Remote Savings',
    institution: 'Example Institution',
    type: 'savings',
    currentBalance: 0,
    currency: 'USD',
    status: 'active',
  }));
  const unroutedAccountId = Number(insertRow('accounts', {
    name: 'Unrouted Remote Card',
    institution: 'Example Institution',
    type: 'credit',
    currentBalance: 0,
    currency: 'USD',
    status: 'active',
  }));
  const staged = stageConsolidatedSyncFacts([
    { remoteAccountId: 'remote:routed', accountName: 'Remote Checking' },
    { remoteAccountId: 'remote:destinationless', accountName: 'Suggested Remote Savings' },
    { remoteAccountId: 'remote:unrouted', accountName: 'Unrouted Remote Card' },
  ], 'partial-connector-routes.csv');
  const artifact = buildSyncArtifactReview({
    importFileId: staged.importFileId,
    fileName: staged.fileName,
    status: 'ready',
    accountRoutes: [
      { remoteAccountId: 'remote:routed', accountId: routedAccountId },
      { remoteAccountId: 'remote:destinationless' },
    ],
  });

  expect(artifact.accountClaims).toEqual([
    expect.objectContaining({
      remoteAccountId: 'remote:routed',
      resolvedAccountId: routedAccountId,
      resolution: 'connector',
      requiresExplicitMapping: false,
    }),
    expect.objectContaining({
      remoteAccountId: 'remote:destinationless',
      resolvedAccountId: suggestedAccountId,
      resolution: 'exact',
      requiresExplicitMapping: true,
    }),
    expect.objectContaining({
      remoteAccountId: 'remote:unrouted',
      resolvedAccountId: unroutedAccountId,
      resolution: 'exact',
      requiresExplicitMapping: true,
    }),
  ]);

  const review = {
    runId: 'sync-partial-connector-routes',
    institutionId: 'bank-of-america' as const,
    downloaded: 1,
    readyToImport: 1,
    alreadyImported: 0,
    artifacts: [artifact],
  };
  await saveAwaitingSyncReview(review);
  await expect(caller.dataSync.confirm({ runId: review.runId })).rejects.toThrow(
    'Resolve every source account before confirming the catch-up.',
  );

  const confirmed = await caller.dataSync.confirm({
    runId: review.runId,
    accountMappings: [
      { sourceAccountId: staged.sourceAccountIds[0]!, mode: 'auto' },
      { sourceAccountId: staged.sourceAccountIds[1]!, mode: 'existing', accountId: suggestedAccountId },
      { sourceAccountId: staged.sourceAccountIds[2]!, mode: 'existing', accountId: unroutedAccountId },
    ],
  });
  expect(confirmed.status).toBe('complete');
  expect(getDb().prepare('SELECT accountId FROM sourceAccounts ORDER BY id').all()).toEqual([
    { accountId: routedAccountId },
    { accountId: suggestedAccountId },
    { accountId: unroutedAccountId },
  ]);
});

test('catch-up confirmation rejects unvalidated mapping decision variants at the API boundary', async () => {
  const staged = stageConsolidatedSyncFacts([
    { remoteAccountId: 'remote:validated-input', accountName: 'Validated Input Account' },
  ], 'validated-confirmation-input.csv');
  const artifact = buildSyncArtifactReview({
    importFileId: staged.importFileId,
    fileName: staged.fileName,
    status: 'ready',
    accountRoutes: [{ remoteAccountId: 'remote:validated-input' }],
  });
  const review = {
    runId: 'sync-validated-confirmation-input',
    institutionId: 'bank-of-america' as const,
    downloaded: 1,
    readyToImport: 1,
    alreadyImported: 0,
    artifacts: [artifact],
  };
  await saveAwaitingSyncReview(review);

  await expect(caller.dataSync.confirm({
    runId: review.runId,
    accountMappings: [{
      sourceAccountId: staged.sourceAccountIds[0]!,
      mode: 'invented-mode',
      accountId: 1,
    }],
  } as never)).rejects.toThrow();
  expect((await caller.dataSync.status({ runId: review.runId }))?.status).toBe('awaiting-confirmation');
});

test('catch-up retains a newly discovered remote account until an explicit create decision', async () => {
  const staged = stageConsolidatedSyncFacts([
    { remoteAccountId: 'remote:new', accountName: 'New Remote Savings', amountCents: 2500, balanceCents: 500000 },
  ], 'new-remote-account-review.csv');
  const artifact = buildSyncArtifactReview({
    importFileId: staged.importFileId,
    fileName: staged.fileName,
    status: 'ready',
    accountRoutes: [{ remoteAccountId: 'remote:new' }],
  });
  expect(artifact.accountClaims).toEqual([expect.objectContaining({
    remoteAccountId: 'remote:new',
    resolvedAccountId: null,
    resolution: 'auto-create',
    transactionCount: 1,
    balanceCount: 1,
  })]);

  const review = {
    runId: 'sync-new-remote-account',
    institutionId: 'bank-of-america' as const,
    downloaded: 1,
    readyToImport: 1,
    alreadyImported: 0,
    artifacts: [artifact],
  };
  await saveAwaitingSyncReview(review);
  await expect(caller.dataSync.confirm({ runId: review.runId })).rejects.toThrow(
    'Resolve every source account before confirming the catch-up.',
  );
  expect(getDb().prepare('SELECT status FROM importFiles WHERE id = ?').get(staged.importFileId))
    .toEqual({ status: 'previewed' });

  const confirmed = await caller.dataSync.confirm({
    runId: review.runId,
    accountMappings: [{
      sourceAccountId: staged.sourceAccountIds[0]!,
      mode: 'create',
      account: {
        name: 'Confirmed New Savings',
        institution: 'Example Institution',
        type: 'savings',
        currency: 'USD',
      },
    }],
  });
  expect(confirmed.status).toBe('complete');
  const created = getDb().prepare("SELECT id, type, status FROM accounts WHERE name = 'Confirmed New Savings'").get() as {
    id: number;
    type: string;
    status: string;
  };
  expect(created).toMatchObject({ type: 'savings', status: 'active' });
  expect(getDb().prepare('SELECT accountId FROM sourceAccounts WHERE id = ?').get(staged.sourceAccountIds[0]!))
    .toEqual({ accountId: created.id });
});

test('catch-up rejects ambiguous parser and local account identities', async () => {
  const duplicateRemote = stageConsolidatedSyncFacts([
    { remoteAccountId: 'remote:duplicate', accountName: 'Parsed Account' },
  ], 'ambiguous-remote-identity.csv');
  expect(() => buildSyncArtifactReview({
    importFileId: duplicateRemote.importFileId,
    status: 'ready',
    accountRoutes: [
      { remoteAccountId: 'remote:duplicate' },
      { remoteAccountId: 'remote:duplicate' },
    ],
  })).toThrow('Ambiguous connector account identity: remote:duplicate');

  for (const name of ['First Duplicate Local', 'Second Duplicate Local']) {
    insertRow('accounts', {
      name: 'Ambiguous Remote Account',
      institution: 'Example Institution',
      type: 'checking',
      currentBalance: 0,
      currency: 'USD',
      status: 'active',
      accountHolder: name,
    });
  }
  const ambiguousLocal = stageConsolidatedSyncFacts([
    { remoteAccountId: 'remote:ambiguous-local', accountName: 'Ambiguous Remote Account' },
  ], 'ambiguous-local-identity.csv');
  const artifact = buildSyncArtifactReview({
    importFileId: ambiguousLocal.importFileId,
    status: 'ready',
  });
  expect(artifact.accountClaims[0]).toMatchObject({
    resolution: 'ambiguous',
    resolvedAccountId: null,
  });
  const review = {
    runId: 'sync-ambiguous-local-account',
    institutionId: 'bank-of-america' as const,
    downloaded: 1,
    readyToImport: 1,
    alreadyImported: 0,
    artifacts: [artifact],
  };
  await saveAwaitingSyncReview(review);
  await expect(caller.dataSync.confirm({ runId: review.runId })).rejects.toThrow(
    'Resolve every source account before confirming the catch-up.',
  );
  expect(getDb().prepare('SELECT status FROM importFiles WHERE id = ?').get(ambiguousLocal.importFileId))
    .toEqual({ status: 'previewed' });
});

test('discarding an institution catch-up leaves staged facts out of the ledger and history', async () => {
  const accountId = Number(insertRow('accounts', {
    name: 'Primary Checking',
    institution: 'Bank of America',
    type: 'checking',
    currentBalance: 0,
    currency: 'USD',
    status: 'active',
  }));
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'easymoney-sync-discard-'));
  const fileName = 'bofa-checking-1234-2026-02-01-to-2026-02-28.csv';
  const filePath = path.join(directory, fileName);
  await fs.promises.writeFile(filePath, [
    'Description,,Summary Amt.',
    'Opening Balance,,1000.00',
    'Date,Description,Amount,Running Bal.',
    '02/05/2026,EXAMPLE PAYROLL,2500.00,3500.00',
  ].join('\n'));

  try {
    const artifact = await stageSyncArtifact({ path: filePath, accountId });
    const review = {
      runId: 'sync-test-discard',
      institutionId: 'bank-of-america' as const,
      downloaded: 1,
      readyToImport: 1,
      alreadyImported: 0,
      artifacts: [artifact],
    };
    await saveAwaitingSyncReview(review);
    const discardedJob = await caller.dataSync.discard({ runId: review.runId });
    expect(discardedJob.status).toBe('cancelled');

    expect(getDb().prepare('SELECT status FROM importFiles WHERE id = ?').get(artifact.importFileId))
      .toEqual({ status: 'discarded' });
    expect(getDb().prepare('SELECT status FROM sourceFiles WHERE importFileId = ?').get(artifact.importFileId))
      .toEqual({ status: 'discarded' });
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM ledgerTransactions').get()).toEqual({ count: 0 });
    expect((await listImportHistoryForTest()).imports).toHaveLength(0);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
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

  await commitImportForTest( {
    accountId,
    importFileId: firstPreview.importFileId,
    importRowIds: firstPreview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
  });
  await commitImportForTest( {
    accountId,
    importFileId: secondPreview.importFileId,
    importRowIds: secondPreview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
  });

  expect(getDb().prepare('SELECT COUNT(*) AS count FROM ledgerTransactions WHERE accountId = ?').get(accountId)).toMatchObject({ count: 2 });

  const importFileIds = [firstPreview.importFileId, secondPreview.importFileId];
  const unimport = await caller.imports.bulkUnimport({ importFileIds });
  expect(unimport).toMatchObject({ ok: true, count: 2, importFileIds });
  expect(getDb().prepare('SELECT COUNT(*) AS count FROM ledgerTransactions WHERE accountId = ?').get(accountId)).toMatchObject({ count: 0 });
  expect(getDb().prepare("SELECT COUNT(*) AS count FROM importFiles WHERE status = 'unimported'").get()).toMatchObject({ count: 2 });
  expect(getDb().prepare('SELECT COUNT(*) AS count FROM sourceAccounts WHERE accountId = ?').get(accountId)).toMatchObject({ count: 2 });

  const reimport = await caller.imports.bulkReimport({ importFileIds });
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

  const commit = await commitImportForTest( {
    accountId: null,
    importFileId,
    importRowIds: [transactionRowId],
  });

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
  await commitImportForTest( {
    accountId,
    importFileId: preview.importFileId,
    importRowIds: preview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
  });

  const payroll = getDb().prepare("SELECT id, ledgerTransactionId FROM transactions WHERE description = 'ACME PAYROLL'").get() as {
    id: number;
    ledgerTransactionId: string;
  };
  await updateTransactionForTest(payroll.id, {
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

  const body = await listTransactionsForTest({ search: 'source-fact-safe' });
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

  const commit = await commitImportForTest( {
    accountId,
    importFileId,
    importRowIds: [],
    balanceRowIds: [balanceRowId],
  });

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
    sourceAccountHolder: null,
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
    accountHolder: 'Manual Owner',
  }));
  const preview = await postImportPreview('bofa-checking-1234-2026-01-01-to-2026-01-31.csv', [
    'Description,,Summary Amt.',
    'Opening Balance,,"1,000.00"',
    'Date,Description,Amount,Running Bal.',
    '01/05/2026,TRANSFER IN,"1,500.00","2,500.00"',
  ].join('\n'));

  const sourceAccountId = preview.accountMappings[0].sourceAccountId;
  getDb().prepare('UPDATE sourceAccounts SET accountHolder = ? WHERE id = ?').run('Parsed Owner', sourceAccountId);
  const commit = await commitImportForTest( {
    accountId: null,
    importFileId: preview.importFileId,
    importRowIds: preview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
    balanceRowIds: preview.balanceRowIds,
    accountMappings: [{
      sourceAccountId,
      accountId: existingAccountId,
    }],
  });

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
  expect(getDb().prepare('SELECT accountHolder FROM accounts WHERE id = ?').get(existingAccountId)).toEqual({
    accountHolder: 'Manual Owner',
  });
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

  await expect(commitImportForTest({
    accountId: null,
    importFileId: preview.importFileId,
    importRowIds: preview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
    accountMappings: [{ sourceAccountId: preview.accountMappings[0].sourceAccountId, mode: 'auto' }],
  })).rejects.toThrow('Import account mapping requires an explicit account choice.');

  const commit = await commitImportForTest( {
    accountId: null,
    importFileId: preview.importFileId,
    importRowIds: preview.transactions.map((transaction: { importRowId: number }) => transaction.importRowId),
    balanceRowIds: preview.balanceRowIds,
    accountMappings: [{
      sourceAccountId: preview.accountMappings[0].sourceAccountId,
      mode: 'unarchive',
      accountId: archivedAccountId,
    }],
  });

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

  const commit = await commitImportForTest( {
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
        accountHolder: 'Example Owner',
      },
    }],
  });

  expect(commit.importedCount).toBe(1);
  const account = getDb().prepare("SELECT * FROM accounts WHERE name = 'Imported Savings'").get() as {
    id: number;
    institution: string;
    type: string;
    status: string;
    accountHolder: string | null;
  };
  expect(account).toMatchObject({
    institution: 'Bank of America',
    type: 'savings',
    accountHolder: 'Example Owner',
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
    commitImportForTest({
      accountId,
      importFileId: preview.importFileId,
      importRowIds: preview.transactions.map(transaction => transaction.importRowId),
    });

  await commitPreview(previewA);
  await commitPreview(previewB);
  const forward = snapshotAccountTransactions(accountId);

  resetMaterializedImports(accountId);

  await commitPreview(previewB);
  await commitPreview(previewA);
  const reverse = snapshotAccountTransactions(accountId);

  expect(reverse).toEqual(forward);
});
