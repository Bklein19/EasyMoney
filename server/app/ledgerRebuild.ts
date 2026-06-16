import { getDb, hashContent } from '../database.js';
import { assignLedgerTransactionIdentities } from './transactionIdentity.ts';

interface SourceTransactionRow {
  id: number;
  sourceFileId: number;
  sourceAccountId: number;
  importRowId: number | null;
  stableSourceId: string;
  date: string;
  amountCents: number;
  description: string | null;
  sourceRole: string | null;
  priority: number | null;
  rawJson: string | null;
  accountId: number;
  accountType: string | null;
  importFileId: number | null;
  sourceRowIndex: number | null;
}

interface SourceBalanceRow {
  id: number;
  sourceFileId: number;
  sourceAccountId: number;
  importRowId: number | null;
  date: string;
  balanceCents: number;
  priority: number | null;
  rawJson: string | null;
  accountId: number;
}

export interface RebuiltTransaction {
  ledgerTransactionId: string;
  occurrenceIndex: number;
  accountId: number;
  date: string;
  amount: number;
  importBatchId: string;
  description: string;
  merchant: string;
  originalDescription: string;
  originalCategory: string | null;
  type: string;
  transactionKind: string | null;
  status: string;
  sourceRole: string;
  fingerprint: string;
  importRowId: number | null;
}

export interface RebuiltBalanceSnapshot {
  accountId: number;
  month: string;
  balance: number;
  capturedAt: string;
}

export interface RebuiltLedger {
  transactions: RebuiltTransaction[];
  balanceSnapshots: RebuiltBalanceSnapshot[];
}

function normalizeText(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDate(value = '') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function normalizeAmount(value: unknown) {
  return Number(value || 0).toFixed(2);
}

function dollarsFromCents(value: number) {
  return Math.round(value) / 100;
}

function isCreditAccount(accountType: string | null | undefined) {
  return accountType === 'credit' || accountType === 'credit_card' || accountType === 'credit-card';
}

function parseRaw(rawJson: string | null) {
  if (!rawJson) return {};
  try {
    return JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getTransactionFingerprint(transaction: {
  accountId: number;
  date: string;
  amount: number;
  originalDescription?: string | null;
  description?: string | null;
  merchant?: string | null;
}) {
  const text = normalizeText(
    transaction.originalDescription ||
    transaction.description ||
    transaction.merchant ||
    ''
  );
  return [
    transaction.accountId,
    normalizeDate(transaction.date),
    normalizeAmount(transaction.amount),
    text,
  ].join('|');
}

function getMaterializedImportBatchId(fingerprint: string) {
  return `import-row-${hashContent(fingerprint).slice(0, 16)}`;
}

function isStatementSummary(transaction: {
  raw: Record<string, unknown>;
}) {
  return transaction.raw.type === 'statement-cash-flow-summary';
}

function classifyFlow(description: string) {
  const normalized = description.toLowerCase();
  if (/dividend|cap gain rein|cg rein|income rein/.test(normalized)) return 'dividend';
  if (normalized.includes('interest')) return 'interest';
  if (
    /funds received|funds transferred|transfer (in|out|from)|contribution|conversion|rollover|broker to broker|journaled|rsu vest|espp purchase|shares purchased|shares redeemed|fund purchase|statement net cash flow|\beft\b|\bach\b|direct deposit/.test(normalized)
  ) {
    return 'contribution';
  }
  return 'internal';
}

function activityBucket(transaction: {
  description: string;
  raw: Record<string, unknown>;
}) {
  if (transaction.raw.metric === 'netCashFlow') return 'contribution';
  if (transaction.raw.metric === 'dividendsInterestIncome') return 'income';

  const flow = classifyFlow(transaction.description);
  if (flow === 'contribution') return 'contribution';
  if (flow === 'dividend' || flow === 'interest') return 'income';
  return 'other';
}

export function buildLedgerFromSourceFacts(db = getDb()): RebuiltLedger {
  const sourceTransactions = db.prepare(`
    SELECT
      st.id,
      st.sourceFileId,
      st.sourceAccountId,
      st.importRowId,
      st.stableSourceId,
      st.date,
      st.amountCents,
      st.description,
      st.sourceRole,
      st.priority,
      st.rawJson,
      sa.accountId,
      a.type AS accountType,
      sf.importFileId,
      ir.rowIndex AS sourceRowIndex
    FROM sourceTransactions st
    JOIN sourceFiles sf ON sf.id = st.sourceFileId
    JOIN sourceAccounts sa ON sa.id = st.sourceAccountId
    JOIN accounts a ON a.id = sa.accountId
    LEFT JOIN importRows ir ON ir.id = st.importRowId
    WHERE sf.status = 'committed'
      AND sa.accountId IS NOT NULL
    ORDER BY st.sourceFileId ASC, st.id ASC
  `).all() as SourceTransactionRow[];

  const transactionInputs = sourceTransactions.map(row => {
    const raw = parseRaw(row.rawJson);
    const amount = dollarsFromCents(row.amountCents);
    const description = row.description || '';
    const merchant = typeof raw.merchant === 'string' ? raw.merchant : description;
    const originalDescription = typeof raw.originalDescription === 'string' ? raw.originalDescription : description;
    const originalCategory = typeof raw.originalCategory === 'string' && raw.originalCategory.trim()
      ? raw.originalCategory
      : typeof raw.category === 'string' && raw.category.trim()
        ? raw.category
        : null;
    const rawKind = typeof raw.transactionKind === 'string' ? raw.transactionKind : null;
    const transactionKind = isCreditAccount(row.accountType) && amount > 0
      ? 'card_payment'
      : rawKind;
    const fingerprint = getTransactionFingerprint({
      accountId: row.accountId,
      date: row.date,
      amount,
      originalDescription,
      description,
      merchant,
    });

    return {
      ...row,
      accountId: row.accountId,
      amount,
      description,
      merchant,
      originalDescription,
      originalCategory,
      raw,
      type: amount >= 0 ? 'credit' : 'debit',
      transactionKind,
      status: typeof raw.status === 'string' ? raw.status : 'cleared',
      sourceRole: row.sourceRole || 'activity',
      fingerprint,
      importBatchId: getMaterializedImportBatchId(fingerprint),
    };
  });

  const exactKey = (transaction: {
    accountId: number;
    date: string;
    amountCents: number;
  }) => `${transaction.accountId}\0${transaction.date}\0${transaction.amountCents}`;
  const monthBucketKey = (transaction: {
    accountId: number;
    date: string;
    description: string;
    raw: Record<string, unknown>;
  }) => `${transaction.accountId}\0${transaction.date.slice(0, 7)}\0${activityBucket(transaction)}`;

  const bestExactPriority = new Map<string, number>();
  const bestMonthBucketDetailPriority = new Map<string, number>();
  for (const transaction of transactionInputs) {
    if (transaction.sourceRole !== 'activity') continue;
    const priority = transaction.priority ?? 0;
    const key = exactKey(transaction);
    if (priority > (bestExactPriority.get(key) ?? -Infinity)) {
      bestExactPriority.set(key, priority);
    }
    if (!isStatementSummary(transaction)) {
      const bucketKey = monthBucketKey(transaction);
      if (priority > (bestMonthBucketDetailPriority.get(bucketKey) ?? -Infinity)) {
        bestMonthBucketDetailPriority.set(bucketKey, priority);
      }
    }
  }

  const dedupedTransactionInputs = transactionInputs.filter(transaction => {
    if (transaction.sourceRole !== 'activity') return true;
    const priority = transaction.priority ?? 0;
    if (isStatementSummary(transaction)) {
      const best = bestMonthBucketDetailPriority.get(monthBucketKey(transaction));
      return best === undefined || priority >= best;
    }
    const best = bestExactPriority.get(exactKey(transaction));
    return best === undefined || priority >= best;
  });

  const transactions = assignLedgerTransactionIdentities(dedupedTransactionInputs).map((item) => ({
    ledgerTransactionId: item.ledgerTransactionId,
    occurrenceIndex: item.occurrenceIndex,
    accountId: item.transaction.accountId,
    date: item.transaction.date,
    amount: item.transaction.amount,
    importBatchId: item.transaction.importBatchId,
    description: item.transaction.description,
    merchant: item.transaction.merchant,
    originalDescription: item.transaction.originalDescription,
    originalCategory: item.transaction.originalCategory,
    type: item.transaction.type,
    transactionKind: item.transaction.transactionKind,
    status: item.transaction.status,
    sourceRole: item.transaction.sourceRole,
    fingerprint: item.transaction.fingerprint,
    importRowId: item.transaction.importRowId,
  })).sort((a, b) => a.ledgerTransactionId.localeCompare(b.ledgerTransactionId));

  const sourceBalances = db.prepare(`
    SELECT
      sb.id,
      sb.sourceFileId,
      sb.sourceAccountId,
      sb.importRowId,
      sb.date,
      sb.balanceCents,
      sb.priority,
      sb.rawJson,
      sa.accountId
    FROM sourceBalances sb
    JOIN sourceFiles sf ON sf.id = sb.sourceFileId
    JOIN sourceAccounts sa ON sa.id = sb.sourceAccountId
    WHERE sf.status = 'committed'
      AND sa.accountId IS NOT NULL
    ORDER BY sb.date ASC, sb.id ASC
  `).all() as SourceBalanceRow[];
  const balancesByAccountMonth = new Map<string, RebuiltBalanceSnapshot>();
  for (const balance of sourceBalances) {
    const month = balance.date.slice(0, 7);
    balancesByAccountMonth.set(`${balance.accountId}|${month}`, {
      accountId: balance.accountId,
      month,
      balance: dollarsFromCents(balance.balanceCents),
      capturedAt: `${balance.date.slice(0, 10)}T00:00:00.000Z`,
    });
  }

  return {
    transactions,
    balanceSnapshots: [...balancesByAccountMonth.values()].sort((a, b) =>
      `${a.accountId}|${a.month}`.localeCompare(`${b.accountId}|${b.month}`)
    ),
  };
}

export function ledgerFingerprint(ledger: RebuiltLedger) {
  return hashContent(JSON.stringify({
    transactions: ledger.transactions,
    balanceSnapshots: ledger.balanceSnapshots,
  }));
}

export function materializeLedger(db = getDb(), ledger = buildLedgerFromSourceFacts(db)) {
  db.transaction(() => {
    db.prepare('DELETE FROM ledgerTransactions').run();
    db.prepare('DELETE FROM ledgerBalances').run();
    db.prepare('DELETE FROM transactions').run();
    db.prepare('DELETE FROM balanceSnapshots').run();

    const insertTransaction = db.prepare(`
      INSERT INTO transactions (
        accountId,
        categoryId,
        date,
        amount,
        importBatchId,
        description,
        merchant,
        originalDescription,
        originalCategory,
        type,
        transactionKind,
        status,
        notes,
        fingerprint,
        ledgerTransactionId,
        occurrenceIndex,
        createdAt
      ) VALUES (
        @accountId,
        NULL,
        @date,
        @amount,
        @importBatchId,
        @description,
        @merchant,
        @originalDescription,
        @originalCategory,
        @type,
        @transactionKind,
        @status,
        NULL,
        @fingerprint,
        @ledgerTransactionId,
        @occurrenceIndex,
        @createdAt
      )
    `);
    const updateImportRow = db.prepare(`
      UPDATE importRows
      SET transactionId = @transactionId, fingerprint = @fingerprint
      WHERE id = @importRowId
    `);
    const insertLedgerTransaction = db.prepare(`
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
      ) VALUES (
        @ledgerTransactionId,
        @legacyTransactionId,
        @accountId,
        @date,
        @amountCents,
        @importBatchId,
        @description,
        @merchant,
        @originalDescription,
        @originalCategory,
        @type,
        @transactionKind,
        @status,
        @fingerprint,
        @sourceRole,
        @occurrenceIndex,
        (
          SELECT importFileId
          FROM importRows
          WHERE id = @importRowId
        ),
        @importRowId,
        (
          SELECT id
          FROM sourceTransactions
          WHERE importRowId = @importRowId
          LIMIT 1
        ),
        @createdAt,
        @updatedAt
      )
    `);
    const now = new Date().toISOString();
    for (const transaction of ledger.transactions) {
      const result = insertTransaction.run({
        ...transaction,
        createdAt: now,
      });
      if (transaction.importRowId) {
        updateImportRow.run({
          importRowId: transaction.importRowId,
          transactionId: result.lastInsertRowid,
          fingerprint: transaction.fingerprint,
        });
      }
      insertLedgerTransaction.run({
        ...transaction,
        legacyTransactionId: result.lastInsertRowid,
        amountCents: Math.round(transaction.amount * 100),
        sourceRole: transaction.sourceRole,
        createdAt: now,
        updatedAt: now,
      });
    }

    const insertBalance = db.prepare(`
      INSERT INTO balanceSnapshots (accountId, month, balance, capturedAt)
      VALUES (@accountId, @month, @balance, @capturedAt)
    `);
    const insertLedgerBalance = db.prepare(`
      INSERT INTO ledgerBalances (
        accountId,
        month,
        balanceCents,
        capturedAt,
        sourceBalanceId,
        createdAt,
        updatedAt
      ) VALUES (
        @accountId,
        @month,
        @balanceCents,
        @capturedAt,
        (
          SELECT sb.id
          FROM sourceBalances sb
          JOIN sourceAccounts sa ON sa.id = sb.sourceAccountId
          WHERE sa.accountId = @accountId
            AND substr(sb.date, 1, 7) = @month
          ORDER BY sb.date DESC, sb.id DESC
          LIMIT 1
        ),
        @createdAt,
        @updatedAt
      )
    `);
    for (const balance of ledger.balanceSnapshots) {
      insertBalance.run(balance);
      insertLedgerBalance.run({
        ...balance,
        balanceCents: Math.round(balance.balance * 100),
        createdAt: now,
        updatedAt: now,
      });
    }
  })();

  return {
    transactionCount: ledger.transactions.length,
    balanceSnapshotCount: ledger.balanceSnapshots.length,
  };
}
