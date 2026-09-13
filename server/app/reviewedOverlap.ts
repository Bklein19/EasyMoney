import type { getDb } from '../database';
import { hashContent } from '../hash';
type Db = ReturnType<typeof getDb>;

/** Bound to an immutable original, account and complete derived occurrence. */
export function overlapOccurrenceKey(db: Db, sourceTransactionId: number): string {
  const row=db.prepare(`SELECT sf.contentHash,st.sourceFileId,st.stableSourceId,sa.accountId,
    st.date,st.amountCents,st.description,st.rawJson,ir.rowIndex FROM sourceTransactions st
    JOIN sourceFiles sf ON sf.id=st.sourceFileId JOIN sourceAccounts sa ON sa.id=st.sourceAccountId
    LEFT JOIN importRows ir ON ir.id=st.importRowId WHERE st.id=?`).get(sourceTransactionId);
  if(!row) throw new Error('Overlap source occurrence is missing.');
  return hashContent(JSON.stringify(row));
}

export function recordDistinctOverlap(db: Db, leftKey: string, rightKey: string, reason: string) {
  if(!/^[a-f0-9]{64}$/.test(leftKey) || !/^[a-f0-9]{64}$/.test(rightKey) || leftKey===rightKey || !reason.trim()) throw new Error('Distinctness requires two source-bound occurrences and review evidence.');
  const [left,right]=[leftKey,rightKey].sort();
  db.prepare('INSERT OR IGNORE INTO reviewedDistinctOverlaps(leftKey,rightKey,reason,createdAt) VALUES(?,?,?,?)')
    .run(left,right,reason,new Date().toISOString());
}

export function reviewedDistinctOverlap(db: Db, leftKey: string, rightKey: string) {
  const [left,right]=[leftKey,rightKey].sort();
  return Boolean(db.prepare('SELECT 1 FROM reviewedDistinctOverlaps WHERE leftKey=? AND rightKey=?').get(left,right));
}
