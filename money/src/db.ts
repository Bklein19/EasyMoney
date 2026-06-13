import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(import.meta.dir, "../data");
const DB_PATH = join(DATA_DIR, "finance.db");

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    mkdirSync(DATA_DIR, { recursive: true });
    _db = new Database(DB_PATH, { create: true });
    _db.run("PRAGMA journal_mode=WAL");
    _db.run("PRAGMA foreign_keys=ON");
    migrate(_db);
  }
  return _db;
}

const MIGRATIONS: Array<(db: Database) => void> = [
  migration1Base,
  migration2Accounts,
  migration3CoveredRange,
  migration4TxDedup,
  migration5ManualBalances,
  migration6FlowTreatment,
  migration7CacheLedger,
  migration8DropParserStore,
  migration9AccountHolder,
];

function migrate(db: Database) {
  const version = (db.query<{ user_version: number }, []>("PRAGMA user_version").get())!.user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      MIGRATIONS[i]!(db);
      db.run(`PRAGMA user_version = ${i + 1}`);
    })();
  }
}

function migration1Base(db: Database) {
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

// flow_treatment: 'normal' computes market gains from balance deltas minus flows.
// 'contributions' treats all unexplained balance changes as contributions — for
// pass-through accounts (e.g. backdoor Roth conduits) that never hold investments
// long enough to have real gains.
function migration6FlowTreatment(db: Database) {
  db.run(`
    ALTER TABLE accounts ADD COLUMN flow_treatment TEXT NOT NULL DEFAULT 'normal'
      CHECK (flow_treatment IN ('normal', 'contributions'))
  `);
}

// Account holder — a manual fact for joint household tracking (e.g. some accounts
// belong to a spouse). Nullable free text; null means unattributed.
function migration9AccountHolder(db: Database) {
  db.run("ALTER TABLE accounts ADD COLUMN account_holder TEXT");
}

// Make the transaction/balance tables a pure rebuildable cache: drop import_file_id's
// NOT NULL (rows now come from a set-union of many files, not one) and remove the
// order-dependent logical-dedup index (dedup now happens deterministically in
// buildLedger). Rebuilds both tables since SQLite can't relax NOT NULL via ALTER.
function migration7CacheLedger(db: Database) {
  db.run("DROP INDEX IF EXISTS idx_transactions_logical");

  db.run(`
    CREATE TABLE transactions_new (
      id TEXT PRIMARY KEY,
      import_file_id INTEGER REFERENCES import_files(id),
      date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      description TEXT NOT NULL,
      account TEXT NOT NULL,
      institution TEXT NOT NULL,
      account_id INTEGER REFERENCES accounts(id),
      raw JSON NOT NULL
    )
  `);
  db.run(`
    INSERT INTO transactions_new
      (id, import_file_id, date, amount_cents, description, account, institution, account_id, raw)
    SELECT id, import_file_id, date, amount_cents, description, account, institution, account_id, raw
    FROM transactions
  `);
  db.run("DROP TABLE transactions");
  db.run("ALTER TABLE transactions_new RENAME TO transactions");

  db.run(`
    CREATE TABLE account_balances_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_file_id INTEGER REFERENCES import_files(id),
      date TEXT NOT NULL,
      account TEXT NOT NULL,
      institution TEXT NOT NULL,
      account_id INTEGER REFERENCES accounts(id),
      balance_cents INTEGER NOT NULL,
      UNIQUE(date, account, institution)
    )
  `);
  db.run(`
    INSERT INTO account_balances_new
      (id, import_file_id, date, account, institution, account_id, balance_cents)
    SELECT id, import_file_id, date, account, institution, account_id, balance_cents
    FROM account_balances
  `);
  db.run("DROP TABLE account_balances");
  db.run("ALTER TABLE account_balances_new RENAME TO account_balances");
}

function migration8DropParserStore(db: Database) {
  db.run("DROP TABLE IF EXISTS parsers");
}

function migration5ManualBalances(db: Database) {
  db.run(`
    CREATE TABLE manual_balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      date TEXT NOT NULL,
      balance_cents INTEGER NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(account_id, date)
    )
  `);
}

function migration4TxDedup(db: Database) {
  // Add a logical uniqueness constraint so INSERT OR IGNORE catches duplicates
  // even when the raw field differs between parser versions.
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_logical
    ON transactions (date, amount_cents, description, account_id)
    WHERE account_id IS NOT NULL
  `);
}

function migration3CoveredRange(db: Database) {
  db.run("ALTER TABLE import_files ADD COLUMN covered_from TEXT");
  db.run("ALTER TABLE import_files ADD COLUMN covered_to TEXT");
}

function migration2Accounts(db: Database) {
  db.run(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      institution TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'unknown'
        CHECK (type IN ('checking', 'savings', 'brokerage', 'retirement', 'credit-card', 'loan', 'unknown')),
      classification TEXT NOT NULL DEFAULT 'asset'
        CHECK (classification IN ('asset', 'liability')),
      tax_treatment TEXT NOT NULL DEFAULT 'taxable'
        CHECK (tax_treatment IN ('taxable', 'traditional', 'roth', 'hsa', 'none')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name, institution)
    )
  `);

  db.run(`
    CREATE TABLE account_aliases (
      alias TEXT NOT NULL,
      institution TEXT NOT NULL,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      PRIMARY KEY (alias, institution)
    )
  `);

  db.run("ALTER TABLE transactions ADD COLUMN account_id INTEGER REFERENCES accounts(id)");
  db.run("ALTER TABLE account_balances ADD COLUMN account_id INTEGER REFERENCES accounts(id)");

  // Backfill: create an account + alias for each distinct (institution, account) string pair
  const pairs = db
    .query<{ account: string; institution: string }, []>(
      `SELECT DISTINCT account, institution FROM transactions
       UNION
       SELECT DISTINCT account, institution FROM account_balances`
    )
    .all();

  for (const { account, institution } of pairs) {
    db.run(
      "INSERT OR IGNORE INTO accounts (name, institution) VALUES (?, ?)",
      [account, institution]
    );
    const accountId = (db
      .query<{ id: number }, [string, string]>(
        "SELECT id FROM accounts WHERE name = ? AND institution = ?"
      )
      .get(account, institution))!.id;
    db.run(
      "INSERT OR IGNORE INTO account_aliases (alias, institution, account_id) VALUES (?, ?, ?)",
      [account, institution, accountId]
    );
    db.run(
      "UPDATE transactions SET account_id = ? WHERE account = ? AND institution = ?",
      [accountId, account, institution]
    );
    db.run(
      "UPDATE account_balances SET account_id = ? WHERE account = ? AND institution = ?",
      [accountId, account, institution]
    );
  }
}
