import { getDb, updateRow } from '../database.js';
import { getLedgerTransactionId } from './transactionIdentity.ts';

interface TransactionRow {
  id: number;
  accountId: number | null;
  date: string;
  amount: number;
  description: string | null;
  merchant: string | null;
  originalDescription: string | null;
  transactionKind: string | null;
  ledgerTransactionId: string | null;
  occurrenceIndex: number | null;
}

interface AnnotationChanges {
  categoryId?: number | string | null;
  notes?: string | null;
}

export function ensureLedgerTransactionId(transactionId: number | string) {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, accountId, date, amount, description, merchant, originalDescription, transactionKind, ledgerTransactionId, occurrenceIndex
    FROM transactions
    WHERE id = ?
  `).get(transactionId) as TransactionRow | undefined;

  if (!row) throw new Error(`Transaction not found: ${transactionId}`);
  if (row.ledgerTransactionId) return row.ledgerTransactionId;

  const ledgerTransactionId = getLedgerTransactionId(row);
  updateRow('transactions', row.id, {
    ledgerTransactionId,
    occurrenceIndex: row.occurrenceIndex ?? 0,
  });
  return ledgerTransactionId;
}

export function upsertTransactionAnnotation(transactionId: number | string, changes: AnnotationChanges) {
  const ledgerTransactionId = ensureLedgerTransactionId(transactionId);
  const now = new Date().toISOString();
  const db = getDb();

  db.prepare(`
    INSERT INTO transactionAnnotations (ledgerTransactionId, categoryId, notes, createdAt, updatedAt)
    VALUES (@ledgerTransactionId, @categoryId, @notes, @createdAt, @updatedAt)
    ON CONFLICT(ledgerTransactionId) DO UPDATE SET
      categoryId = CASE WHEN @hasCategoryId THEN excluded.categoryId ELSE transactionAnnotations.categoryId END,
      notes = CASE WHEN @hasNotes THEN excluded.notes ELSE transactionAnnotations.notes END,
      updatedAt = excluded.updatedAt
  `).run({
    ledgerTransactionId,
    categoryId: changes.categoryId === undefined ? null : changes.categoryId,
    notes: changes.notes === undefined ? null : changes.notes,
    hasCategoryId: changes.categoryId === undefined ? 0 : 1,
    hasNotes: changes.notes === undefined ? 0 : 1,
    createdAt: now,
    updatedAt: now,
  });

  return ledgerTransactionId;
}

export function splitTransactionAnnotationChanges(changes: Record<string, unknown>) {
  const annotationChanges: AnnotationChanges = {};
  const transactionChanges = { ...changes };

  if (Object.hasOwn(transactionChanges, 'categoryId')) {
    annotationChanges.categoryId = transactionChanges.categoryId as number | string | null;
    delete transactionChanges.categoryId;
  }

  if (Object.hasOwn(transactionChanges, 'notes')) {
    annotationChanges.notes = transactionChanges.notes as string | null;
    delete transactionChanges.notes;
  }

  return {
    transactionChanges,
    annotationChanges,
    hasAnnotationChanges: Object.hasOwn(annotationChanges, 'categoryId') || Object.hasOwn(annotationChanges, 'notes'),
  };
}
