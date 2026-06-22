import { getDb, syncLedgerReadModelFromLegacyTables } from '../database.js';
import { ensureLedgerTransactionId, upsertTransactionAnnotation } from './transactionAnnotations.ts';
import type {
  ListTransactionsOptions,
  TransactionListItem,
  TransactionListResponse,
} from './types';

interface LedgerTransactionRow {
  id: number;
  ledgerRowId: number;
  ledgerTransactionId: string | null;
  accountId: number;
  accountName: string | null;
  accountInstitution: string | null;
  accountType: string | null;
  categoryId: number | null;
  categoryName: string | null;
  categoryType: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  date: string;
  amount: number;
  description: string | null;
  merchant: string | null;
  originalDescription: string | null;
  originalCategory: string | null;
  type: string | null;
  transactionKind: string | null;
  status: string | null;
  notes: string | null;
  importBatchId: string | null;
  fingerprint: string | null;
  createdAt: string | null;
}

function optionalNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function isUncategorizedFilter(value: string | number | null | undefined): boolean {
  return typeof value === 'string' && value.toLowerCase() === 'uncategorized';
}

function clampLimit(value: number | null): number | null {
  if (value === null) return null;
  return Math.max(1, Math.min(value, 250));
}

function clampOffset(value: number | null): number {
  if (value === null) return 0;
  return Math.max(0, value);
}

const flowSql = `CASE
  WHEN c.type = 'investment' OR lower(COALESCE(c.name, '')) IN ('investment', 'investments') THEN 'investment'
  WHEN c.type = 'internal_transfer' THEN 'internal_transfer'
  WHEN c.type = 'transfer' THEN 'transfer'
  WHEN t.transactionKind = 'card_payment' THEN 'card_payment'
  WHEN t.transactionKind = 'internal_transfer' THEN 'internal_transfer'
  WHEN t.transactionKind = 'investment' THEN 'investment'
  WHEN t.transactionKind = 'refund' THEN 'refund'
  WHEN a.type IN ('credit', 'credit_card', 'credit-card') AND t.amountCents > 0 THEN 'card_payment'
  WHEN t.amountCents > 0 THEN 'income'
  WHEN t.amountCents < 0 THEN 'expense'
  ELSE 'neutral'
END`;

function orderByFor(sortBy: string | null): string {
  switch (sortBy) {
    case 'date_asc':
      return 't.date ASC, t.id ASC';
    case 'amount_desc':
      return 't.amountCents DESC, t.date DESC, t.id DESC';
    case 'amount_asc':
      return 't.amountCents ASC, t.date DESC, t.id DESC';
    case 'absolute_desc':
      return 'ABS(t.amountCents) DESC, t.date DESC, t.id DESC';
    case 'absolute_asc':
      return 'ABS(t.amountCents) ASC, t.date DESC, t.id DESC';
    case 'date_desc':
    default:
      return 't.date DESC, t.id DESC';
  }
}

const fromAndJoins = `FROM ledgerTransactions t
LEFT JOIN accounts a ON a.id = t.accountId
LEFT JOIN transactionAnnotations ta ON ta.ledgerTransactionId = t.ledgerTransactionId
LEFT JOIN categories c ON c.id = ta.categoryId`;

type SqlParams = Record<string, string | number>;

function buildTransactionFilter(options: ListTransactionsOptions = {}) {
  const clauses: string[] = [];
  const params: SqlParams = {};
  const includeArchived = options.includeArchived === true || options.includeArchived === 'true';

  const accountId = optionalNumber(options.accountId);
  if (accountId !== null) {
    clauses.push('t.accountId = $accountId');
    params.accountId = accountId;
  } else if (!includeArchived) {
    clauses.push("COALESCE(a.status, 'active') != 'archived'");
  }

  const accountKind = optionalString(options.accountKind);
  if (accountKind === 'bank') {
    clauses.push("(a.type IS NULL OR a.type NOT IN ('credit', 'credit_card', 'credit-card'))");
  } else if (accountKind === 'credit') {
    clauses.push("a.type IN ('credit', 'credit_card', 'credit-card')");
  }

  const categoryId = optionalNumber(options.categoryId);
  if (isUncategorizedFilter(options.categoryId)) {
    clauses.push("(ta.categoryId IS NULL OR lower(c.name) = 'uncategorized')");
  } else if (categoryId !== null) {
    clauses.push('ta.categoryId = $categoryId');
    params.categoryId = categoryId;
  }

  const startDate = optionalString(options.startDate);
  if (startDate) {
    clauses.push('t.date >= $startDate');
    params.startDate = startDate;
  }

  const endDate = optionalString(options.endDate);
  if (endDate) {
    clauses.push('t.date <= $endDate');
    params.endDate = endDate;
  }

  const type = optionalString(options.type);
  if (type) {
    clauses.push('t.type = $type');
    params.type = type;
  }

  const flowType = optionalString(options.flowType);
  if (flowType) {
    clauses.push(`${flowSql} = $flowType`);
    params.flowType = flowType;
  }

  const search = optionalString(options.search);
  if (search) {
    clauses.push(`(
      t.description LIKE $search OR
      t.merchant LIKE $search OR
      t.originalDescription LIKE $search OR
      ta.notes LIKE $search OR
      c.name LIKE $search OR
      a.name LIKE $search
    )`);
    params.search = `%${search}%`;
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function toTransactionListItem(row: LedgerTransactionRow): TransactionListItem {
  return {
    id: row.id,
    ledgerTransactionId: row.ledgerTransactionId,
    account: row.accountId === null ? null : {
      id: row.accountId,
      name: row.accountName ?? 'Unknown account',
      institution: row.accountInstitution,
      type: row.accountType ?? 'other',
    },
    category: row.categoryId === null ? null : {
      id: row.categoryId,
      name: row.categoryName ?? 'Uncategorized',
      type: row.categoryType,
      color: row.categoryColor,
      icon: row.categoryIcon,
    },
    date: row.date,
    amount: row.amount,
    description: row.description,
    merchant: row.merchant,
    originalDescription: row.originalDescription,
    originalCategory: row.originalCategory,
    type: row.type,
    transactionKind: row.transactionKind,
    status: row.status,
    notes: row.notes,
    importBatchId: row.importBatchId,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
  };
}

export function listTransactions(options: ListTransactionsOptions = {}): TransactionListResponse {
  syncLedgerReadModelFromLegacyTables();
  const { where, params } = buildTransactionFilter(options);
  const limit = clampLimit(optionalNumber(options.limit));
  const offset = clampOffset(optionalNumber(options.offset));
  const limitClause = limit === null ? '' : 'LIMIT $limit OFFSET $offset';
  if (limit !== null) {
    params.limit = limit;
    params.offset = offset;
  }

  const orderBy = orderByFor(optionalString(options.sortBy));
  const db = getDb();
  const totalCount = (db
    .prepare(`SELECT COUNT(*) AS count ${fromAndJoins} ${where}`)
    .get(params) as { count: number }).count;
  const totalsRow = db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN ${flowSql} = 'income' THEN t.amountCents ELSE 0 END), 0) / 100.0 AS income,
        ABS(COALESCE(SUM(CASE WHEN ${flowSql} = 'expense' THEN t.amountCents ELSE 0 END), 0)) / 100.0 AS expenses,
        ABS(COALESCE(SUM(CASE WHEN ${flowSql} IN ('transfer', 'card_payment', 'internal_transfer') THEN t.amountCents ELSE 0 END), 0)) / 100.0 AS internalMovement,
        ABS(COALESCE(SUM(CASE WHEN ${flowSql} = 'investment' THEN t.amountCents ELSE 0 END), 0)) / 100.0 AS investments
       ${fromAndJoins}
       ${where}`
    )
    .get(params) as {
      income: number;
      expenses: number;
      internalMovement: number;
      investments: number;
    };
  const rows = db
    .prepare(
      `SELECT
        COALESCE(t.legacyTransactionId, t.id) AS id,
        t.id AS ledgerRowId,
        t.ledgerTransactionId,
        t.accountId,
        a.name AS accountName,
        a.institution AS accountInstitution,
        a.type AS accountType,
        ta.categoryId AS categoryId,
        c.name AS categoryName,
        c.type AS categoryType,
        c.color AS categoryColor,
        c.icon AS categoryIcon,
        t.date,
        t.amountCents / 100.0 AS amount,
        t.description,
        t.merchant,
        t.originalDescription,
        t.originalCategory,
        t.type,
        t.transactionKind,
        t.status,
        ta.notes AS notes,
        t.importBatchId,
        t.fingerprint,
        t.createdAt
       ${fromAndJoins}
       ${where}
       ORDER BY ${orderBy}
       ${limitClause}`
    )
    .all(params) as LedgerTransactionRow[];

  const nextOffset = limit === null ? null : offset + rows.length;
  const hasMore = nextOffset !== null && nextOffset < totalCount;
  return {
    transactions: rows.map(toTransactionListItem),
    totalCount,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
    totals: {
      income: totalsRow.income,
      expenses: totalsRow.expenses,
      internalMovement: totalsRow.internalMovement,
      investments: totalsRow.investments,
      net: totalsRow.income - totalsRow.expenses,
    },
  };
}

export function categorizeTransactions(input: {
  transactionIds: Array<number | string>;
  categoryId?: number | string | null;
}) {
  const uniqueIds = [...new Set(input.transactionIds.map(id => String(id)).filter(Boolean))];
  if (!uniqueIds.length) return { ok: true, count: 0, previousCategories: [] };

  const db = getDb();
  const previousCategories = uniqueIds.map(id => {
    const ledgerTransactionId = ensureLedgerTransactionId(id);
    const row = db.prepare(`
      SELECT categoryId
      FROM transactionAnnotations
      WHERE ledgerTransactionId = ?
    `).get(ledgerTransactionId) as { categoryId: number | string | null } | undefined;
    return {
      transactionId: ledgerTransactionId,
      categoryId: row?.categoryId ?? null,
    };
  });

  const apply = getDb().transaction(() => {
    for (const id of uniqueIds) {
      upsertTransactionAnnotation(id, { categoryId: input.categoryId ?? null });
    }
  });
  apply();

  return { ok: true, count: uniqueIds.length, previousCategories };
}

export function categorizeTransactionsByQuery(input: {
  query?: ListTransactionsOptions;
  categoryId?: number | string | null;
}) {
  syncLedgerReadModelFromLegacyTables();
  const { where, params } = buildTransactionFilter(input.query ?? {});
  const db = getDb();
  const rows = db.prepare(`
    SELECT t.ledgerTransactionId
    ${fromAndJoins}
    ${where}
  `).all(params) as Array<{ ledgerTransactionId: string | null }>;
  const ledgerTransactionIds = [...new Set(rows
    .map(row => row.ledgerTransactionId)
    .filter((id): id is string => Boolean(id)))];

  if (!ledgerTransactionIds.length) return { ok: true, count: 0, previousCategories: [] };

  const previousRows = ledgerTransactionIds.length
    ? db.prepare(`
      SELECT ledgerTransactionId, categoryId
      FROM transactionAnnotations
      WHERE ledgerTransactionId IN (${ledgerTransactionIds.map(() => '?').join(',')})
    `).all(...ledgerTransactionIds) as Array<{ ledgerTransactionId: string; categoryId: number | string | null }>
    : [];
  const previousCategoryById = new Map(previousRows.map(row => [row.ledgerTransactionId, row.categoryId]));
  const previousCategories = ledgerTransactionIds.map(id => ({
    transactionId: id,
    categoryId: previousCategoryById.get(id) ?? null,
  }));

  const apply = db.transaction(() => {
    for (const id of ledgerTransactionIds) {
      upsertTransactionAnnotation(id, { categoryId: input.categoryId ?? null });
    }
  });
  apply();

  return { ok: true, count: ledgerTransactionIds.length, previousCategories };
}

export function restoreTransactionCategories(input: {
  changes: Array<{ transactionId: number | string; categoryId?: number | string | null }>;
}) {
  const changes = input.changes
    .map(change => ({
      transactionId: String(change.transactionId || ''),
      categoryId: change.categoryId ?? null,
    }))
    .filter(change => change.transactionId);

  if (!changes.length) return { ok: true, count: 0 };

  const apply = getDb().transaction(() => {
    for (const change of changes) {
      upsertTransactionAnnotation(change.transactionId, { categoryId: change.categoryId });
    }
  });
  apply();

  return { ok: true, count: changes.length };
}
