import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabaseBackup, getDb } from '../database';
import { hashContent } from '../hash';
import { IMPORT_PARSERS } from './importParsers';
import type { AppImportParser } from './importTypes';

type Db = ReturnType<typeof getDb>;
function priorFacts(db: Db, sourceFileId: number) {
  return {
    file: db.prepare('SELECT * FROM sourceFiles WHERE id=?').get(sourceFileId),
    accounts: db.prepare('SELECT * FROM sourceAccounts WHERE sourceFileId=? ORDER BY id').all(sourceFileId),
    transactions: db.prepare('SELECT * FROM sourceTransactions WHERE sourceFileId=? ORDER BY id').all(sourceFileId),
    balances: db.prepare('SELECT * FROM sourceBalances WHERE sourceFileId=? ORDER BY id').all(sourceFileId),
  };
}
const multiset = (rows: unknown[]) => JSON.stringify(rows.map(row => JSON.stringify(row)).sort());

/** Explicit approval only: retains a new source version, never rewrites old hashes or the ledger. */
export async function registerApprovedReplacement(input: {
  sourceFileId: number; expectedAccountId: number; filePath: string;
  approved: true; approvalNote: string;
}, options: { db?: Db; parsers?: AppImportParser[]; backup?: () => unknown } = {}) {
  if (input.approved !== true || !input.approvalNote.trim()) throw new Error('Explicit replacement approval is required.');
  const db = options.db ?? getDb();
  const prior = priorFacts(db, input.sourceFileId);
  if (!prior.file || prior.file.status !== 'committed') throw new Error('Replacement requires a committed source file.');
  if (db.prepare('SELECT 1 FROM importOriginals WHERE importFileId=?').get(prior.file.importFileId)) throw new Error('An original is already retained; do not replace it.');
  if (prior.accounts.length !== 1 || prior.accounts[0]!.accountId !== input.expectedAccountId) throw new Error('Replacement account mapping is not verified.');
  const parser = (options.parsers ?? IMPORT_PARSERS).find(parser => parser.id === prior.file!.parserName);
  if (!parser) throw new Error('Registered parser is unavailable.');
  const bytes = new Uint8Array(await readFile(input.filePath));
  const bytesHash = hashContent(bytes);
  const fileName = basename(input.filePath);
  if (/\.pdf$/i.test(fileName) && new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error('Replacement is not a PDF.');
  const temporary = await mkdtemp(join(tmpdir(), 'easymoney-replacement-'));
  try {
    const filePath = join(temporary, fileName);
    await writeFile(filePath, bytes, { mode: 0o600 });
    const parsed = await parser.parse({ fileName, filePath, fileBytes: bytes, text: new TextDecoder().decode(bytes), headers: [], rows: [] });
    const transactions = parsed.transactions.filter(row => row !== null);
    if (multiset(prior.transactions.map(row => [String(row.date).slice(0, 10), row.amountCents, row.description])) !==
        multiset(transactions.map(row => [row.date.slice(0, 10), row.amountCents, row.description])) ||
        multiset(prior.balances.map(row => [String(row.date).slice(0, 10), row.balanceCents])) !==
        multiset(parsed.balances.map(row => [row.date.slice(0, 10), row.balanceCents]))) {
      throw new Error('Replacement financial facts differ from the approved comparison.');
    }
    if (!transactions.length && !parsed.balances.length) throw new Error('Replacement contains no financial facts.');
    (options.backup ?? (() => createDatabaseBackup('before-approved-replacement')))();
    return db.transaction(() => {
      if (JSON.stringify(priorFacts(db, input.sourceFileId)) !== JSON.stringify(prior)) throw new Error('Source facts or mapping changed during replacement validation.');
      const result = db.prepare(`INSERT OR IGNORE INTO importReplacementVersions
        (sourceFileId, importFileId, priorContentHash, bytesHash, bytes, fileName, parserName, approvedAt, approvalNote, priorFactsJson, candidateFactsJson)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.sourceFileId, prior.file!.importFileId, prior.file!.contentHash, bytesHash, bytes, fileName, parser.id,
          new Date().toISOString(), input.approvalNote, JSON.stringify(prior), JSON.stringify(parsed));
      if (result.changes) db.prepare(`UPDATE parserDerivations SET status='review-required', attemptedRevision=NULL,
        reason='Approved replacement retained; guarded parser refresh pending.' WHERE sourceFileId=?`).run(input.sourceFileId);
      return { registered: result.changes === 1, sourceFileId: input.sourceFileId, transactionCount: transactions.length, balanceCount: parsed.balances.length };
    })();
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
