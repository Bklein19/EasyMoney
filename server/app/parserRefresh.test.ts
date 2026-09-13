import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
process.env.EASYMONEY_DB_PATH ||= `/private/tmp/easymoney-parser-refresh-${process.pid}.sqlite`;
const { getDb, initDatabase } = await import('../database');
const { refreshParserDerivations } = await import('./parserRefresh');
const { buildLedgerFromSourceFacts, materializeLedger } = await import('./ledgerRebuild');
const { hashContent } = await import('../hash');
const { recoverImportOriginals } = await import('./originalRecovery');
const { registerApprovedReplacement } = await import('./importReplacements');
const { captureRefreshConflicts, compareRefreshConflicts, readRefreshDiagnostics } = await import('./parserRefreshDiagnostics');
import type { AppImportParser } from './importTypes';
initDatabase();

function fixture() {
  const memory = new Database(':memory:', { strict: true });
  for (const row of getDb().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) memory.exec(row.sql);
  memory.exec('PRAGMA foreign_keys=ON');
  const db = memory as unknown as ReturnType<typeof getDb>;
  const bytes = new TextEncoder().encode('synthetic original');
  db.prepare("INSERT INTO accounts (id,name,type) VALUES (1,'Synthetic','checking')").run();
  db.prepare("INSERT INTO importFiles (id,fileName,contentHash,status) VALUES (1,'synthetic.txt',?,'committed')").run(hashContent(bytes));
  db.prepare(`INSERT INTO sourceFiles (id,importFileId,fileName,contentHash,parserName,sourceType,status)
    VALUES (1,1,'synthetic.txt',?,'synthetic','activity-export','committed')`).run(hashContent(bytes));
  db.prepare("INSERT INTO sourceAccounts (id,sourceFileId,accountId,institution,sourceAccountKey) VALUES (1,1,1,'Synthetic','remote')").run();
  db.prepare("INSERT INTO importRows (id,importFileId,rowIndex,rawJson) VALUES (1,1,0,'{}')").run();
  db.prepare(`INSERT INTO sourceTransactions (id,sourceFileId,sourceAccountId,importRowId,stableSourceId,date,amountCents,description,sourceRole)
    VALUES (1,1,1,1,'old','2026-01-01',-1000,'Original description','activity')`).run();
  db.prepare('INSERT INTO importOriginals VALUES (1,?,?,?)').run(hashContent(bytes), hashContent(bytes), bytes);
  db.prepare("INSERT INTO parserDerivations (sourceFileId,version,status,updatedAt) VALUES (1,'v1','current','now')").run();
  materializeLedger(db, buildLedgerFromSourceFacts(db));
  const parser: AppImportParser = {
    id: 'synthetic', name: 'Synthetic', institution: 'Synthetic', sourceType: 'activity-export', priority: 100,
    matches: () => true,
    parse: () => ({ transactions: [{ sourceRowIndex: 0, date: '2026-01-01', amountCents: -1000,
      description: 'Clean description', sourceRole: 'activity', remoteAccountId: 'remote', institution: 'Synthetic' }], balances: [] }),
  };
  let backups = 0;
  const run = () => refreshParserDerivations({ db, parsers: [parser], versions: { synthetic: 'v2' }, backup: () => { backups++; } });
  return { db, memory, parser, run, backups: () => backups };
}

test('changed parser refreshes atomically, archives facts, preserves mappings and skips unchanged versions', async () => {
  const f = fixture();
  try {
    expect((await f.run()).refreshed).toBe(1);
    expect(f.db.prepare('SELECT description FROM ledgerTransactions').get()?.description).toBe('Clean description');
    expect(f.db.prepare('SELECT accountId FROM sourceAccounts WHERE id=1').get()?.accountId).toBe(1);
    expect(f.db.prepare('SELECT factsJson FROM parserDerivationHistory').get()?.factsJson).toContain('Original description');
    expect((await f.run()).refreshed).toBe(0);
    expect(f.backups()).toBe(1);
  } finally { f.memory.close(); }
});

test.each(['mapping', 'empty', 'parse-error', 'annotation', 'integrity', 'missing', 'concurrent-write'] as const)('unsafe parser refresh retains ledger and facts: %s', async reason => {
  const f = fixture();
  try {
    const parse = f.parser.parse;
    if (reason === 'mapping') f.parser.parse = () => ({ transactions: [{ sourceRowIndex: 0, date: '2026-01-01', amountCents: 10, description: 'Other', remoteAccountId: 'different', sourceRole: 'activity' }], balances: [] });
    if (reason === 'empty') f.parser.parse = () => ({ transactions: [], balances: [] });
    if (reason === 'parse-error') f.parser.parse = () => { throw new Error('private document details'); };
    if (reason === 'concurrent-write') f.parser.parse = async input => {
      f.db.prepare("UPDATE accounts SET name='Renamed during parse' WHERE id=1").run();
      return parse(input);
    };
    if (reason === 'annotation') f.db.exec("INSERT INTO transactionAnnotations (ledgerTransactionId,notes) SELECT ledgerTransactionId,'Keep my note' FROM ledgerTransactions");
    if (reason === 'integrity') f.db.prepare('UPDATE importOriginals SET bytes=?').run(new TextEncoder().encode('wrong'));
    if (reason === 'missing') f.db.exec('DELETE FROM importOriginals');
    const result = await f.run();
    expect(result.refreshed).toBe(0);
    expect(result.issues).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private document details');
    expect(f.db.prepare('SELECT description FROM sourceTransactions').get()?.description).toBe('Original description');
    expect(f.db.prepare('SELECT description FROM ledgerTransactions').get()?.description).toBe('Original description');
    expect(f.db.prepare('SELECT version FROM parserDerivations').get()?.version).toBe('v1');
    if (reason === 'annotation') expect(f.db.prepare('SELECT notes FROM transactionAnnotations').get()?.notes).toBe('Keep my note');
  } finally { f.memory.close(); }
});

test('unchanged annotated identities survive a refresh', async () => {
  const f = fixture();
  try {
    f.db.exec("INSERT INTO transactionAnnotations (ledgerTransactionId,notes) SELECT ledgerTransactionId,'Keep my note' FROM ledgerTransactions");
    const parse = f.parser.parse;
    f.parser.parse = async input => {
      const result = await parse(input);
      result.transactions[0]!.description = 'Original description';
      return result;
    };
    expect((await f.run()).refreshed).toBe(1);
    expect(f.db.prepare('SELECT notes FROM transactionAnnotations JOIN ledgerTransactions USING(ledgerTransactionId)').get()?.notes).toBe('Keep my note');
  } finally { f.memory.close(); }
});

test('conflicting new balances roll back both parsed facts and ledger', async () => {
  const f = fixture();
  try {
    f.parser.parse = () => ({ transactions: [], balances: [100, 200].map(balanceCents => ({
      sourceRowIndex: null, date: '2026-01-31', balanceCents, remoteAccountId: 'remote', institution: 'Synthetic',
    })) });
    expect((await f.run()).refreshed).toBe(0);
    expect(f.db.prepare('SELECT description FROM ledgerTransactions').get()?.description).toBe('Original description');
    expect(f.db.prepare('SELECT count(*) AS count FROM sourceBalances').get()?.count).toBe(0);
    expect(f.db.prepare('SELECT count(*) AS count FROM parserDerivationHistory').get()?.count).toBe(0);
    const diagnostics = readRefreshDiagnostics(f.db)!;
    expect(diagnostics.conflicts).toHaveLength(1);
    expect(diagnostics.conflicts[0]!.origin).toBe('new');
    expect(diagnostics.conflicts[0]!.members.map(m => m.amountCents)).toEqual([100, 200]);
    expect(f.db.prepare('SELECT status FROM parserDerivations').get()?.status).toBe('conflict-involved');
  } finally { f.memory.close(); }
});

test('pre-existing conflicts are attributed to participants, not unrelated refreshed files', async () => {
  const f = fixture();
  try {
    for (const id of [2, 3]) {
      f.db.prepare("INSERT INTO sourceFiles (id,fileName,contentHash,parserName,sourceType,status) VALUES (?,? ,?,'other','statement','committed')")
        .run(id, `statement-${id}.txt`, `hash-${id}`);
      f.db.prepare("INSERT INTO sourceAccounts (id,sourceFileId,accountId,institution,sourceAccountKey) VALUES (?,?,1,'Synthetic','remote')").run(id,id);
      f.db.prepare("INSERT INTO sourceBalances (sourceFileId,sourceAccountId,date,balanceCents,priority) VALUES (?,?,'2026-01-31',?,100)").run(id,id,id*100);
    }
    const priorFacts = JSON.stringify(f.db.prepare('SELECT * FROM sourceTransactions').all());
    const result = await f.run();
    expect(result.refreshed).toBe(0);
    expect(result.issues.find(i => i.sourceFileId === 1)?.status).toBe('held');
    const diagnostics = readRefreshDiagnostics(f.db)!;
    expect(diagnostics.conflicts).toHaveLength(1);
    expect(diagnostics.conflicts[0]!.origin).toBe('existing');
    expect(diagnostics.conflicts[0]!.members.map(m => m.sourceFileId)).toEqual([2,3]);
    expect(JSON.stringify(f.db.prepare('SELECT * FROM sourceTransactions').all())).toBe(priorFacts);
    expect(f.db.prepare('SELECT count(*) AS n FROM parserDerivationHistory').get()?.n).toBe(0);
  } finally { f.memory.close(); }
});

test('conflict comparison ignores regenerated IDs and reports resolved groups', () => {
  const f = fixture();
  try {
    for (const [id, amount] of [[1,100],[2,200]]) f.db.prepare("INSERT INTO sourceBalances (id,sourceFileId,sourceAccountId,date,balanceCents) VALUES (?,1,1,'2026-01-31',?)").run(id!,amount!);
    const before = captureRefreshConflicts(f.db, buildLedgerFromSourceFacts(f.db));
    f.db.exec('UPDATE sourceBalances SET id=id+100');
    const after = captureRefreshConflicts(f.db, buildLedgerFromSourceFacts(f.db));
    expect(compareRefreshConflicts(before,after,'revision').conflicts[0]!.origin).toBe('existing');
    expect(compareRefreshConflicts(before,[],'revision').resolved).toHaveLength(1);
  } finally { f.memory.close(); }
});

test('diagnostic-only refresh cannot apply otherwise valid changes', async () => {
  const f = fixture();
  try {
    const result = await refreshParserDerivations({ db:f.db, parsers:[f.parser], versions:{synthetic:'v2'}, backup:()=>{}, validateOnly:true });
    expect(result.refreshed).toBe(0);
    expect(result.issues[0]!.status).toBe('held');
    expect(f.db.prepare('SELECT description FROM sourceTransactions').get()?.description).toBe('Original description');
    expect(f.db.prepare('SELECT count(*) AS n FROM parserDerivationHistory').get()?.n).toBe(0);
  } finally { f.memory.close(); }
});

test.each([false,true])('refresh tolerates unchanged overlap warnings but blocks introduced ones: introduced=%s', async introduced => {
  const f=fixture();
  try {
    f.db.exec("INSERT INTO sourceFiles (id,fileName,contentHash,parserName,sourceType,status) VALUES (2,'statement.txt','other','other','statement','committed')");
    f.db.exec("INSERT INTO sourceAccounts (id,sourceFileId,accountId,institution,sourceAccountKey) VALUES (2,2,1,'Synthetic','remote')");
    f.db.prepare("INSERT INTO sourceTransactions (sourceFileId,sourceAccountId,stableSourceId,date,amountCents,description,sourceRole) VALUES (2,2,'other','2026-01-02',?,'Different wording','activity')").run(introduced?-2000:-1000);
    const parse=f.parser.parse;
    if(introduced) f.parser.parse=async input=>{const result=await parse(input);result.transactions[0]!.amountCents=-2000;return result;};
    const result=await f.run();
    expect(result.refreshed).toBe(introduced?0:1);
    expect(f.db.prepare('SELECT amountCents FROM sourceTransactions WHERE sourceFileId=1').get()?.amountCents).toBe(-1000);
    if(introduced) expect(readRefreshDiagnostics(f.db)?.conflicts[0]?.origin).toBe('new');
    else expect(f.db.prepare('SELECT description FROM sourceTransactions WHERE sourceFileId=1').get()?.description).toBe('Clean description');
  }finally{f.memory.close();}
});

test('inactive imports are not reactivated by parser refresh', async () => {
  const f = fixture();
  try {
    f.db.exec("UPDATE sourceFiles SET status='unimported'");
    expect((await f.run()).refreshed).toBe(0);
    expect(f.backups()).toBe(0);
    expect(f.db.prepare('SELECT status FROM sourceFiles').get()?.status).toBe('unimported');
  } finally { f.memory.close(); }
});

test('an unchanged failed attempt is not repeated automatically', async () => {
  const f = fixture();
  try {
    let attempts = 0;
    f.parser.parse = () => { attempts++; throw new Error('failed'); };
    await f.run();
    await f.run();
    expect(attempts).toBe(1);
    expect(f.backups()).toBe(0);
  } finally { f.memory.close(); }
});

test('legacy decoded-text hashes recover byte-exact originals with a separate checksum', async () => {
  const f = fixture();
  const root = await mkdtemp('/private/tmp/easymoney-original-test-');
  try {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff]);
    const oldHash = hashContent(new TextDecoder().decode(bytes));
    f.db.exec('DELETE FROM importOriginals');
    f.db.prepare('UPDATE importFiles SET contentHash=?').run(oldHash);
    await writeFile(join(root, 'synthetic.txt'), bytes);
    expect(await recoverImportOriginals([root], f.db)).toEqual({ recovered: 1, missing: 0 });
    const original = f.db.prepare('SELECT * FROM importOriginals').get()!;
    expect(original.contentHash).toBe(oldHash);
    expect(original.bytesHash).toBe(hashContent(bytes));
    expect(new Uint8Array(original.bytes)).toEqual(bytes);
  } finally { f.memory.close(); await rm(root, { recursive: true, force: true }); }
});

test('legacy lossy-hash collisions are not automatically recovered', async () => {
  const f = fixture();
  const root = await mkdtemp('/private/tmp/easymoney-original-test-');
  try {
    const first = new Uint8Array([0xff]);
    const second = new Uint8Array([0xfe]);
    const oldHash = hashContent(new TextDecoder().decode(first));
    f.db.exec('DELETE FROM importOriginals');
    f.db.prepare('UPDATE importFiles SET contentHash=?').run(oldHash);
    await writeFile(join(root, `${hashContent(first)}-synthetic.txt`), first);
    await writeFile(join(root, `${hashContent(second)}-synthetic.txt`), second);
    expect(await recoverImportOriginals([root], f.db)).toEqual({ recovered: 0, missing: 1 });
  } finally { f.memory.close(); await rm(root, { recursive: true, force: true }); }
});

test('approved replacement preserves old hashes and facts, is idempotent, and is usable by refresh', async () => {
  const f = fixture();
  const root = await mkdtemp('/private/tmp/easymoney-replacement-test-');
  try {
    f.db.exec('DELETE FROM importOriginals');
    const oldHash = f.db.prepare('SELECT contentHash FROM sourceFiles').get()!.contentHash;
    const ledgerBefore = JSON.stringify(f.db.prepare('SELECT * FROM ledgerTransactions').all());
    const parse = f.parser.parse;
    f.parser.parse = async input => { const parsed = await parse(input); parsed.transactions[0]!.description = 'Original description'; return parsed; };
    const filePath = join(root, 'replacement.txt');
    await writeFile(filePath, 'replacement bytes');
    const input = { sourceFileId: 1, expectedAccountId: 1, filePath, approved: true as const, approvalNote: 'User approved same-facts replacement.' };
    const options = { db: f.db, parsers: [f.parser], backup: () => {} };
    expect((await registerApprovedReplacement(input, options)).registered).toBe(true);
    expect((await registerApprovedReplacement(input, options)).registered).toBe(false);
    expect(f.db.prepare('SELECT contentHash FROM sourceFiles').get()!.contentHash).toBe(oldHash);
    expect(JSON.stringify(f.db.prepare('SELECT * FROM ledgerTransactions').all())).toBe(ledgerBefore);
    expect(f.db.prepare('SELECT count(*) AS count FROM importOriginals').get()!.count).toBe(0);
    const replacement = f.db.prepare('SELECT * FROM importReplacementVersions').get()!;
    expect(replacement.priorContentHash).toBe(oldHash);
    expect(replacement.bytesHash).not.toBe(oldHash);
    expect(replacement.priorFactsJson).toContain('Original description');
    expect((await f.run()).refreshed).toBe(1);
  } finally { f.memory.close(); await rm(root, { recursive: true, force: true }); }
});

test('replacement rejects changed financial facts and unverified mapping', async () => {
  const f = fixture();
  const root = await mkdtemp('/private/tmp/easymoney-replacement-test-');
  try {
    f.db.exec('DELETE FROM importOriginals');
    const filePath = join(root, 'replacement.txt');
    await writeFile(filePath, 'replacement bytes');
    const input = { sourceFileId: 1, expectedAccountId: 1, filePath, approved: true as const, approvalNote: 'User approved same-facts replacement.' };
    const options = { db: f.db, parsers: [f.parser], backup: () => {} };
    await expect(registerApprovedReplacement(input, options)).rejects.toThrow('financial facts differ');
    await expect(registerApprovedReplacement({ ...input, expectedAccountId: 2 }, options)).rejects.toThrow('mapping is not verified');
    expect(f.db.prepare('SELECT count(*) AS count FROM importReplacementVersions').get()!.count).toBe(0);
  } finally { f.memory.close(); await rm(root, { recursive: true, force: true }); }
});
