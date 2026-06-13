import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '..', 'data', 'easymoney.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath, { create: true });
sqlite.run('PRAGMA journal_mode = WAL');
sqlite.run('PRAGMA foreign_keys = ON');

function normalizeSql(sql) {
  return sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, '$$$1');
}

function normalizeParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  return Object.fromEntries(
    Object.entries(params).flatMap(([key, value]) => (
      key.startsWith('$') ? [[key, value]] : [[key, value], [`$${key}`, value]]
    ))
  );
}

function wrapStatement(statement) {
  return {
    all: (...params) => statement.all(...params.map(normalizeParams)),
    get: (...params) => statement.get(...params.map(normalizeParams)),
    run: (...params) => statement.run(...params.map(normalizeParams)),
  };
}

const db = {
  exec: (sql) => sqlite.exec(sql),
  prepare: (sql) => wrapStatement(sqlite.prepare(normalizeSql(sql))),
  transaction: (fn) => sqlite.transaction(fn),
};

const TABLES = {
  accounts: ['id', 'name', 'institution', 'type', 'currentBalance', 'currency', 'createdAt', 'updatedAt'],
  transactions: [
    'id', 'accountId', 'categoryId', 'date', 'amount', 'importBatchId', 'description', 'merchant',
    'originalDescription', 'originalCategory', 'type', 'transactionKind', 'status', 'notes', 'fingerprint', 'createdAt'
  ],
  categories: ['id', 'name', 'parentId', 'type', 'color', 'icon'],
  budgets: ['id', 'categoryId', 'month', 'amount'],
  balanceSnapshots: ['id', 'accountId', 'month', 'balance', 'capturedAt'],
  categorizationRules: ['id', 'categoryId', 'pattern', 'matchType', 'priority'],
  importProfiles: ['id', 'headerSignature', 'profileName', 'profileJson', 'mappingJson', 'lastAccountId', 'createdAt', 'updatedAt'],
  robinhoodAccounts: [
    'id', 'accountKey', 'label', 'accountNumberMasked', 'type', 'brokerageAccountType',
    'isDefault', 'agenticAllowed', 'createdAt', 'updatedAt'
  ],
  robinhoodSnapshots: ['id', 'fetchedAt', 'source', 'totalValue', 'createdAt'],
  robinhoodAccountSnapshots: [
    'id', 'snapshotId', 'accountKey', 'totalValue', 'equityValue', 'optionsValue', 'cash',
    'buyingPower', 'cryptoValue', 'futuresValue', 'mutualFundsValue', 'fixedIncomeValue'
  ],
  robinhoodEquityPositions: [
    'id', 'snapshotId', 'accountKey', 'symbol', 'quantity', 'averageBuyPrice', 'lastPrice',
    'lastPriceAsOf', 'previousClose', 'marketValue', 'unrealizedGain', 'unrealizedGainPercent', 'type'
  ],
  robinhoodOptionPositions: [
    'id', 'snapshotId', 'accountKey', 'underlyingSymbol', 'symbol', 'contractSymbol',
    'instrumentId', 'expirationDate', 'strikePrice', 'optionType', 'positionType',
    'quantity', 'averageCost', 'markPrice', 'marketValue', 'unrealizedGain',
    'unrealizedGainPercent'
  ]
};

const ORDER_BY = {
  accounts: 'id ASC',
  transactions: 'date DESC, id DESC',
  categories: 'id ASC',
  budgets: 'month DESC, id DESC',
  balanceSnapshots: 'month ASC, id ASC',
  categorizationRules: 'priority DESC, id ASC',
  importProfiles: 'updatedAt DESC, id DESC',
  robinhoodAccounts: 'isDefault DESC, id ASC',
  robinhoodSnapshots: 'fetchedAt DESC, id DESC',
  robinhoodAccountSnapshots: 'id ASC',
  robinhoodEquityPositions: 'accountKey ASC, symbol ASC',
  robinhoodOptionPositions: 'accountKey ASC, expirationDate ASC, underlyingSymbol ASC, strikePrice ASC'
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
      createdAt TEXT,
      updatedAt TEXT
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
      createdAt TEXT
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      parentId INTEGER,
      type TEXT,
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

    CREATE TABLE IF NOT EXISTS robinhoodAccounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      accountKey TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      accountNumberMasked TEXT,
      type TEXT,
      brokerageAccountType TEXT,
      isDefault INTEGER DEFAULT 0,
      agenticAllowed INTEGER DEFAULT 0,
      createdAt TEXT,
      updatedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS robinhoodSnapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fetchedAt TEXT NOT NULL UNIQUE,
      source TEXT,
      totalValue REAL DEFAULT 0,
      createdAt TEXT
    );

    CREATE TABLE IF NOT EXISTS robinhoodAccountSnapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshotId INTEGER NOT NULL,
      accountKey TEXT NOT NULL,
      totalValue REAL DEFAULT 0,
      equityValue REAL DEFAULT 0,
      optionsValue REAL DEFAULT 0,
      cash REAL DEFAULT 0,
      buyingPower REAL DEFAULT 0,
      cryptoValue REAL DEFAULT 0,
      futuresValue REAL DEFAULT 0,
      mutualFundsValue REAL DEFAULT 0,
      fixedIncomeValue REAL DEFAULT 0,
      UNIQUE(snapshotId, accountKey),
      FOREIGN KEY(snapshotId) REFERENCES robinhoodSnapshots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS robinhoodEquityPositions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshotId INTEGER NOT NULL,
      accountKey TEXT NOT NULL,
      symbol TEXT NOT NULL,
      quantity REAL DEFAULT 0,
      averageBuyPrice REAL DEFAULT 0,
      lastPrice REAL DEFAULT 0,
      lastPriceAsOf TEXT,
      previousClose REAL DEFAULT 0,
      marketValue REAL DEFAULT 0,
      unrealizedGain REAL DEFAULT 0,
      unrealizedGainPercent REAL DEFAULT 0,
      type TEXT,
      FOREIGN KEY(snapshotId) REFERENCES robinhoodSnapshots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS robinhoodOptionPositions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshotId INTEGER NOT NULL,
      accountKey TEXT NOT NULL,
      underlyingSymbol TEXT,
      symbol TEXT,
      contractSymbol TEXT,
      instrumentId TEXT,
      expirationDate TEXT,
      strikePrice REAL DEFAULT 0,
      optionType TEXT,
      positionType TEXT,
      quantity REAL DEFAULT 0,
      averageCost REAL DEFAULT 0,
      markPrice REAL DEFAULT 0,
      marketValue REAL DEFAULT 0,
      unrealizedGain REAL DEFAULT 0,
      unrealizedGainPercent REAL DEFAULT 0,
      FOREIGN KEY(snapshotId) REFERENCES robinhoodSnapshots(id) ON DELETE CASCADE
    );
  `);

  const transactionColumns = db.prepare('PRAGMA table_info(transactions)').all().map(column => column.name);
  if (!transactionColumns.includes('fingerprint')) {
    db.prepare('ALTER TABLE transactions ADD COLUMN fingerprint TEXT').run();
  }
}

export function assertTable(table) {
  if (!TABLES[table]) throw new Error(`Unknown table: ${table}`);
}

function cleanRow(table, row, includeId = false) {
  const allowed = new Set(includeId ? TABLES[table] : TABLES[table].filter(column => column !== 'id'));
  return Object.fromEntries(
    Object.entries(row || {}).filter(([key]) => allowed.has(key))
  );
}

export function listRows(table, query = {}) {
  assertTable(table);
  const clauses = [];
  const params = {};

  for (const key of ['accountId', 'categoryId', 'month', 'headerSignature']) {
    if (query[key] !== undefined && query[key] !== '') {
      clauses.push(`${key} = @${key}`);
      params[key] = query[key];
    }
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM ${table} ${where} ORDER BY ${ORDER_BY[table]}`).all(params);
}

export function insertRow(table, row, preserveId = false) {
  assertTable(table);
  const data = cleanRow(table, row, preserveId);
  const columns = Object.keys(data);
  const placeholders = columns.map(column => `@${column}`);
  const result = db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`
  ).run(data);
  return preserveId && data.id ? data.id : result.lastInsertRowid;
}

export function insertRows(table, rows, preserveIds = false) {
  assertTable(table);
  const insert = db.transaction((items) => {
    for (const row of items) insertRow(table, row, preserveIds);
  });
  insert(rows);
}

export function updateRow(table, id, changes) {
  assertTable(table);
  const data = cleanRow(table, changes);
  const columns = Object.keys(data);
  if (columns.length === 0) return 0;
  const assignments = columns.map(column => `${column} = @${column}`).join(', ');
  return db.prepare(`UPDATE ${table} SET ${assignments} WHERE id = @id`).run({ ...data, id }).changes;
}

export function deleteRow(table, id) {
  assertTable(table);
  return db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes;
}

export function getDb() {
  return db;
}
