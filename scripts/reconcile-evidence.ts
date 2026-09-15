import { Database } from 'bun:sqlite';
import { reconcileAccountEvidence, type BalanceEvidence, type EvidencePeriod } from '../server/app/reconciliationExperiment';

// Explicit path required. Never initialize/migrate the application database here.
const [databasePath, start, end] = process.argv.slice(2);
if (!databasePath || !start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
  throw new Error('Usage: bun scripts/reconcile-evidence.ts DATABASE START_DATE END_DATE');
}
const db = new Database(databasePath, { readonly: true });
db.exec('PRAGMA query_only=ON; BEGIN');
try {
  const accounts = db.query('SELECT id, name, type, status FROM accounts ORDER BY id').all() as Array<{ id: number; name: string; type: string; status: string }>;
  const report = accounts.map(account => {
    const periods = db.query(`SELECT DISTINCT sf.coveredFrom AS start, sf.coveredTo AS end
      FROM sourceFiles sf JOIN sourceAccounts sa ON sa.sourceFileId=sf.id
      WHERE sf.status='committed' AND sf.sourceType='statement' AND sf.coverageBasis='declared'
      AND sa.accountId=? AND sf.coveredFrom IS NOT NULL AND sf.coveredTo IS NOT NULL
      AND (SELECT count(*) FROM sourceAccounts peer WHERE peer.sourceFileId=sf.id)=1`).all(account.id) as EvidencePeriod[];
    const balances = db.query(`SELECT sb.date, sb.balanceCents AS amountCents, sf.id AS sourceFileId
      FROM sourceBalances sb JOIN sourceAccounts sa ON sa.id=sb.sourceAccountId JOIN sourceFiles sf ON sf.id=sb.sourceFileId
      WHERE sf.status='committed' AND sf.sourceType='statement' AND sa.accountId=?`).all(account.id) as BalanceEvidence[];
    const transactions = db.query('SELECT date, amountCents FROM ledgerTransactions WHERE accountId=?').all(account.id) as Array<{ date: string; amountCents: number }>;
    return { account, ...reconcileAccountEvidence({ type: account.type, start, end, periods, balances, transactions }) };
  });
  console.log(JSON.stringify({ start, end, accounts: report }, null, 2));
} finally { db.exec('ROLLBACK'); db.close(); }
