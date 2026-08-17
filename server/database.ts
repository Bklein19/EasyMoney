import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashContent } from './hash.ts';

type DatabaseValue = string | number | bigint | boolean | null | Uint8Array | Date;
type DatabaseParams = DatabaseValue | object | undefined;
type DatabaseRow = Record<string, any>;
type MutableDatabaseRow = Record<string, DatabaseValue | undefined>;

interface WrappedStatement {
  all: (...params: DatabaseParams[]) => DatabaseRow[];
  get: (...params: DatabaseParams[]) => DatabaseRow | undefined;
  run: (...params: DatabaseParams[]) => { changes: number; lastInsertRowid: number };
}

interface WrappedDatabase {
  exec: (sql: string) => void;
  prepare: (sql: string) => WrappedStatement;
  transaction: <Args extends unknown[], Result>(fn: (...args: Args) => Result) => (...args: Args) => Result;
}

interface TransactionIdentityInput {
  id?: string | number | null;
  accountId?: string | number | null;
  date?: string | null;
  amount?: string | number | null;
  originalDescription?: string | null;
  description?: string | null;
  merchant?: string | null;
  transactionKind?: string | null;
  sourceRole?: string | null;
  stableSourceId?: string | null;
  importFileId?: string | number | null;
  importRowId?: string | number | null;
  sourceRowIndex?: string | number | null;
  fingerprint?: string | null;
  createdAt?: string | null;
}

interface TransactionFingerprintInput {
  accountId?: string | number | null;
  date?: string | null;
  amount?: string | number | null;
  originalDescription?: string | null;
  description?: string | null;
  merchant?: string | null;
}

interface StableSourceTransactionInput {
  importFileId?: string | number | null;
  sourceRowIndex?: string | number | null;
  date?: string | null;
  amountCents?: string | number | null;
  description?: string | null;
  sourceRole?: string | null;
}

interface SourceAccountRepairRow extends DatabaseRow {
  id: number;
  accountId: number;
  accountType: string;
}

interface SourceTransactionRepairRow extends DatabaseRow {
  amountCents: number;
  description: string | null;
  rawJson: string | null;
}

interface SourceTransactionFlipRow extends DatabaseRow {
  id: number;
  importFileId: number | null;
  rowIndex: number | null;
  normalizedJson: string | null;
  date: string | null;
  amountCents: number;
  description: string | null;
  sourceRole: string | null;
}

interface TableInfoRow extends DatabaseRow {
  name: string;
}

interface IndexListRow extends DatabaseRow {
  name: string;
  unique: number;
  origin: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (process.env.NODE_ENV === 'test' && !process.env.EASYMONEY_DB_PATH) {
  throw new Error('Tests must set EASYMONEY_DB_PATH before importing the database');
}
const dbPath = process.env.EASYMONEY_DB_PATH
  ? path.resolve(process.env.EASYMONEY_DB_PATH)
  : path.resolve(__dirname, '..', 'data', 'easymoney.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath, { create: true });
sqlite.run('PRAGMA journal_mode = WAL');
sqlite.run('PRAGMA foreign_keys = ON');

function normalizeSql(sql: string) {
  return sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, '$$$1');
}

function normalizeParams(params: DatabaseParams) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  return Object.fromEntries(
    Object.entries(params).flatMap(([key, value]) => (
      key.startsWith('$') ? [[key, value]] : [[key, value], [`$${key}`, value]]
    ))
  );
}

function normalizeIdentityText(value: string | number | null | undefined = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeIdentityDate(value: string | null | undefined = '') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function transactionIdentityBaseKey(transaction: TransactionIdentityInput) {
  return [
    transaction.accountId || '',
    normalizeIdentityDate(transaction.date),
    Number(transaction.amount || 0).toFixed(2),
    normalizeIdentityText(transaction.originalDescription || transaction.description || transaction.merchant || ''),
    normalizeIdentityText(transaction.sourceRole || transaction.transactionKind || 'activity'),
  ].join('|');
}

function transactionOccurrenceSortKey(transaction: TransactionIdentityInput) {
  const token = (value: string | number | null | undefined) => typeof value === 'number' ? String(value).padStart(16, '0') : String(value || '');
  return [
    transaction.stableSourceId || '',
    token(transaction.importFileId),
    token(transaction.importRowId),
    token(transaction.sourceRowIndex),
    transaction.fingerprint || '',
    transaction.createdAt || '',
    token(transaction.id),
    normalizeIdentityDate(transaction.date),
    Number(transaction.amount || 0).toFixed(2),
    normalizeIdentityText(transaction.originalDescription || transaction.description || transaction.merchant || ''),
  ].join('|');
}

function ledgerTransactionIdFor(transaction: TransactionIdentityInput, occurrenceIndex: number) {
  return `txn_${hashContent(`${transactionIdentityBaseKey(transaction)}|${occurrenceIndex}`).slice(0, 32)}`;
}

function isCreditAccountType(type: string | null | undefined) {
  return type === 'credit' || type === 'credit_card' || type === 'credit-card';
}

function isLikelyCreditCardPaymentDescription(description: string | null | undefined = '') {
  return /\b(payment|pmt|autopay|auto pay|online transfer|thank you)\b/i.test(String(description || ''));
}

function transactionFingerprintFor({ accountId, date, amount, originalDescription, description, merchant }: TransactionFingerprintInput) {
  const text = normalizeIdentityText(originalDescription || description || merchant || '');
  return [
    accountId,
    normalizeIdentityDate(date),
    Number(amount || 0).toFixed(2),
    text,
  ].join('|');
}

function stableSourceTransactionIdFor({ importFileId, sourceRowIndex, date, amountCents, description, sourceRole }: StableSourceTransactionInput) {
  return `src_txn_${hashContent([
    importFileId,
    sourceRowIndex,
    date,
    amountCents,
    normalizeIdentityText(description),
    sourceRole,
  ].join('|')).slice(0, 32)}`;
}

function wrapStatement(statement: { all: (...params: any[]) => any[]; get: (...params: any[]) => any; run: (...params: any[]) => { changes: number; lastInsertRowid: number | bigint } }): WrappedStatement {
  return {
    all: (...params) => statement.all(...params.map(normalizeParams)),
    get: (...params) => statement.get(...params.map(normalizeParams)),
    run: (...params) => {
      const result = statement.run(...params.map(normalizeParams));
      return { ...result, lastInsertRowid: Number(result.lastInsertRowid) };
    },
  };
}

const db: WrappedDatabase = {
  exec: (sql) => sqlite.exec(sql),
  prepare: (sql) => wrapStatement(sqlite.prepare(normalizeSql(sql))),
  transaction: (fn) => sqlite.transaction(fn),
};

function tableColumnNames(tableName: string) {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[]).map(column => column.name);
}

function runSchemaMigration(name: string, migrate: () => void) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS schemaMigrations (
      name TEXT PRIMARY KEY,
      appliedAt TEXT NOT NULL
    )
  `).run();

  const existing = db.prepare('SELECT name FROM schemaMigrations WHERE name = ?').get(name);
  if (existing) return;

  db.transaction(() => {
    migrate();
    db.prepare('INSERT INTO schemaMigrations (name, appliedAt) VALUES (?, ?)').run(name, new Date().toISOString());
  })();
}

function repairCreditCardCashflowSigns() {
  const sourceAccounts = db.prepare(`
    SELECT
      sa.id,
      a.id AS accountId,
      a.type AS accountType
    FROM sourceAccounts sa
    JOIN accounts a ON a.id = sa.accountId
    WHERE a.type IN ('credit', 'credit_card', 'credit-card')
  `).all() as SourceAccountRepairRow[];

  const sourceAccountIdsToFlip = [];
  for (const sourceAccount of sourceAccounts) {
    if (!isCreditAccountType(sourceAccount.accountType)) continue;
    const rows = db.prepare(`
      SELECT amountCents, description, rawJson
      FROM sourceTransactions
      WHERE sourceAccountId = ?
    `).all(sourceAccount.id) as SourceTransactionRepairRow[];
    const moneyRows = rows.filter(row => {
      try {
        const raw = JSON.parse(row.rawJson || '{}');
        return Boolean(raw.moneyCategory);
      } catch {
        return false;
      }
    });
    if (!moneyRows.length) continue;

    const purchaseRows = moneyRows.filter(row => !isLikelyCreditCardPaymentDescription(row.description));
    const positivePurchases = purchaseRows.filter(row => Number(row.amountCents) > 0).length;
    const negativePurchases = purchaseRows.filter(row => Number(row.amountCents) < 0).length;
    if (positivePurchases > negativePurchases) {
      sourceAccountIdsToFlip.push(sourceAccount.id);
    }
  }

  if (!sourceAccountIdsToFlip.length) return;

  const sourceRowsToFlip = db.prepare(`
    SELECT
      st.id,
      st.sourceFileId,
      st.importRowId,
      st.date,
      st.amountCents,
      st.description,
      st.sourceRole,
      ir.importFileId,
      ir.rowIndex,
      ir.normalizedJson
    FROM sourceTransactions st
    LEFT JOIN importRows ir ON ir.id = st.importRowId
    WHERE st.sourceAccountId = ?
  `);
  const updateSourceTransaction = db.prepare(`
    UPDATE sourceTransactions
    SET amountCents = ?, stableSourceId = ?
    WHERE id = ?
  `);
  const updateImportRow = db.prepare(`
    UPDATE importRows
    SET normalizedJson = ?
    WHERE id = ?
  `);

  for (const sourceAccountId of sourceAccountIdsToFlip) {
    for (const row of sourceRowsToFlip.all(sourceAccountId) as SourceTransactionFlipRow[]) {
      const amountCents = -Number(row.amountCents || 0);
      const sourceRowIndex = row.normalizedJson
        ? JSON.parse(row.normalizedJson).sourceRowIndex ?? row.rowIndex
        : row.rowIndex;
      const stableSourceId = stableSourceTransactionIdFor({
        importFileId: row.importFileId,
        sourceRowIndex,
        date: row.date,
        amountCents,
        description: row.description,
        sourceRole: row.sourceRole,
      });
      updateSourceTransaction.run(amountCents, stableSourceId, row.id);

      if (row.importRowId && row.normalizedJson) {
        const normalized = JSON.parse(row.normalizedJson);
        normalized.amountCents = amountCents;
        updateImportRow.run(JSON.stringify(normalized), row.importRowId);
      }
    }
  }

  const materializedRows = db.prepare(`
    SELECT
      lt.id AS ledgerRowId,
      lt.legacyTransactionId,
      lt.accountId,
      lt.date,
      lt.amountCents,
      lt.description,
      lt.merchant,
      lt.originalDescription,
      lt.sourceTransactionId
    FROM ledgerTransactions lt
    JOIN sourceTransactions st ON st.id = lt.sourceTransactionId
    WHERE st.sourceAccountId = ?
  `);
  const updateLedgerTransaction = db.prepare(`
    UPDATE ledgerTransactions
    SET amountCents = @amountCents,
        type = @type,
        transactionKind = @transactionKind,
        fingerprint = @fingerprint,
        updatedAt = @updatedAt
    WHERE id = @id
  `);
  const updateLegacyTransaction = db.prepare(`
    UPDATE transactions
    SET amount = @amount,
        type = @type,
        transactionKind = @transactionKind,
        fingerprint = @fingerprint
    WHERE id = @id
  `);
  const updateImportRowFingerprint = db.prepare(`
    UPDATE importRows
    SET fingerprint = ?
    WHERE transactionId = ?
  `);
  const now = new Date().toISOString();

  for (const sourceAccountId of sourceAccountIdsToFlip) {
    for (const row of materializedRows.all(sourceAccountId)) {
      const amountCents = -Number(row.amountCents || 0);
      const amount = Math.round(amountCents) / 100;
      const type = amountCents >= 0 ? 'credit' : 'debit';
      const transactionKind = amountCents > 0 ? 'card_payment' : null;
      const fingerprint = transactionFingerprintFor({
        accountId: row.accountId,
        date: row.date,
        amount,
        originalDescription: row.originalDescription,
        description: row.description,
        merchant: row.merchant,
      });
      updateLedgerTransaction.run({
        id: row.ledgerRowId,
        amountCents,
        type,
        transactionKind,
        fingerprint,
        updatedAt: now,
      });
      if (row.legacyTransactionId) {
        updateLegacyTransaction.run({
          id: row.legacyTransactionId,
          amount,
          type,
          transactionKind,
          fingerprint,
        });
        updateImportRowFingerprint.run(fingerprint, row.legacyTransactionId);
      }
    }
  }
}

const TABLES = {
  accounts: ['id', 'name', 'institution', 'type', 'currentBalance', 'currency', 'accountHolder', 'status', 'archivedAt', 'createdAt', 'updatedAt'],
  accountAliases: ['id', 'institution', 'alias', 'accountId', 'createdAt', 'updatedAt'],
  transactions: [
    'id', 'accountId', 'categoryId', 'date', 'amount', 'importBatchId', 'description', 'merchant',
    'originalDescription', 'originalCategory', 'type', 'transactionKind', 'status', 'notes', 'fingerprint',
    'ledgerTransactionId', 'occurrenceIndex', 'createdAt'
  ],
  ledgerTransactions: [
    'id', 'ledgerTransactionId', 'legacyTransactionId', 'accountId', 'date', 'amountCents',
    'importBatchId', 'description', 'merchant', 'originalDescription', 'originalCategory',
    'type', 'transactionKind', 'status', 'fingerprint', 'sourceRole', 'occurrenceIndex',
    'importFileId', 'importRowId', 'sourceTransactionId', 'createdAt', 'updatedAt'
  ],
  transactionAnnotations: ['ledgerTransactionId', 'categoryId', 'notes', 'createdAt', 'updatedAt'],
  transactionCategoryUndoOperations: ['id', 'categoryName', 'transactionCount', 'payloadJson', 'status', 'createdAt', 'consumedAt'],
  merchantGroupingRules: ['id', 'sourceMerchantKey', 'strategy', 'createdAt', 'updatedAt'],
  categories: ['id', 'name', 'parentId', 'type', 'categoryGroup', 'description', 'color', 'icon'],
  budgets: ['id', 'categoryId', 'month', 'amount'],
  balanceSnapshots: ['id', 'accountId', 'month', 'balance', 'capturedAt'],
  ledgerBalances: ['id', 'accountId', 'month', 'balanceCents', 'capturedAt', 'sourceBalanceId', 'createdAt', 'updatedAt'],
  categorizationRules: ['id', 'categoryId', 'pattern', 'matchType', 'priority'],
  importProfiles: ['id', 'headerSignature', 'profileName', 'profileJson', 'mappingJson', 'lastAccountId', 'createdAt', 'updatedAt'],
  importFiles: [
    'id', 'fileName', 'contentHash', 'parserName', 'headerSignature', 'rowCount',
    'sourceType', 'parserPriority', 'institution', 'status', 'importBatchId', 'createdAt', 'committedAt'
  ],
  importRows: [
    'id', 'importFileId', 'rowIndex', 'rowType', 'rawJson', 'normalizedJson',
    'fingerprint', 'transactionId', 'createdAt'
  ],
  sourceFiles: [
    'id', 'importFileId', 'fileName', 'contentHash', 'parserName', 'sourceType',
    'parserPriority', 'institution', 'coveredFrom', 'coveredTo', 'status', 'createdAt', 'committedAt'
  ],
  sourceAccounts: [
    'id', 'sourceFileId', 'accountId', 'institution', 'sourceAccountKey', 'sourceAccountName', 'accountHolder', 'rawJson', 'createdAt'
  ],
  sourceTransactions: [
    'id', 'sourceFileId', 'sourceAccountId', 'importRowId', 'stableSourceId', 'date',
    'amountCents', 'description', 'sourceRole', 'priority', 'rawJson', 'createdAt'
  ],
  sourceBalances: [
    'id', 'sourceFileId', 'sourceAccountId', 'importRowId', 'date', 'balanceCents',
    'priority', 'rawJson', 'createdAt'
  ]
} as const;

type TableName = keyof typeof TABLES;

const ORDER_BY: Partial<Record<TableName, string>> = {
  accounts: 'id ASC',
  transactions: 'date DESC, id DESC',
  ledgerTransactions: 'date DESC, id DESC',
  transactionAnnotations: 'updatedAt DESC, ledgerTransactionId ASC',
  transactionCategoryUndoOperations: 'createdAt DESC, id DESC',
  merchantGroupingRules: 'sourceMerchantKey ASC, id ASC',
  categories: 'id ASC',
  budgets: 'month DESC, id DESC',
  balanceSnapshots: 'month ASC, id ASC',
  ledgerBalances: 'month ASC, id ASC',
  categorizationRules: 'priority DESC, id ASC',
  importProfiles: 'updatedAt DESC, id DESC',
  importFiles: 'createdAt DESC, id DESC',
  importRows: 'importFileId ASC, rowIndex ASC',
  sourceFiles: 'createdAt DESC, id DESC',
  sourceAccounts: 'sourceFileId ASC, id ASC',
  sourceTransactions: 'date DESC, id DESC',
  sourceBalances: 'date DESC, id DESC'
};

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      institution TEXT,
      type TEXT NOT NULL,
      currentBalance REAL DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      accountHolder TEXT,
      status TEXT DEFAULT 'active',
      archivedAt TEXT,
      createdAt TEXT,
      updatedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS accountAliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      institution TEXT NOT NULL,
      alias TEXT NOT NULL,
      accountId INTEGER NOT NULL,
      createdAt TEXT,
      updatedAt TEXT,
      UNIQUE(institution, alias),
      FOREIGN KEY(accountId) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      accountId INTEGER,
      categoryId INTEGER,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      importBatchId TEXT,
      description TEXT,
      merchant TEXT,
      originalDescription TEXT,
      originalCategory TEXT,
      type TEXT,
      transactionKind TEXT,
      status TEXT,
      notes TEXT,
      fingerprint TEXT,
      ledgerTransactionId TEXT,
      occurrenceIndex INTEGER DEFAULT 0,
      createdAt TEXT
    );

    CREATE TABLE IF NOT EXISTS ledgerTransactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ledgerTransactionId TEXT NOT NULL UNIQUE,
      legacyTransactionId INTEGER,
      accountId INTEGER NOT NULL,
      date TEXT NOT NULL,
      amountCents INTEGER NOT NULL,
      importBatchId TEXT,
      description TEXT,
      merchant TEXT,
      originalDescription TEXT,
      originalCategory TEXT,
      type TEXT,
      transactionKind TEXT,
      status TEXT,
      fingerprint TEXT,
      sourceRole TEXT,
      occurrenceIndex INTEGER DEFAULT 0,
      importFileId INTEGER,
      importRowId INTEGER,
      sourceTransactionId INTEGER,
      createdAt TEXT,
      updatedAt TEXT,
      FOREIGN KEY(accountId) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY(legacyTransactionId) REFERENCES transactions(id) ON DELETE SET NULL,
      FOREIGN KEY(importFileId) REFERENCES importFiles(id) ON DELETE SET NULL,
      FOREIGN KEY(importRowId) REFERENCES importRows(id) ON DELETE SET NULL,
      FOREIGN KEY(sourceTransactionId) REFERENCES sourceTransactions(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS transactionAnnotations (
      ledgerTransactionId TEXT PRIMARY KEY,
      categoryId INTEGER,
      notes TEXT,
      createdAt TEXT,
      updatedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS transactionCategoryUndoOperations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      categoryName TEXT NOT NULL,
      transactionCount INTEGER NOT NULL,
      payloadJson TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      createdAt TEXT NOT NULL,
      consumedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS merchantGroupingRules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sourceMerchantKey TEXT NOT NULL UNIQUE,
      strategy TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      parentId INTEGER,
      type TEXT,
      categoryGroup TEXT,
      description TEXT,
      color TEXT,
      icon TEXT
    );

    CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      categoryId INTEGER NOT NULL,
      month TEXT NOT NULL,
      amount REAL NOT NULL,
      UNIQUE(categoryId, month)
    );

    CREATE TABLE IF NOT EXISTS balanceSnapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      accountId INTEGER NOT NULL,
      month TEXT NOT NULL,
      balance REAL NOT NULL,
      capturedAt TEXT,
      UNIQUE(accountId, month)
    );

    CREATE TABLE IF NOT EXISTS ledgerBalances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      accountId INTEGER NOT NULL,
      month TEXT NOT NULL,
      balanceCents INTEGER NOT NULL,
      capturedAt TEXT,
      sourceBalanceId INTEGER,
      createdAt TEXT,
      updatedAt TEXT,
      UNIQUE(accountId, month),
      FOREIGN KEY(accountId) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY(sourceBalanceId) REFERENCES sourceBalances(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS categorizationRules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      categoryId INTEGER NOT NULL,
      pattern TEXT NOT NULL,
      matchType TEXT DEFAULT 'contains',
      priority INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS importProfiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      headerSignature TEXT NOT NULL UNIQUE,
      profileName TEXT,
      profileJson TEXT NOT NULL,
      mappingJson TEXT,
      lastAccountId INTEGER,
      createdAt TEXT,
      updatedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS importFiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fileName TEXT NOT NULL,
      contentHash TEXT NOT NULL,
      parserName TEXT,
      headerSignature TEXT,
      rowCount INTEGER DEFAULT 0,
      sourceType TEXT,
      parserPriority INTEGER,
      institution TEXT,
      status TEXT DEFAULT 'previewed',
      importBatchId TEXT,
      createdAt TEXT,
      committedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS importRows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      importFileId INTEGER NOT NULL,
      rowIndex INTEGER NOT NULL,
      rowType TEXT DEFAULT 'transaction',
      rawJson TEXT NOT NULL,
      normalizedJson TEXT,
      fingerprint TEXT,
      transactionId INTEGER,
      createdAt TEXT,
      UNIQUE(importFileId, rowIndex),
      FOREIGN KEY(importFileId) REFERENCES importFiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sourceFiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      importFileId INTEGER,
      fileName TEXT NOT NULL,
      contentHash TEXT NOT NULL,
      parserName TEXT,
      sourceType TEXT,
      parserPriority INTEGER,
      institution TEXT,
      coveredFrom TEXT,
      coveredTo TEXT,
      status TEXT DEFAULT 'previewed',
      createdAt TEXT,
      committedAt TEXT,
      UNIQUE(importFileId),
      FOREIGN KEY(importFileId) REFERENCES importFiles(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS sourceAccounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sourceFileId INTEGER NOT NULL,
      accountId INTEGER,
      institution TEXT,
      sourceAccountKey TEXT NOT NULL,
      sourceAccountName TEXT,
      accountHolder TEXT,
      rawJson TEXT,
      createdAt TEXT,
      UNIQUE(sourceFileId, institution, sourceAccountKey),
      FOREIGN KEY(sourceFileId) REFERENCES sourceFiles(id) ON DELETE CASCADE,
      FOREIGN KEY(accountId) REFERENCES accounts(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS sourceTransactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sourceFileId INTEGER NOT NULL,
      sourceAccountId INTEGER NOT NULL,
      importRowId INTEGER,
      stableSourceId TEXT NOT NULL,
      date TEXT NOT NULL,
      amountCents INTEGER NOT NULL,
      description TEXT,
      sourceRole TEXT,
      priority INTEGER,
      rawJson TEXT,
      createdAt TEXT,
      UNIQUE(sourceFileId, stableSourceId),
      FOREIGN KEY(sourceFileId) REFERENCES sourceFiles(id) ON DELETE CASCADE,
      FOREIGN KEY(sourceAccountId) REFERENCES sourceAccounts(id) ON DELETE CASCADE,
      FOREIGN KEY(importRowId) REFERENCES importRows(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS sourceBalances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sourceFileId INTEGER NOT NULL,
      sourceAccountId INTEGER NOT NULL,
      importRowId INTEGER,
      date TEXT NOT NULL,
      balanceCents INTEGER NOT NULL,
      priority INTEGER,
      rawJson TEXT,
      createdAt TEXT,
      FOREIGN KEY(sourceFileId) REFERENCES sourceFiles(id) ON DELETE CASCADE,
      FOREIGN KEY(sourceAccountId) REFERENCES sourceAccounts(id) ON DELETE CASCADE,
      FOREIGN KEY(importRowId) REFERENCES importRows(id) ON DELETE SET NULL
    );

  `);

  runSchemaMigration('2026-06-20-account-owner', () => {
    if (!tableColumnNames('accounts').includes('accountHolder')) {
      db.prepare('ALTER TABLE accounts ADD COLUMN accountHolder TEXT').run();
    }
  });

  runSchemaMigration('2026-07-06-source-account-owner', () => {
    if (!tableColumnNames('sourceAccounts').includes('accountHolder')) {
      db.prepare('ALTER TABLE sourceAccounts ADD COLUMN accountHolder TEXT').run();
    }
  });

  runSchemaMigration('2026-06-22-category-groups', () => {
    if (!tableColumnNames('categories').includes('categoryGroup')) {
      db.prepare('ALTER TABLE categories ADD COLUMN categoryGroup TEXT').run();
    }
  });

  runSchemaMigration('2026-06-23-category-descriptions', () => {
    if (!tableColumnNames('categories').includes('description')) {
      db.prepare('ALTER TABLE categories ADD COLUMN description TEXT').run();
    }
  });

  const transactionColumns = tableColumnNames('transactions');
  if (!transactionColumns.includes('fingerprint')) {
    db.prepare('ALTER TABLE transactions ADD COLUMN fingerprint TEXT').run();
  }
  if (!transactionColumns.includes('ledgerTransactionId')) {
    db.prepare('ALTER TABLE transactions ADD COLUMN ledgerTransactionId TEXT').run();
  }
  if (!transactionColumns.includes('occurrenceIndex')) {
    db.prepare('ALTER TABLE transactions ADD COLUMN occurrenceIndex INTEGER DEFAULT 0').run();
  }
  db.prepare('CREATE INDEX IF NOT EXISTS idx_transactions_ledger_id ON transactions (ledgerTransactionId)').run();

  const transactionsNeedingLedgerIds = db.prepare(`
    SELECT
      t.id,
      t.accountId,
      t.date,
      t.amount,
      t.description,
      t.merchant,
      t.originalDescription,
      t.transactionKind,
      t.occurrenceIndex,
      t.importBatchId,
      t.fingerprint,
      t.createdAt,
      ir.importFileId,
      ir.id AS importRowId,
      ir.rowIndex AS sourceRowIndex,
      st.stableSourceId
    FROM transactions t
    LEFT JOIN importRows ir ON ir.transactionId = t.id
    LEFT JOIN sourceTransactions st ON st.importRowId = ir.id
    WHERE t.ledgerTransactionId IS NULL OR t.ledgerTransactionId = ''
  `).all();
  const groups = new Map<string, TransactionIdentityInput[]>();
  for (const transaction of transactionsNeedingLedgerIds) {
    const baseKey = transactionIdentityBaseKey(transaction);
    const group = groups.get(baseKey);
    if (group) {
      group.push(transaction);
    } else {
      groups.set(baseKey, [transaction]);
    }
  }
  for (const group of groups.values()) {
    group
      .sort((a, b) => transactionOccurrenceSortKey(a).localeCompare(transactionOccurrenceSortKey(b)))
      .forEach((transaction, occurrenceIndex) => {
        db.prepare('UPDATE transactions SET ledgerTransactionId = ?, occurrenceIndex = ? WHERE id = ?').run(
          ledgerTransactionIdFor(transaction, occurrenceIndex),
          occurrenceIndex,
          transaction.id
        );
      });
  }

  db.prepare(`
    INSERT OR IGNORE INTO transactionAnnotations (ledgerTransactionId, categoryId, notes, createdAt, updatedAt)
    SELECT ledgerTransactionId, categoryId, notes, COALESCE(createdAt, datetime('now')), datetime('now')
    FROM transactions
    WHERE ledgerTransactionId IS NOT NULL
      AND ledgerTransactionId != ''
      AND (categoryId IS NOT NULL OR COALESCE(notes, '') != '')
  `).run();

  const importFileColumns = tableColumnNames('importFiles');
  for (const [column, definition] of [
    ['sourceType', 'TEXT'],
    ['parserPriority', 'INTEGER'],
    ['institution', 'TEXT'],
  ]) {
    if (!importFileColumns.includes(column)) {
      db.prepare(`ALTER TABLE importFiles ADD COLUMN ${column} ${definition}`).run();
    }
  }

  const importRowColumns = tableColumnNames('importRows');
  if (!importRowColumns.includes('rowType')) {
    db.prepare("ALTER TABLE importRows ADD COLUMN rowType TEXT DEFAULT 'transaction'").run();
  }

  const accountColumns = tableColumnNames('accounts');
  if (!accountColumns.includes('status')) {
    db.prepare("ALTER TABLE accounts ADD COLUMN status TEXT DEFAULT 'active'").run();
  }
  if (!accountColumns.includes('archivedAt')) {
    db.prepare('ALTER TABLE accounts ADD COLUMN archivedAt TEXT').run();
  }
  db.prepare("UPDATE accounts SET status = 'active' WHERE status IS NULL OR status = ''").run();

  const sourceAccountColumns = tableColumnNames('sourceAccounts');
  if (!sourceAccountColumns.includes('accountId')) {
    db.prepare('ALTER TABLE sourceAccounts ADD COLUMN accountId INTEGER').run();
  }

  runSchemaMigration('2026-06-23-credit-card-cashflow-signs', repairCreditCardCashflowSigns);

  const sourceBalanceIndexes = db.prepare('PRAGMA index_list(sourceBalances)').all() as IndexListRow[];
  const hasLegacySourceBalanceUniqueIndex = sourceBalanceIndexes.some(index =>
    index.unique === 1 &&
    index.origin === 'u' &&
    (db.prepare(`PRAGMA index_info(${index.name})`).all() as TableInfoRow[]).map(column => column.name).join(',') === 'sourceFileId,sourceAccountId,date'
  );
  if (hasLegacySourceBalanceUniqueIndex) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE sourceBalances_next (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sourceFileId INTEGER NOT NULL,
          sourceAccountId INTEGER NOT NULL,
          importRowId INTEGER,
          date TEXT NOT NULL,
          balanceCents INTEGER NOT NULL,
          priority INTEGER,
          rawJson TEXT,
          createdAt TEXT,
          FOREIGN KEY(sourceFileId) REFERENCES sourceFiles(id) ON DELETE CASCADE,
          FOREIGN KEY(sourceAccountId) REFERENCES sourceAccounts(id) ON DELETE CASCADE,
          FOREIGN KEY(importRowId) REFERENCES importRows(id) ON DELETE SET NULL
        );
      `);
      db.prepare(`
        INSERT INTO sourceBalances_next (
          id, sourceFileId, sourceAccountId, importRowId, date, balanceCents, priority, rawJson, createdAt
        )
        SELECT id, sourceFileId, sourceAccountId, importRowId, date, balanceCents, priority, rawJson, createdAt
        FROM sourceBalances
      `).run();
      db.exec(`
        DROP TABLE sourceBalances;
        ALTER TABLE sourceBalances_next RENAME TO sourceBalances;
      `);
    })();
  }

  db.prepare('CREATE INDEX IF NOT EXISTS idx_ledger_transactions_account_date ON ledgerTransactions (accountId, date)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_ledger_transactions_legacy_id ON ledgerTransactions (legacyTransactionId)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_ledger_balances_account_month ON ledgerBalances (accountId, month)').run();
  syncLedgerReadModelFromLegacyTables();
}

export function syncLedgerReadModelFromLegacyTables() {
  assignMissingLegacyTransactionIds();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO ledgerTransactions (
        ledgerTransactionId,
        legacyTransactionId,
        accountId,
        date,
        amountCents,
        importBatchId,
        description,
        merchant,
        originalDescription,
        originalCategory,
        type,
        transactionKind,
        status,
        fingerprint,
        sourceRole,
        occurrenceIndex,
        importFileId,
        importRowId,
        sourceTransactionId,
        createdAt,
        updatedAt
      )
      SELECT
        t.ledgerTransactionId,
        t.id,
        t.accountId,
        t.date,
        CAST(ROUND(t.amount * 100) AS INTEGER),
        t.importBatchId,
        t.description,
        t.merchant,
        t.originalDescription,
        t.originalCategory,
        t.type,
        t.transactionKind,
        t.status,
        t.fingerprint,
        COALESCE(st.sourceRole, t.transactionKind, 'activity'),
        COALESCE(t.occurrenceIndex, 0),
        ir.importFileId,
        ir.id,
        st.id,
        COALESCE(t.createdAt, @now),
        @now
      FROM transactions t
      LEFT JOIN importRows ir ON ir.transactionId = t.id
      LEFT JOIN sourceTransactions st ON st.importRowId = ir.id
      WHERE t.ledgerTransactionId IS NOT NULL
        AND t.ledgerTransactionId != ''
        AND t.accountId IS NOT NULL
      ON CONFLICT(ledgerTransactionId) DO UPDATE SET
        legacyTransactionId = excluded.legacyTransactionId,
        accountId = excluded.accountId,
        date = excluded.date,
        amountCents = excluded.amountCents,
        importBatchId = excluded.importBatchId,
        description = excluded.description,
        merchant = excluded.merchant,
        originalDescription = excluded.originalDescription,
        originalCategory = excluded.originalCategory,
        type = excluded.type,
        transactionKind = excluded.transactionKind,
        status = excluded.status,
        fingerprint = excluded.fingerprint,
        sourceRole = excluded.sourceRole,
        occurrenceIndex = excluded.occurrenceIndex,
        importFileId = excluded.importFileId,
        importRowId = excluded.importRowId,
        sourceTransactionId = excluded.sourceTransactionId,
        updatedAt = excluded.updatedAt
    `).run({ now });

    db.prepare(`
      INSERT INTO ledgerBalances (
        accountId,
        month,
        balanceCents,
        capturedAt,
        sourceBalanceId,
        createdAt,
        updatedAt
      )
      SELECT
        bs.accountId,
        bs.month,
        CAST(ROUND(bs.balance * 100) AS INTEGER),
        bs.capturedAt,
        sb.id,
        COALESCE(bs.capturedAt, @now),
        @now
      FROM balanceSnapshots bs
      LEFT JOIN sourceBalances sb
        ON sb.id = (
          SELECT sb2.id
          FROM sourceBalances sb2
          JOIN sourceAccounts sa2 ON sa2.id = sb2.sourceAccountId
          WHERE sa2.accountId = bs.accountId
            AND substr(sb2.date, 1, 7) = bs.month
          ORDER BY sb2.date DESC, sb2.id DESC
          LIMIT 1
        )
      ON CONFLICT(accountId, month) DO UPDATE SET
        balanceCents = excluded.balanceCents,
        capturedAt = excluded.capturedAt,
        sourceBalanceId = excluded.sourceBalanceId,
        updatedAt = excluded.updatedAt
    `).run({ now });
  })();
}

function assignMissingLegacyTransactionIds() {
  const transactionsNeedingLedgerIds = db.prepare(`
    SELECT
      t.id,
      t.accountId,
      t.date,
      t.amount,
      t.description,
      t.merchant,
      t.originalDescription,
      t.transactionKind,
      t.occurrenceIndex,
      t.importBatchId,
      t.fingerprint,
      t.createdAt,
      ir.importFileId,
      ir.id AS importRowId,
      ir.rowIndex AS sourceRowIndex,
      st.stableSourceId
    FROM transactions t
    LEFT JOIN importRows ir ON ir.transactionId = t.id
    LEFT JOIN sourceTransactions st ON st.importRowId = ir.id
    WHERE t.ledgerTransactionId IS NULL OR t.ledgerTransactionId = ''
  `).all();
  const groups = new Map<string, TransactionIdentityInput[]>();
  for (const transaction of transactionsNeedingLedgerIds) {
    const baseKey = transactionIdentityBaseKey(transaction);
    const group = groups.get(baseKey);
    if (group) {
      group.push(transaction);
    } else {
      groups.set(baseKey, [transaction]);
    }
  }
  for (const group of groups.values()) {
    group
      .sort((a, b) => transactionOccurrenceSortKey(a).localeCompare(transactionOccurrenceSortKey(b)))
      .forEach((transaction, occurrenceIndex) => {
        db.prepare('UPDATE transactions SET ledgerTransactionId = ?, occurrenceIndex = ? WHERE id = ?').run(
          ledgerTransactionIdFor(transaction, occurrenceIndex),
          occurrenceIndex,
          transaction.id
        );
      });
  }
}

export function assertTable(table: string): asserts table is TableName {
  if (!(table in TABLES)) throw new Error(`Unknown table: ${table}`);
}

function cleanRow(table: TableName, row: DatabaseRow | null | undefined, includeId = false) {
  const allowed = new Set<string>(includeId ? [...TABLES[table]] : TABLES[table].filter(column => column !== 'id'));
  return Object.fromEntries(
    Object.entries(row || {}).filter(([key]) => allowed.has(key))
  ) as MutableDatabaseRow;
}

export function listRows(table: string, query: Record<string, string | number | null | undefined> = {}) {
  assertTable(table);
  const clauses: string[] = [];
  const params: MutableDatabaseRow = {};

  for (const key of ['accountId', 'categoryId', 'month', 'headerSignature', 'importFileId']) {
    if (query[key] !== undefined && query[key] !== '') {
      clauses.push(`${key} = @${key}`);
      params[key] = query[key];
    }
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM ${table} ${where} ORDER BY ${ORDER_BY[table] ?? 'id ASC'}`).all(params);
}

export function insertRow(table: string, row: DatabaseRow, preserveId = false): number {
  assertTable(table);
  const data = cleanRow(table, row, preserveId);
  const columns = Object.keys(data);
  const placeholders = columns.map(column => `@${column}`);
  const result = db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`
  ).run(data);
  return preserveId && data.id !== undefined && data.id !== null ? Number(data.id) : result.lastInsertRowid;
}

export function insertRows(table: string, rows: DatabaseRow[], preserveIds = false) {
  assertTable(table);
  const insert = db.transaction((items: DatabaseRow[]) => {
    for (const row of items) insertRow(table, row, preserveIds);
  });
  insert(rows);
}

export function updateRow(table: string, id: string | number, changes: DatabaseRow) {
  assertTable(table);
  const data = cleanRow(table, changes);
  const columns = Object.keys(data);
  if (columns.length === 0) return 0;
  const assignments = columns.map(column => `${column} = @${column}`).join(', ');
  return db.prepare(`UPDATE ${table} SET ${assignments} WHERE id = @id`).run({ ...data, id }).changes;
}

export function deleteRow(table: string, id: string | number) {
  assertTable(table);
  return db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes;
}

export function getDb() {
  return db;
}

export { hashContent } from './hash.ts';
