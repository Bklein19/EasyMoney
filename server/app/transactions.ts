import { getDb, syncLedgerReadModelFromLegacyTables } from '../database.js';
import { upsertTransactionAnnotation } from './transactionAnnotations.ts';
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
  const clauses: string[] = [];
  const params: Record<string, string | number> = {};

  const accountId = optionalNumber(options.accountId);
  if (accountId !== null) {
    clauses.push('t.accountId = $accountId');
    params.accountId = accountId;
  }

  const categoryId = optionalNumber(options.categoryId);
  if (categoryId !== null) {
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

  const limit = optionalNumber(options.limit);
  const limitClause = limit === null ? '' : 'LIMIT $limit';
  if (limit !== null) params.limit = Math.min(limit, 1000);

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = getDb()
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
       FROM ledgerTransactions t
       LEFT JOIN accounts a ON a.id = t.accountId
       LEFT JOIN transactionAnnotations ta ON ta.ledgerTransactionId = t.ledgerTransactionId
       LEFT JOIN categories c ON c.id = ta.categoryId
       ${where}
       ORDER BY t.date DESC, t.id DESC
       ${limitClause}`
    )
    .all(params) as LedgerTransactionRow[];

  return { transactions: rows.map(toTransactionListItem) };
}

export function categorizeTransactions(input: {
  transactionIds: Array<number | string>;
  categoryId?: number | string | null;
}) {
  const uniqueIds = [...new Set(input.transactionIds.map(id => String(id)).filter(Boolean))];
  if (!uniqueIds.length) return { ok: true, count: 0 };

  const apply = getDb().transaction(() => {
    for (const id of uniqueIds) {
      upsertTransactionAnnotation(id, { categoryId: input.categoryId ?? null });
    }
  });
  apply();

  return { ok: true, count: uniqueIds.length };
}
