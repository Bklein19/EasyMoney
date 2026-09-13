import Papa from 'papaparse';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { getDb, createDatabaseBackup } from '../database';
import { hashContent } from '../hash';
import { IMPORT_PARSERS } from './importParsers';
import versions from './importParsers/versions.json';
import { recoverImportOriginals } from './originalRecovery';
import { getStableSourceTransactionId, parsedSourceAccountIdentity } from './imports';
import { buildLedgerFromSourceFacts, materializeLedger } from './ledgerRebuild';
import type { AppImportParseResult, AppImportParser, ParsedImportTransaction, ParsedImportBalance } from './importTypes';

type Db = ReturnType<typeof getDb>;
interface SourceFile { id: number; importFileId: number; fileName: string; contentHash: string; parserName: string; version: string | null; derivationStatus: string | null; attemptedVersion: string | null; attemptedRevision: string | null }
interface Candidate { file: SourceFile; version: string; parser: AppImportParser; parsed: AppImportParseResult }
class ReviewRequired extends Error {}
const trackedTables = ['sourceFiles', 'sourceAccounts', 'sourceTransactions', 'sourceBalances', 'importRows', 'transactionAnnotations', 'ledgerTransactions', 'ledgerBalances', 'accounts'] as const;

function revision(db: Db) {
  return hashContent(JSON.stringify([
    ...trackedTables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    db.prepare('SELECT importFileId, contentHash, bytesHash FROM importOriginals ORDER BY importFileId').all(),
    db.prepare('SELECT id, sourceFileId, priorContentHash, bytesHash, approvedAt FROM importReplacementVersions ORDER BY id').all(),
  ]));
}

function report(db: Db, file: SourceFile, version: string | null, status: string, reason: string | null, inputRevision: string) {
  db.prepare(`INSERT INTO parserDerivations (sourceFileId, version, attemptedVersion, attemptedRevision, status, reason, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sourceFileId) DO UPDATE SET
    attemptedVersion=excluded.attemptedVersion, attemptedRevision=excluded.attemptedRevision, status=excluded.status, reason=excluded.reason, updatedAt=excluded.updatedAt`)
    .run(file.id, file.version, version, inputRevision, status, reason, new Date().toISOString());
}

export function parserRefreshStatus(db = getDb()) {
  return db.prepare(`SELECT d.sourceFileId, sf.fileName, d.status, d.reason, d.updatedAt
    FROM parserDerivations d JOIN sourceFiles sf ON sf.id=d.sourceFileId
    WHERE sf.status='committed' AND d.status='review-required' ORDER BY d.sourceFileId`).all() as Array<{
      sourceFileId: number; fileName: string; status: string; reason: string; updatedAt: string;
    }>;
}

function validateCandidate(db: Db, candidate: Candidate) {
  const { file, parsed, parser } = candidate;
  const transactions = parsed.transactions.filter((row): row is ParsedImportTransaction => row !== null);
  if (!transactions.length && !parsed.balances.length) throw new ReviewRequired('Parser produced no facts. Review the original file.');
  const accounts = db.prepare('SELECT * FROM sourceAccounts WHERE sourceFileId=?').all(file.id);
  const accountFor = (fact: ParsedImportTransaction | ParsedImportBalance) => {
    const identity = parsedSourceAccountIdentity(fact, parser.institution);
    const matches = accounts.filter(account => account.institution === identity.institution &&
      (!account.accountHolder || !identity.accountHolder || account.accountHolder === identity.accountHolder) &&
      (account.sourceAccountKey === identity.remoteAccountId || (!fact.remoteAccountId && identity.accountName !== 'Selected account' && account.sourceAccountName === identity.accountName)));
    if (matches.length !== 1 || !matches[0]!.accountId) throw new ReviewRequired('Parser account identity changed or has no confirmed mapping.');
    return Number(matches[0]!.id);
  };
  for (const fact of [...transactions, ...parsed.balances]) {
    accountFor(fact);
    const amount = 'amountCents' in fact ? fact.amountCents : fact.balanceCents;
    if (!Number.isSafeInteger(amount) || !/^\d{4}-\d{2}-\d{2}$/.test(fact.date) || !Number.isFinite(Date.parse(fact.date))) {
      throw new ReviewRequired('Parser produced an invalid date or amount.');
    }
  }
  return { transactions, accounts, accountFor };
}

function replaceFacts(db: Db, candidate: Candidate) {
  const { file, parsed, parser } = candidate;
  const { transactions, accounts, accountFor } = validateCandidate(db, candidate);
  const previous = {
    file: db.prepare('SELECT * FROM sourceFiles WHERE id=?').get(file.id),
    accounts,
    transactions: db.prepare('SELECT * FROM sourceTransactions WHERE sourceFileId=?').all(file.id),
    balances: db.prepare('SELECT * FROM sourceBalances WHERE sourceFileId=?').all(file.id),
    rows: db.prepare('SELECT * FROM importRows WHERE importFileId=?').all(file.importFileId),
  };
  db.prepare('INSERT INTO parserDerivationHistory (sourceFileId, version, factsJson, createdAt) VALUES (?, ?, ?, ?)')
    .run(file.id, file.version, JSON.stringify(previous), new Date().toISOString());
  // All deletes are inside the candidate transaction and have an archived prior
  // derivation. Account identities and confirmed mappings are never replaced.
  db.prepare('DELETE FROM sourceTransactions WHERE sourceFileId=?').run(file.id);
  db.prepare('DELETE FROM sourceBalances WHERE sourceFileId=?').run(file.id);
  db.prepare('DELETE FROM importRows WHERE importFileId=?').run(file.importFileId);
  const now = new Date().toISOString();
  let index = 0;
  let balanceIndex = parsed.transactions.length;
  for (const fact of [...transactions, ...parsed.balances]) {
    const transaction = 'amountCents' in fact;
    const row = db.prepare(`INSERT INTO importRows (importFileId, rowIndex, rowType, rawJson, normalizedJson, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(file.importFileId, transaction ? fact.sourceRowIndex : balanceIndex++, transaction ? 'transaction' : 'balance', JSON.stringify(fact.raw || {}), JSON.stringify(fact), now);
    index++;
    if (transaction) {
      db.prepare(`INSERT INTO sourceTransactions (sourceFileId, sourceAccountId, importRowId, stableSourceId,
        date, amountCents, description, sourceRole, priority, rawJson, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(file.id, accountFor(fact), row.lastInsertRowid, getStableSourceTransactionId(file.importFileId, fact), fact.date,
          fact.amountCents, fact.description, fact.sourceRole, parser.priority, JSON.stringify(fact.raw || {}), now);
    } else {
      db.prepare(`INSERT INTO sourceBalances (sourceFileId, sourceAccountId, importRowId, date, balanceCents, priority, rawJson, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(file.id, accountFor(fact), row.lastInsertRowid, fact.date, fact.balanceCents, parser.priority, JSON.stringify(fact.raw || {}), now);
    }
  }
  const dates = [...transactions, ...parsed.balances].map(fact => fact.date).sort();
  db.prepare(`UPDATE sourceFiles SET coveredFrom=?, coveredTo=?, coverageBasis=?, parserPriority=? WHERE id=?`)
    .run(parsed.coveredFrom || dates[0]!, parsed.coveredTo || dates.at(-1)!, parsed.coveredFrom && parsed.coveredTo ? 'declared' : 'observed', parser.priority, file.id);
  db.prepare('UPDATE importFiles SET rowCount=?, parserPriority=? WHERE id=?').run(index, parser.priority, file.importFileId);
}

export async function refreshParserDerivations(options: {
  db?: Db; parsers?: AppImportParser[]; versions?: Record<string, string>; backup?: () => unknown; retry?: boolean;
} = {}) {
  const db = options.db ?? getDb();
  const parsers = options.parsers ?? IMPORT_PARSERS;
  const currentVersions: Record<string, string> = options.versions ?? versions;
  const files = db.prepare(`SELECT sf.*, d.version, d.status AS derivationStatus, d.attemptedVersion, d.attemptedRevision FROM sourceFiles sf LEFT JOIN parserDerivations d ON d.sourceFileId=sf.id
    WHERE sf.status='committed' ORDER BY sf.id`).all() as unknown as SourceFile[];
  const before = revision(db);
  const candidates: Candidate[] = [];
  for (const file of files) {
    const version = currentVersions[file.parserName];
    if (version && file.version === version && file.derivationStatus === 'current') continue;
    if (!options.retry && (version ?? null) === file.attemptedVersion && file.attemptedRevision === before) continue;
    const parser = parsers.find(parser => parser.id === file.parserName);
    if (!parser || !version) {
      report(db, file, null, 'review-required', 'This parser requires a supported versioned implementation before automatic refresh.', before);
      continue;
    }
    const retained = db.prepare('SELECT bytes, bytesHash FROM importOriginals WHERE importFileId=?').get(file.importFileId) as { bytes: Uint8Array; bytesHash: string } | undefined;
    const replacement = retained ? undefined : db.prepare(`SELECT bytes, bytesHash, fileName FROM importReplacementVersions
      WHERE sourceFileId=? AND importFileId=? AND priorContentHash=? ORDER BY id DESC LIMIT 1`)
      .get(file.id, file.importFileId, file.contentHash) as { bytes: Uint8Array; bytesHash: string; fileName: string } | undefined;
    const original = retained ?? replacement;
    if (!original) {
      report(db, file, version, 'review-required', 'Original file is not retained. Upload the original again to enable refresh.', before);
      continue;
    }
    if (hashContent(original.bytes) !== original.bytesHash || (!replacement && original.bytesHash !== file.contentHash && hashContent(new TextDecoder().decode(original.bytes)) !== file.contentHash)) {
      report(db, file, version, 'review-required', 'Original file integrity check failed.', before);
      continue;
    }
    const directory = await mkdtemp(join(tmpdir(), 'easymoney-parser-'));
    try {
      const fileName = basename(replacement?.fileName ?? file.fileName).replace(/^[a-f0-9]{64}-/, '');
      const filePath = join(directory, fileName);
      await writeFile(filePath, original.bytes, { mode: 0o600 });
      const text = new TextDecoder().decode(original.bytes);
      const csv = /\.csv$/i.test(fileName) ? Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true }) : null;
      const parsed = await parser.parse({ fileName, filePath, fileBytes: original.bytes, text, headers: csv?.meta.fields ?? [], rows: csv?.data ?? [] });
      const candidate = { file, version, parser, parsed };
      validateCandidate(db, candidate);
      candidates.push(candidate);
    } catch (error) {
      // Parser errors can contain private source text. Persist actionable categories only.
      report(db, file, version, 'review-required', error instanceof ReviewRequired ? error.message : 'Reparsing failed. Previous facts and ledger were retained.', before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (!candidates.length) return { refreshed: 0, issues: parserRefreshStatus(db) };
  try {
    if (revision(db) !== before) throw new ReviewRequired('Data changed during refresh. Retry using the latest imports and choices.');
    (options.backup ?? (() => createDatabaseBackup('before-parser-refresh')))();
    db.transaction(() => {
      if (revision(db) !== before) throw new ReviewRequired('Data changed during refresh. Retry.');
      for (const candidate of candidates) replaceFacts(db, candidate);
      const ledger = buildLedgerFromSourceFacts(db);
      if (ledger.ambiguities?.length || ledger.balanceConflicts?.length) throw new ReviewRequired('Candidate ledger has ambiguous transactions or conflicting balances. Review is required.');
      const ids = new Set(ledger.transactions.map(row => row.ledgerTransactionId));
      // Never attach annotations by amount or ordinal alone. Exact stable identity
      // transfers automatically; changed annotated identities require human review.
      const stranded = db.prepare(`SELECT a.ledgerTransactionId FROM transactionAnnotations a
        JOIN ledgerTransactions t ON t.ledgerTransactionId=a.ledgerTransactionId`).all()
        .some(row => !ids.has(row.ledgerTransactionId));
      if (stranded) throw new ReviewRequired('An annotated transaction changed identity. Review its category or notes before applying the refresh.');
      materializeLedger(db, ledger);
      for (const { file, version } of candidates) {
        report(db, file, version, 'current', null, before);
        db.prepare('UPDATE parserDerivations SET version=? WHERE sourceFileId=?').run(version, file.id);
      }
    })();
    return { refreshed: candidates.length, issues: parserRefreshStatus(db) };
  } catch (error) {
    const reason = error instanceof ReviewRequired ? error.message : 'Refresh validation failed. Previous facts and ledger were retained.';
    for (const { file, version } of candidates) report(db, file, version, 'review-required', reason, before);
    return { refreshed: 0, issues: parserRefreshStatus(db) };
  }
}

let activeRefresh: Promise<Awaited<ReturnType<typeof refreshParserDerivations>>> | undefined;
let refreshError: string | null = null;
export function parserMaintenanceStatus() {
  return { running: Boolean(activeRefresh), error: refreshError, issues: parserRefreshStatus() };
}
export function refreshChangedParsers(retry = false) {
  if (!activeRefresh) {
    refreshError = null;
    activeRefresh = recoverImportOriginals().then(() => refreshParserDerivations({ retry })).catch(() => {
      refreshError = 'Automatic parser maintenance failed. Your previous ledger remains available; retry from Import.';
      return { refreshed: 0, issues: parserRefreshStatus() };
    }).finally(() => { activeRefresh = undefined; });
  }
  return activeRefresh;
}
