import { Database } from "bun:sqlite";
import { join } from "path";

const DB_PATH = join(import.meta.dir, "../data/finance.db");

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    _db = new Database(DB_PATH, { create: true });
    _db.run("PRAGMA journal_mode=WAL");
    _db.run("PRAGMA foreign_keys=ON");
    migrate(_db);
  }
  return _db;
}

function migrate(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS import_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      sha256 TEXT NOT NULL UNIQUE,
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      parser_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS parsers (
      id TEXT PRIMARY KEY,
      institution TEXT NOT NULL,
      file_type TEXT NOT NULL,
      code TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      import_file_id INTEGER NOT NULL REFERENCES import_files(id),
      date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      description TEXT NOT NULL,
      account TEXT NOT NULL,
      institution TEXT NOT NULL,
      raw JSON NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS account_balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_file_id INTEGER NOT NULL REFERENCES import_files(id),
      date TEXT NOT NULL,
      account TEXT NOT NULL,
      institution TEXT NOT NULL,
      balance_cents INTEGER NOT NULL,
      UNIQUE(date, account, institution)
    )
  `);
}
