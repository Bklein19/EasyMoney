import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import type { getDb } from '../../database.ts';
process.env.EASYMONEY_DB_PATH ||= `/private/tmp/easymoney-review-outcomes-${process.pid}.sqlite`;
const { simulateMappedImportOutcomes } = await import('./reviewOutcomes.ts');
const { buildLedgerFromSourceFacts } = await import('../ledgerRebuild.ts');
const { assertSyncReviewConfirmation } = await import('./reviewOutcomes.ts');
const { overlapOccurrenceKey, recordDistinctOverlap } = await import('../reviewedOverlap');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT, type TEXT);
    CREATE TABLE ledgerTransactions (ledgerTransactionId TEXT, accountId INTEGER, date TEXT, amountCents INTEGER, description TEXT);
    CREATE TABLE ledgerBalances (accountId INTEGER, month TEXT, balanceCents INTEGER, capturedAt TEXT);
    CREATE TABLE sourceFiles (id INTEGER PRIMARY KEY, importFileId INTEGER, sourceType TEXT, status TEXT, contentHash TEXT DEFAULT 'synthetic');
    CREATE TABLE reviewedDistinctOverlaps (leftKey TEXT, rightKey TEXT, reason TEXT, createdAt TEXT, PRIMARY KEY(leftKey,rightKey));
    CREATE TABLE sourceAccounts (id INTEGER PRIMARY KEY, sourceFileId INTEGER, accountId INTEGER);
    CREATE TABLE importRows (id INTEGER PRIMARY KEY, rowIndex INTEGER);
    CREATE TABLE sourceTransactions (id INTEGER PRIMARY KEY, sourceFileId INTEGER, sourceAccountId INTEGER, importRowId INTEGER, stableSourceId TEXT, date TEXT, amountCents INTEGER, description TEXT, sourceRole TEXT, priority INTEGER, rawJson TEXT);
    CREATE TABLE sourceBalances (id INTEGER PRIMARY KEY, sourceFileId INTEGER, sourceAccountId INTEGER, importRowId INTEGER, date TEXT, balanceCents INTEGER, priority INTEGER, rawJson TEXT);
    INSERT INTO accounts VALUES (1, 'Synthetic checking', 'checking'), (2, 'Other checking', 'checking');
  `);
  let transactionId = 0;
  const file = (id:number, status = 'previewed', sourceType = 'activity-export') => {
    db.prepare('INSERT INTO sourceFiles(id,importFileId,sourceType,status) VALUES (?, ?, ?, ?)').run(id,id,sourceType,status);
    db.prepare('INSERT INTO sourceAccounts VALUES (?, ?, ?)').run(id,id,status === 'committed' ? 1 : null);
  };
  const transaction = (fileId:number, date:string, description = 'Synthetic shop', amount = -1000, priority = 100) => {
    transactionId++;
    db.prepare('INSERT INTO sourceTransactions VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)').run(transactionId,fileId,fileId,`source-${transactionId}`,date,amount,description,'activity',priority,'{}');
  };
  const persistBaseline = () => {
    const ledger = buildLedgerFromSourceFacts(db as unknown as ReturnType<typeof getDb>);
    db.exec('DELETE FROM ledgerTransactions; DELETE FROM ledgerBalances');
    for (const row of ledger.transactions) db.prepare('INSERT INTO ledgerTransactions VALUES (?, ?, ?, ?, ?)').run(row.ledgerTransactionId,row.accountId,row.date,Math.round(row.amount*100),row.description);
    for (const row of ledger.balanceSnapshots) db.prepare('INSERT INTO ledgerBalances VALUES (?, ?, ?, ?)').run(row.accountId,row.month,Math.round(row.balance*100),row.capturedAt);
  };
  const outcome = (files:number[], mappings = new Map(files.map(id => [id,1]))) => simulateMappedImportOutcomes(db as unknown as ReturnType<typeof getDb>,files,mappings);
  return {db,file,transaction,outcome,persistBaseline};
}

test('mapped overlapping windows preserve repeated real occurrences and only add new dates', () => {
  const f = fixture();
  try {
    f.file(1,'committed'); f.transaction(1,'2026-01-01'); f.transaction(1,'2026-01-01');
    f.file(2); f.transaction(2,'2026-01-01'); f.transaction(2,'2026-01-01'); f.transaction(2,'2026-01-02');
    expect(f.outcome([2]).transactions).toEqual({parsed:3,new:1,represented:2,ambiguous:0,excludedSummaries:0});
    expect(f.outcome([2],new Map([[2,2]])).transactions.new).toBe(3);
    expect(f.db.prepare('SELECT status FROM sourceFiles WHERE id = 2').get()).toEqual({status:'previewed'});
    expect(f.db.prepare('SELECT accountId FROM sourceAccounts WHERE id = 2').get()).toEqual({accountId:null});
  } finally { f.db.close(); }
});

test('within-batch overlap is occurrence-aware and order independent', () => {
  const f = fixture();
  try {
    f.file(1); f.transaction(1,'2026-01-01'); f.transaction(1,'2026-01-01');
    f.file(2); f.transaction(2,'2026-01-01');
    const result = f.outcome([1,2]);
    expect(result.transactions).toEqual({parsed:3,new:2,represented:1,ambiguous:0,excludedSummaries:0});
    expect(f.outcome([2,1]).transactions).toEqual(result.transactions);
  } finally { f.db.close(); }
});

test('review simulation carries original-bound distinctness decisions and revisions', () => {
  const f=fixture();
  try {
    f.file(1,'committed','activity-export');f.transaction(1,'2026-01-01','First airline');
    f.file(2,'committed','statement');f.transaction(2,'2026-01-02','Second airline');
    f.persistBaseline();
    const before=f.outcome([]);
    expect(before.historical.ambiguousTransactions).toBeGreaterThan(0);
    const db=f.db as unknown as ReturnType<typeof getDb>;
    recordDistinctOverlap(db,overlapOccurrenceKey(db,1),overlapOccurrenceKey(db,2),'Reviewed as separate charges.');
    const after=f.outcome([]);
    expect(after.historical.ambiguousTransactions).toBe(0);
    expect(after.revision).not.toBe(before.revision);
    expect(after.nothingNew).toBe(true);
  }finally{f.db.close();}
});

test('repeat import with no ledger changes reports nothing new', () => {
  const f = fixture();
  try {
    f.file(1,'committed'); f.transaction(1,'2026-01-01');
    f.file(2); f.transaction(2,'2026-01-01');
    f.persistBaseline();
    expect(f.outcome([2]).transactions).toEqual({parsed:1,new:0,represented:1,ambiguous:0,excludedSummaries:0});
    expect(f.outcome([2]).nothingNew).toBe(true);
  } finally { f.db.close(); }
});

test('balance-only files separately identify new, updated and unchanged monthly snapshots', () => {
  const f = fixture();
  try {
    f.file(1,'committed'); f.file(2);
    f.db.exec(`INSERT INTO sourceBalances VALUES (1,1,1,NULL,'2026-01-31',5000,100,'{}'), (2,2,2,NULL,'2026-01-31',5000,100,'{}');`);
    f.persistBaseline();
    expect(f.outcome([2]).nothingNew).toBe(true);
    f.db.exec(`UPDATE sourceBalances SET balanceCents = 6000, priority = 200 WHERE id = 2`);
    expect(f.outcome([2]).balances.updated).toBe(1);
    f.db.exec(`UPDATE sourceBalances SET date = '2026-02-28' WHERE id = 2`);
    expect(f.outcome([2]).balances.new).toBe(1);
    expect(f.outcome([2]).nothingNew).toBe(false);
  } finally { f.db.close(); }
});

test('same account/date/amount statement overlap is represented despite different wording', () => {
  const f = fixture();
  try {
    f.file(1,'committed'); f.transaction(1,'2026-01-01','First shop',-1000,100);
    f.file(2,'previewed','statement'); f.transaction(2,'2026-01-01','Different shop',-1000,50);
    f.persistBaseline();
    expect(f.outcome([2]).transactions).toEqual({parsed:1,new:0,represented:1,ambiguous:0,excludedSummaries:0});
    expect(f.outcome([2]).nothingNew).toBe(true);
  } finally { f.db.close(); }
});

test('new account choices are simulated privately without allocating a real account', () => {
  const f = fixture();
  try {
    f.file(1); f.transaction(1,'2026-01-01');
    const result = simulateMappedImportOutcomes(f.db as unknown as ReturnType<typeof getDb>, [1], new Map([[1,-1]]), [{id:-1,type:'credit'}]);
    expect(result.transactions.new).toBe(1);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM accounts').get()).toEqual({count:2});
  } finally { f.db.close(); }
});

test('legacy summary rows are excluded, never counted as represented individual transactions', () => {
  const f = fixture();
  try {
    f.file(1); f.transaction(1,'2026-01-01');
    f.db.exec("UPDATE sourceTransactions SET sourceRole = 'statement-summary'");
    expect(f.outcome([1]).transactions).toEqual({parsed:1,new:0,represented:0,ambiguous:0,excludedSummaries:1});
  } finally { f.db.close(); }
});

test('conflicting authoritative balances block confirmation without choosing one', () => {
  const f = fixture();
  try {
    f.file(1,'committed'); f.file(2);
    f.db.exec("INSERT INTO sourceBalances VALUES (1,1,1,NULL,'2026-01-31',5000,100,'{}'), (2,2,2,NULL,'2026-01-31',6000,100,'{}')");
    f.persistBaseline();
    const outcome = f.outcome([2]);
    expect(outcome.balances.conflicting).toBe(1);
    expect(outcome.canConfirm).toBe(false);
    expect(() => assertSyncReviewConfirmation(outcome,outcome.revision)).toThrow('Import is paused');
  } finally { f.db.close(); }
});

test('historical drift is separate from incoming outcomes and blocks implicit reconciliation', () => {
  const f = fixture();
  try {
    f.file(1,'committed'); f.transaction(1,'2026-01-01');
    f.file(2); f.transaction(2,'2026-02-01');
    const outcome = f.outcome([2]);
    expect(outcome.transactions.new).toBe(1);
    expect(outcome.historical.transactionsAdded).toBe(1);
    expect(outcome.canConfirm).toBe(false);
    f.persistBaseline();
    expect(f.outcome([2]).canConfirm).toBe(true);
  } finally { f.db.close(); }
});

test('source updates, mapping changes, and persisted-ledger changes invalidate review revision', () => {
  const f = fixture();
  try {
    f.file(1); f.transaction(1,'2026-01-01');
    const initial = f.outcome([1]);
    expect(() => assertSyncReviewConfirmation(initial,initial.revision)).not.toThrow();
    expect(() => assertSyncReviewConfirmation(f.outcome([1],new Map([[1,2]])),initial.revision)).toThrow('stale');
    f.db.exec("UPDATE sourceTransactions SET amountCents = -2000");
    expect(() => assertSyncReviewConfirmation(f.outcome([1]),initial.revision)).toThrow('stale');
    const latest = f.outcome([1]);
    f.db.exec("INSERT INTO ledgerTransactions VALUES ('unexpected',1,'2026-01-01',-1000,'Synthetic shop')");
    expect(() => assertSyncReviewConfirmation(f.outcome([1]),latest.revision)).toThrow('stale');
  } finally { f.db.close(); }
});

test('historical date formatting alone is not a financial change', () => {
  const f = fixture();
  try {
    f.file(1,'committed'); f.transaction(1,'2026-01-01'); f.persistBaseline();
    f.db.exec("UPDATE ledgerTransactions SET date = '2026-01-01T00:00:00.000Z'");
    expect(f.outcome([]).historical.transactionsChanged).toBe(0);
    expect(f.outcome([]).canConfirm).toBe(true);
  } finally { f.db.close(); }
});
