import { getDb } from '../database.ts';

/** Durable user decisions. Heuristic records use the same report model but are
 * re-derived from bank facts; an inference is never persisted as user approval. */
export interface ConfirmedTransferRecord {
  id: string;
  sourceAccountId: number;
  destinationAccountId: number | null;
  effectiveDate: string;
  reason: 'reporting-closure';
}

export function readConfirmedTransfers(db = getDb()): ConfirmedTransferRecord[] {
  return db.prepare("SELECT id,sourceAccountId,destinationAccountId,effectiveDate,reason FROM transferRecords WHERE status='confirmed' ORDER BY effectiveDate,id").all() as unknown as ConfirmedTransferRecord[];
}

export function confirmClosureTransfer(sourceAccountId: number, effectiveDate: string, destinationAccountId: number | null, db = getDb()) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO transferRecords VALUES (?, ?, ?, ?, 'reporting-closure', 'confirmed', ?, ?)
    ON CONFLICT(id) DO UPDATE SET destinationAccountId=excluded.destinationAccountId,
      effectiveDate=excluded.effectiveDate,status='confirmed',updatedAt=excluded.updatedAt`)
    .run(`closure:${sourceAccountId}`, sourceAccountId, destinationAccountId, effectiveDate, now, now);
}

export function revokeClosureTransfer(sourceAccountId: number, db = getDb()) {
  db.prepare("UPDATE transferRecords SET status='revoked',updatedAt=? WHERE id=?")
    .run(new Date().toISOString(), `closure:${sourceAccountId}`);
}
