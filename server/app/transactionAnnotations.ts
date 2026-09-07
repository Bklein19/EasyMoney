import { getDb } from '../database.ts';

interface AnnotationChanges {
  categoryId?: number | string | null;
  notes?: string | null;
}

export function ensureLedgerTransactionId(transactionId: number | string) {
  const db = getDb();
  const direct = db.prepare('SELECT ledgerTransactionId FROM ledgerTransactions WHERE ledgerTransactionId = ?').get(String(transactionId)) as
    { ledgerTransactionId: string } | undefined;
  if (direct) return direct.ledgerTransactionId;
  const numericId = Number(transactionId);
  if (!Number.isSafeInteger(numericId)) throw new Error('Transaction not found in the active ledger.');
  const row = db.prepare('SELECT ledgerTransactionId FROM ledgerTransactions WHERE COALESCE(legacyTransactionId, id) = ?').get(numericId) as
    { ledgerTransactionId: string } | undefined;
  if (!row) throw new Error('Transaction not found in the active ledger.');
  return row.ledgerTransactionId;
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
