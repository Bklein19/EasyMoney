import { getDb, syncLedgerReadModelFromLegacyTables } from '../database.ts';
import { ensureLedgerTransactionId, upsertTransactionAnnotation } from './transactionAnnotations.ts';
import { buildAccountMap, buildCategoryMap, getTransactionFlow } from './transactionSemantics.ts';
import type {
  AccountSummary,
  CategorySummary,
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
  categoryGroup: string | null;
  categoryDescription: string | null;
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
  sourceRole: string | null;
  status: string | null;
  notes: string | null;
  importBatchId: string | null;
  fingerprint: string | null;
  createdAt: string | null;
}

interface CategoryUndoChange {
  transactionId: string;
  categoryId: number | string | null;
}

interface CategoryUndoOperation {
  id: number;
  categoryName: string;
  count: number;
}

interface CategoryUndoResult {
  ok: true;
  count: number;
  undoOperation: CategoryUndoOperation | null;
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

function parseSearchAmountCents(value: string): { cents: number; isSigned: boolean } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const isParenthesized = /^\(.*\)$/.test(trimmed);
  const normalized = trimmed
    .replace(/^\((.*)\)$/, '-$1')
    .replace(/[$,\s]/g, '');

  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(normalized)) return null;

  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return null;

  const isSigned = isParenthesized || /^[+-]/.test(normalized);
  return {
    cents: Math.round(amount * 100),
    isSigned,
  };
}

function parseSearchTerms(value: string): string[] {
  return [...value.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)]
    .map(match => match[1] ?? match[2] ?? match[3] ?? '')
    .map(term => term.trim())
    .filter(Boolean);
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
    case 'description_asc':
      return "lower(COALESCE(t.merchant, t.description, t.originalDescription, '')) ASC, t.date DESC, t.id DESC";
    case 'description_desc':
      return "lower(COALESCE(t.merchant, t.description, t.originalDescription, '')) DESC, t.date DESC, t.id DESC";
    case 'category_asc':
      return "lower(COALESCE(c.name, '')) ASC, t.date DESC, t.id DESC";
    case 'category_desc':
      return "lower(COALESCE(c.name, '')) DESC, t.date DESC, t.id DESC";
    case 'account_asc':
      return "lower(COALESCE(a.name, '')) ASC, t.date DESC, t.id DESC";
    case 'account_desc':
      return "lower(COALESCE(a.name, '')) DESC, t.date DESC, t.id DESC";
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
    const searchTerms = parseSearchTerms(search);
    searchTerms.forEach((term, index) => {
      const searchParam = `search${index}`;
      const amountParam = `searchAmountCents${index}`;
      const amountSearch = parseSearchAmountCents(term);
      const amountSearchClause = amountSearch
        ? amountSearch.isSigned
          ? `OR t.amountCents = $${amountParam}`
          : `OR ABS(t.amountCents) = $${amountParam}`
        : '';
      clauses.push(`(
        t.description LIKE $${searchParam} OR
        t.merchant LIKE $${searchParam} OR
        t.originalDescription LIKE $${searchParam} OR
        ta.notes LIKE $${searchParam} OR
        c.name LIKE $${searchParam} OR
        a.name LIKE $${searchParam}
        ${amountSearchClause}
      )`);
      params[searchParam] = `%${term}%`;
      if (amountSearch) params[amountParam] = amountSearch.isSigned ? amountSearch.cents : Math.abs(amountSearch.cents);
    });
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
      categoryGroup: row.categoryGroup,
      description: row.categoryDescription,
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
    sourceRole: row.sourceRole,
    status: row.status,
    notes: row.notes,
    importBatchId: row.importBatchId,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
  };
}

const transactionSelect = `SELECT
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
  c.categoryGroup AS categoryGroup,
  c.description AS categoryDescription,
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
  t.sourceRole,
  t.status,
  ta.notes AS notes,
  t.importBatchId,
  t.fingerprint,
  t.createdAt
 ${fromAndJoins}`;

function getAllAccountsForSemantics() {
  const rows = getDb().prepare(`
    SELECT id, name, institution, type
    FROM accounts
  `).all() as Array<Pick<AccountSummary, 'id' | 'name' | 'institution' | 'type'>>;
  return buildAccountMap(rows);
}

function getAllCategoriesForSemantics() {
  const rows = getDb().prepare(`
    SELECT id, name, type, parentId, categoryGroup, description, color, icon
    FROM categories
  `).all() as CategorySummary[];
  return buildCategoryMap(rows);
}

function transactionTotals(transactions: TransactionListItem[]) {
  const accountMap = getAllAccountsForSemantics();
  const categoryMap = getAllCategoriesForSemantics();
  const totals = {
    income: 0,
    expenses: 0,
    internalMovement: 0,
    investments: 0,
  };

  for (const transaction of transactions) {
    const flow = getTransactionFlow(transaction, accountMap, categoryMap);
    if (flow === 'income') totals.income += transaction.amount;
    else if (flow === 'expense') totals.expenses += Math.abs(transaction.amount);
    else if (flow === 'investment') totals.investments += Math.abs(transaction.amount);
    else if (flow === 'transfer' || flow === 'card_payment' || flow === 'internal_transfer') {
      totals.internalMovement += Math.abs(transaction.amount);
    }
  }

  return {
    ...totals,
    net: totals.income - totals.expenses,
  };
}

function getCategoryName(categoryId: string | number | null | undefined): string {
  const id = optionalNumber(categoryId);
  if (id === null) return 'Uncategorized';

  const row = getDb()
    .prepare('SELECT name FROM categories WHERE id = ?')
    .get(id) as { name: string } | undefined;
  return row?.name ?? 'selected category';
}

function createCategoryUndoOperation(input: {
  categoryName: string;
  previousCategories: CategoryUndoChange[];
}): CategoryUndoOperation {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(`
      INSERT INTO transactionCategoryUndoOperations
        (categoryName, transactionCount, payloadJson, status, createdAt)
      VALUES (?, ?, ?, 'pending', ?)
    `)
    .run(
      input.categoryName,
      input.previousCategories.length,
      JSON.stringify(input.previousCategories),
      now
    );

  return {
    id: Number(result.lastInsertRowid),
    categoryName: input.categoryName,
    count: input.previousCategories.length,
  };
}

export function getLatestTransactionCategoryUndoOperation(): CategoryUndoOperation | null {
  const row = getDb()
    .prepare(`
      SELECT id, categoryName, transactionCount
      FROM transactionCategoryUndoOperations
      WHERE status = 'pending'
      ORDER BY id DESC
      LIMIT 1
    `)
    .get() as { id: number; categoryName: string; transactionCount: number } | undefined;

  if (!row) return null;
  return {
    id: row.id,
    categoryName: row.categoryName,
    count: row.transactionCount,
  };
}

function getTransactionCategoryUndoChanges(undoOperationId: string | number): CategoryUndoChange[] {
  const row = getDb()
    .prepare(`
      SELECT payloadJson
      FROM transactionCategoryUndoOperations
      WHERE id = ? AND status = 'pending'
    `)
    .get(undoOperationId) as { payloadJson: string } | undefined;

  if (!row) return [];

  const parsed = JSON.parse(row.payloadJson) as Array<{
    transactionId?: string | number;
    categoryId?: string | number | null;
  }>;

  return parsed
    .map(change => ({
      transactionId: String(change.transactionId || ''),
      categoryId: change.categoryId ?? null,
    }))
    .filter(change => change.transactionId);
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
  const allMatchingRows = db
    .prepare(`${transactionSelect} ${where}`)
    .all(params) as LedgerTransactionRow[];
  const rows = db
    .prepare(
      `${transactionSelect}
       ${where}
       ORDER BY ${orderBy}
       ${limitClause}`
    )
    .all(params) as LedgerTransactionRow[];

  const nextOffset = limit === null ? null : offset + rows.length;
  const hasMore = nextOffset !== null && nextOffset < totalCount;
  const totals = transactionTotals(allMatchingRows.map(toTransactionListItem));
  return {
    transactions: rows.map(toTransactionListItem),
    totalCount,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
    totals,
  };
}

export function getTransactionCategorizationCoverage() {
  syncLedgerReadModelFromLegacyTables();
  const row = getDb().prepare(`
    SELECT
      COUNT(*) AS totalCount,
      COALESCE(SUM(ABS(t.amountCents)), 0) AS totalAmountCents,
      COALESCE(SUM(CASE
        WHEN c.id IS NOT NULL AND lower(c.name) != 'uncategorized' THEN 1
        ELSE 0
      END), 0) AS categorizedCount,
      COALESCE(SUM(CASE
        WHEN c.id IS NOT NULL AND lower(c.name) != 'uncategorized' THEN ABS(t.amountCents)
        ELSE 0
      END), 0) AS categorizedAmountCents
    FROM ledgerTransactions t
    LEFT JOIN accounts a ON a.id = t.accountId
    LEFT JOIN transactionAnnotations ta ON ta.ledgerTransactionId = t.ledgerTransactionId
    LEFT JOIN categories c ON c.id = ta.categoryId
    WHERE t.ledgerTransactionId IS NOT NULL
      AND COALESCE(a.status, 'active') != 'archived'
  `).get() as {
    totalCount: number;
    totalAmountCents: number;
    categorizedCount: number;
    categorizedAmountCents: number;
  };

  const totalCount = row.totalCount ?? 0;
  const totalAmountCents = row.totalAmountCents ?? 0;
  const categorizedCount = row.categorizedCount ?? 0;
  const categorizedAmountCents = row.categorizedAmountCents ?? 0;

  return {
    totalCount,
    categorizedCount,
    uncategorizedCount: totalCount - categorizedCount,
    transactionPercent: totalCount > 0 ? categorizedCount / totalCount : 0,
    totalAmountCents,
    categorizedAmountCents,
    uncategorizedAmountCents: totalAmountCents - categorizedAmountCents,
    amountPercent: totalAmountCents > 0 ? categorizedAmountCents / totalAmountCents : 0,
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
}): CategoryUndoResult {
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

  if (!ledgerTransactionIds.length) return { ok: true, count: 0, undoOperation: null };

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
  const categoryName = getCategoryName(input.categoryId);
  let undoOperation: CategoryUndoOperation | null = null;

  const apply = db.transaction(() => {
    undoOperation = createCategoryUndoOperation({ categoryName, previousCategories });
    for (const id of ledgerTransactionIds) {
      upsertTransactionAnnotation(id, { categoryId: input.categoryId ?? null });
    }
  });
  apply();

  return { ok: true, count: ledgerTransactionIds.length, undoOperation };
}

export function restoreTransactionCategories(input: {
  undoOperationId: number | string;
}) {
  const changes = getTransactionCategoryUndoChanges(input.undoOperationId);
  if (!changes.length) return { ok: true, count: 0 };

  const db = getDb();
  const apply = db.transaction(() => {
    for (const change of changes) {
      upsertTransactionAnnotation(change.transactionId, { categoryId: change.categoryId });
    }
    db.prepare(`
      UPDATE transactionCategoryUndoOperations
      SET status = 'consumed', consumedAt = ?
      WHERE id = ? AND status = 'pending'
    `).run(new Date().toISOString(), input.undoOperationId);
  });
  apply();

  return { ok: true, count: changes.length };
}
