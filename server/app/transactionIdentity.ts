import { hashContent } from '../database.js';

interface TransactionIdentityInput {
  accountId?: number | string | null;
  date?: string | null;
  amount?: number | string | null;
  description?: string | null;
  originalDescription?: string | null;
  merchant?: string | null;
  sourceRole?: string | null;
  transactionKind?: string | null;
  occurrenceIndex?: number | string | null;
}

function normalizeText(value: string | null | undefined) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDate(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function normalizeAmount(value: number | string | null | undefined) {
  return Number(value || 0).toFixed(2);
}

export function getLedgerTransactionId(transaction: TransactionIdentityInput) {
  const description = transaction.originalDescription || transaction.description || transaction.merchant || '';
  const sourceRole = transaction.sourceRole || transaction.transactionKind || 'activity';
  const occurrenceIndex = Number(transaction.occurrenceIndex || 0);
  const key = [
    transaction.accountId || '',
    normalizeDate(transaction.date),
    normalizeAmount(transaction.amount),
    normalizeText(description),
    normalizeText(sourceRole),
    Number.isFinite(occurrenceIndex) ? occurrenceIndex : 0,
  ].join('|');

  return `txn_${hashContent(key).slice(0, 32)}`;
}
