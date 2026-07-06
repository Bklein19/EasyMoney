import { hashContent } from '../database.ts';

interface TransactionIdentityInput {
  id?: number | string | null;
  accountId?: number | string | null;
  date?: string | null;
  amount?: number | string | null;
  amountCents?: number | string | null;
  description?: string | null;
  originalDescription?: string | null;
  merchant?: string | null;
  sourceRole?: string | null;
  transactionKind?: string | null;
  occurrenceIndex?: number | string | null;
  importFileId?: number | string | null;
  importRowId?: number | string | null;
  sourceRowIndex?: number | string | null;
  fingerprint?: string | null;
  stableSourceId?: string | null;
  createdAt?: string | null;
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

function normalizeInteger(value: number | string | null | undefined) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function sortToken(value: number | string | null | undefined) {
  if (typeof value === 'number') return String(value).padStart(16, '0');
  return String(value || '');
}

export function getLedgerTransactionBaseKey(transaction: TransactionIdentityInput) {
  const description = transaction.originalDescription || transaction.description || transaction.merchant || '';
  const sourceRole = transaction.sourceRole || transaction.transactionKind || 'activity';
  return [
    transaction.accountId || '',
    normalizeDate(transaction.date),
    normalizeAmount(transaction.amount),
    normalizeText(description),
    normalizeText(sourceRole),
  ].join('|');
}

export function getLedgerTransactionId(transaction: TransactionIdentityInput) {
  const occurrenceIndex = Number(transaction.occurrenceIndex || 0);
  const key = [
    getLedgerTransactionBaseKey(transaction),
    Number.isFinite(occurrenceIndex) ? occurrenceIndex : 0,
  ].join('|');

  return `txn_${hashContent(key).slice(0, 32)}`;
}

export function getTransactionOccurrenceSortKey(transaction: TransactionIdentityInput) {
  return [
    transaction.stableSourceId || '',
    sortToken(transaction.importFileId),
    sortToken(transaction.importRowId),
    sortToken(transaction.sourceRowIndex),
    transaction.fingerprint || '',
    transaction.createdAt || '',
    sortToken(transaction.id),
    normalizeDate(transaction.date),
    normalizeAmount(transaction.amount),
    normalizeText(transaction.originalDescription || transaction.description || transaction.merchant || ''),
  ].join('|');
}

export function assignLedgerTransactionIdentities<T extends TransactionIdentityInput>(transactions: T[]) {
  const groups = new Map<string, T[]>();
  for (const transaction of transactions) {
    const key = getLedgerTransactionBaseKey(transaction);
    const group = groups.get(key);
    if (group) {
      group.push(transaction);
    } else {
      groups.set(key, [transaction]);
    }
  }

  const assigned = new Map<T, { occurrenceIndex: number; ledgerTransactionId: string }>();
  for (const group of groups.values()) {
    [...group]
      .sort((a, b) => getTransactionOccurrenceSortKey(a).localeCompare(getTransactionOccurrenceSortKey(b)))
      .forEach((transaction, occurrenceIndex) => {
        assigned.set(transaction, {
          occurrenceIndex,
          ledgerTransactionId: getLedgerTransactionId({ ...transaction, occurrenceIndex }),
        });
      });
  }

  return transactions.map(transaction => ({
    transaction,
    occurrenceIndex: assigned.get(transaction)?.occurrenceIndex ?? normalizeInteger(transaction.occurrenceIndex),
    ledgerTransactionId: assigned.get(transaction)?.ledgerTransactionId ?? getLedgerTransactionId(transaction),
  }));
}
