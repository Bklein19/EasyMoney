import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '..', 'data', 'easymoney.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
  importProfiles: ['id', 'headerSignature', 'profileName', 'profileJson', 'mappingJson', 'lastAccountId', 'createdAt', 'updatedAt']
};

const ORDER_BY = {
  accounts: 'id ASC',
  transactions: 'date DESC, id DESC',
  categories: 'id ASC',
  budgets: 'month DESC, id DESC',
  balanceSnapshots: 'month ASC, id ASC',
  categorizationRules: 'priority DESC, id ASC',
  importProfiles: 'updatedAt DESC, id DESC'
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
