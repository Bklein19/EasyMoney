import { getDb } from '../database.js';
import type {
  ListTransactionsOptions,
  TransactionListItem,
  TransactionListResponse,
} from './types';

interface TransactionRow {
  id: number;
  accountId: number | null;
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

function toTransactionListItem(row: TransactionRow): TransactionListItem {
  return {
    id: row.id,
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
  const clauses: string[] = [];
  const params: Record<string, string | number> = {};

  const accountId = optionalNumber(options.accountId);
  if (accountId !== null) {
    clauses.push('t.accountId = $accountId');
    params.accountId = accountId;
  }

  const categoryId = optionalNumber(options.categoryId);
  if (categoryId !== null) {
    clauses.push('t.categoryId = $categoryId');
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
      t.notes LIKE $search OR
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
        t.id,
        t.accountId,
        a.name AS accountName,
        a.institution AS accountInstitution,
        a.type AS accountType,
        t.categoryId,
        c.name AS categoryName,
        c.type AS categoryType,
        c.color AS categoryColor,
        c.icon AS categoryIcon,
        t.date,
        t.amount,
        t.description,
        t.merchant,
        t.originalDescription,
        t.originalCategory,
        t.type,
        t.transactionKind,
        t.status,
        t.notes,
        t.importBatchId,
        t.fingerprint,
        t.createdAt
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.accountId
       LEFT JOIN categories c ON c.id = t.categoryId
       ${where}
       ORDER BY t.date DESC, t.id DESC
       ${limitClause}`
    )
    .all(params) as TransactionRow[];

  return { transactions: rows.map(toTransactionListItem) };
}
