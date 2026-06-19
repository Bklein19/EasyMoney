import { getDb } from '../server/database.js';
import { buildLedgerFromSourceFacts, materializeLedger } from '../server/app/ledgerRebuild.ts';

const startedAt = Date.now();
const db = getDb();
const ledger = buildLedgerFromSourceFacts(db);
const result = materializeLedger(db, ledger);
const durationMs = Date.now() - startedAt;

console.log([
  `Rebuilt ledger read model in ${durationMs}ms.`,
  `Transactions: ${result.transactionCount}`,
  `Balance snapshots: ${result.balanceSnapshotCount}`,
].join('\n'));
