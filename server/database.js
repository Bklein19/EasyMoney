import { Database } from 'bun:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.EASYMONEY_DB_PATH
  ? path.resolve(process.env.EASYMONEY_DB_PATH)
  : path.resolve(__dirname, '..', 'data', 'easymoney.sqlite');
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

function normalizeIdentityText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeIdentityDate(value = '') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function transactionIdentityBaseKey(transaction) {
  return [
    transaction.accountId || '',
    normalizeIdentityDate(transaction.date),
    Number(transaction.amount || 0).toFixed(2),
    normalizeIdentityText(transaction.originalDescription || transaction.description || transaction.merchant || ''),
    normalizeIdentityText(transaction.sourceRole || transaction.transactionKind || 'activity'),
  ].join('|');
}

function transactionOccurrenceSortKey(transaction) {
  const token = value => typeof value === 'number' ? String(value).padStart(16, '0') : String(value || '');
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

function ledgerTransactionIdFor(transaction, occurrenceIndex) {
  return `txn_${hashContent(`${transactionIdentityBaseKey(transaction)}|${occurrenceIndex}`).slice(0, 32)}`;
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
  categories: ['id', 'name', 'parentId', 'type', 'color', 'icon'],
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
    'id', 'sourceFileId', 'accountId', 'institution', 'sourceAccountKey', 'sourceAccountName', 'rawJson', 'createdAt'
  ],
  sourceTransactions: [
    'id', 'sourceFileId', 'sourceAccountId', 'importRowId', 'stableSourceId', 'date',
    'amountCents', 'description', 'sourceRole', 'priority', 'rawJson', 'createdAt'
  ],
  sourceBalances: [
    'id', 'sourceFileId', 'sourceAccountId', 'importRowId', 'date', 'balanceCents',
    'priority', 'rawJson', 'createdAt'
  ],
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
  ledgerTransactions: 'date DESC, id DESC',
  transactionAnnotations: 'updatedAt DESC, ledgerTransactionId ASC',
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
  sourceBalances: 'date DESC, id DESC',
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
  const groups = new Map();
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

  const importFileColumns = db.prepare('PRAGMA table_info(importFiles)').all().map(column => column.name);
  for (const [column, definition] of [
    ['sourceType', 'TEXT'],
    ['parserPriority', 'INTEGER'],
    ['institution', 'TEXT'],
  ]) {
    if (!importFileColumns.includes(column)) {
      db.prepare(`ALTER TABLE importFiles ADD COLUMN ${column} ${definition}`).run();
    }
  }

  const importRowColumns = db.prepare('PRAGMA table_info(importRows)').all().map(column => column.name);
  if (!importRowColumns.includes('rowType')) {
    db.prepare("ALTER TABLE importRows ADD COLUMN rowType TEXT DEFAULT 'transaction'").run();
  }

  const sourceAccountColumns = db.prepare('PRAGMA table_info(sourceAccounts)').all().map(column => column.name);
  if (!sourceAccountColumns.includes('accountId')) {
    db.prepare('ALTER TABLE sourceAccounts ADD COLUMN accountId INTEGER').run();
  }

  const sourceBalanceIndexes = db.prepare('PRAGMA index_list(sourceBalances)').all();
  const hasLegacySourceBalanceUniqueIndex = sourceBalanceIndexes.some(index =>
    index.unique === 1 &&
    index.origin === 'u' &&
    db.prepare(`PRAGMA index_info(${index.name})`).all().map(column => column.name).join(',') === 'sourceFileId,sourceAccountId,date'
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
  const groups = new Map();
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

  for (const key of ['accountId', 'categoryId', 'month', 'headerSignature', 'importFileId']) {
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

export function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}
