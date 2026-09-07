import { getDb } from '../database.ts';
import { buildLedgerFromSourceFacts } from './ledgerRebuild';

export function getTransactionDetails(ledgerTransactionId: string) {
  const db = getDb();
  const transaction = db.prepare(`SELECT t.ledgerTransactionId, t.originalDescription, t.description, t.date, t.amountCents,
    a.name AS accountName, ta.notes, c.name AS categoryName
    FROM ledgerTransactions t JOIN accounts a ON a.id = t.accountId
    LEFT JOIN transactionAnnotations ta ON ta.ledgerTransactionId = t.ledgerTransactionId
    LEFT JOIN categories c ON c.id = ta.categoryId WHERE t.ledgerTransactionId = ?`).get(ledgerTransactionId) as
    { ledgerTransactionId: string; originalDescription: string | null; description: string | null; date: string; amountCents: number; accountName: string; notes: string | null; categoryName: string | null } | undefined;
  if (!transaction) throw new Error('Transaction no longer exists in the active ledger. Refresh the list.');
  let evidence = db.prepare('SELECT sourceTransactionId, reason, selected FROM ledgerProvenance WHERE ledgerTransactionId = ? ORDER BY selected DESC, sourceTransactionId')
    .all(ledgerTransactionId) as { sourceTransactionId: number; reason: string; selected: number | boolean }[];
  // Older ledgers have no persisted explanations. Recompute the explanation without modifying any rows.
  if (!evidence.length) evidence = (buildLedgerFromSourceFacts(db).provenance ?? []).filter(item => item.ledgerTransactionId === ledgerTransactionId);
  const sources = evidence.flatMap(item => {
    const source = db.prepare(`SELECT st.id, st.date, st.amountCents, st.description, sf.fileName, sf.parserName,
      sf.status, sf.importFileId, sa.sourceAccountName, a.name AS mappedAccountName, ir.rowIndex
      FROM sourceTransactions st JOIN sourceFiles sf ON sf.id = st.sourceFileId
      JOIN sourceAccounts sa ON sa.id = st.sourceAccountId LEFT JOIN accounts a ON a.id = sa.accountId
      LEFT JOIN importRows ir ON ir.id = st.importRowId WHERE st.id = ?`).get(item.sourceTransactionId) as
      { id: number; date: string; amountCents: number; description: string | null; fileName: string; parserName: string | null; status: string;
        importFileId: number | null; sourceAccountName: string | null; mappedAccountName: string | null; rowIndex: number | null } | undefined;
    return source ? [{ ...source, reason: item.reason, selected: Boolean(item.selected) }] : [];
  });
  return { transaction, sources };
}
