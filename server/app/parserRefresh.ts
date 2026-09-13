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
import { buildLedgerFromSourceFacts, materializeLedger, LEDGER_REBUILD_POLICY_VERSION } from './ledgerRebuild';
import { captureRefreshConflicts, compareRefreshConflicts, readRefreshDiagnostics, type RefreshDiagnostics } from './parserRefreshDiagnostics';
import type { AppImportParseResult, AppImportParser, ParsedImportTransaction, ParsedImportBalance } from './importTypes';
import { resolveRefreshAccount, type RefreshAccount } from './parserRefreshAccounts';
import { calendarDate } from './importParsers/calendarDate';
import { captureAnnotations, planAnnotationRefresh, applyAnnotationRefresh, readAnnotationHistory } from './parserRefreshAnnotations';

type Db = ReturnType<typeof getDb>;
interface SourceFile { id: number; importFileId: number; fileName: string; contentHash: string; parserName: string; version: string | null; derivationStatus: string | null; attemptedVersion: string | null; attemptedRevision: string | null }
interface Candidate { file: SourceFile; version: string; parser: AppImportParser; parsed: AppImportParseResult }
class ReviewRequired extends Error {}
const trackedTables = ['sourceFiles', 'sourceAccounts', 'sourceTransactions', 'sourceBalances', 'importRows', 'transactionAnnotations', 'ledgerTransactions', 'ledgerBalances', 'accounts', 'parserRefreshAccountChoices', 'reviewedDistinctOverlaps'] as const;

function revision(db: Db) {
  return hashContent(JSON.stringify([
    'original-bound-account-and-annotation-refresh-v1', versions,
    LEDGER_REBUILD_POLICY_VERSION,
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
    WHERE sf.status='committed' AND d.status IN ('review-required','conflict-involved','held') ORDER BY d.sourceFileId`).all() as Array<{
      sourceFileId: number; fileName: string; status: string; reason: string; updatedAt: string;
    }>;
}

function validateCandidate(db: Db, candidate: Candidate) {
  const { file, parsed, parser } = candidate;
  const transactions = parsed.transactions.filter((row): row is ParsedImportTransaction => row !== null);
  if (!transactions.length && !parsed.balances.length) throw new ReviewRequired('Parser produced no facts. Review the original file.');
  const accounts = db.prepare('SELECT * FROM sourceAccounts WHERE sourceFileId=?').all(file.id) as unknown as RefreshAccount[];
  const accountFor = (fact: ParsedImportTransaction | ParsedImportBalance) => {
    const identity = parsedSourceAccountIdentity(fact, parser.institution);
    try { return { ...resolveRefreshAccount(db, file, identity, accounts, !fact.remoteAccountId), identity }; }
    catch { throw new ReviewRequired('Parser account identity changed or has no confirmed mapping.'); }
  };
  for (const fact of [...transactions, ...parsed.balances]) {
    accountFor(fact);
    const amount = 'amountCents' in fact ? fact.amountCents : fact.balanceCents;
    if (!Number.isSafeInteger(amount) || calendarDate(fact.date) !== fact.date) {
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
  const resolvedAccounts = new Map<string, number>();
  for (const fact of [...transactions, ...parsed.balances]) {
    const mapping = accountFor(fact);
    let sourceAccountId = mapping.sourceAccountId ?? resolvedAccounts.get(mapping.identity.remoteAccountId);
    if (!sourceAccountId) {
      const identity = mapping.identity;
      sourceAccountId = Number(db.prepare(`INSERT INTO sourceAccounts
        (sourceFileId,sourceAccountKey,sourceAccountName,institution,accountHolder,accountId,rawJson,createdAt)
        VALUES(?,?,?,?,?,?,?,?)`).run(file.id,identity.remoteAccountId,identity.accountName,identity.institution,
        identity.accountHolder,mapping.accountId,JSON.stringify({ refreshMappingEvidence: mapping.evidence }),now).lastInsertRowid);
      resolvedAccounts.set(identity.remoteAccountId,sourceAccountId);
    }
    const transaction = 'amountCents' in fact;
    const row = db.prepare(`INSERT INTO importRows (importFileId, rowIndex, rowType, rawJson, normalizedJson, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(file.importFileId, transaction ? fact.sourceRowIndex : balanceIndex++, transaction ? 'transaction' : 'balance', JSON.stringify(fact.raw || {}), JSON.stringify(fact), now);
    index++;
    if (transaction) {
      db.prepare(`INSERT INTO sourceTransactions (sourceFileId, sourceAccountId, importRowId, stableSourceId,
        date, amountCents, description, sourceRole, priority, rawJson, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(file.id, sourceAccountId, row.lastInsertRowid, getStableSourceTransactionId(file.importFileId, fact), fact.date,
          fact.amountCents, fact.description, fact.sourceRole, parser.priority, JSON.stringify(fact.raw || {}), now);
    } else {
      db.prepare(`INSERT INTO sourceBalances (sourceFileId, sourceAccountId, importRowId, date, balanceCents, priority, rawJson, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(file.id, sourceAccountId, row.lastInsertRowid, fact.date, fact.balanceCents, parser.priority, JSON.stringify(fact.raw || {}), now);
    }
  }
  const dates = [...transactions, ...parsed.balances].map(fact => fact.date).sort();
  db.prepare(`UPDATE sourceFiles SET coveredFrom=?, coveredTo=?, coverageBasis=?, parserPriority=? WHERE id=?`)
    .run(parsed.coveredFrom || dates[0]!, parsed.coveredTo || dates.at(-1)!, parsed.coveredFrom && parsed.coveredTo ? 'declared' : 'observed', parser.priority, file.id);
  db.prepare('UPDATE importFiles SET rowCount=?, parserPriority=? WHERE id=?').run(index, parser.priority, file.importFileId);
}

export async function refreshParserDerivations(options: {
  db?: Db; parsers?: AppImportParser[]; versions?: Record<string, string>; backup?: () => unknown; retry?: boolean; validateOnly?: boolean; expectedRevision?: string;
} = {}) {
  const db = options.db ?? getDb();
  const parsers = options.parsers ?? IMPORT_PARSERS;
  const currentVersions: Record<string, string> = options.versions ?? versions;
  const files = db.prepare(`SELECT sf.*, d.version, d.status AS derivationStatus, d.attemptedVersion, d.attemptedRevision FROM sourceFiles sf LEFT JOIN parserDerivations d ON d.sourceFileId=sf.id
    WHERE sf.status='committed' ORDER BY sf.id`).all() as unknown as SourceFile[];
  const inputRevision = () => hashContent(JSON.stringify([revision(db), currentVersions]));
  const before = inputRevision();
  if (options.expectedRevision && options.expectedRevision !== before) throw new ReviewRequired('Refresh preview is stale. Preview again before applying.');
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
  let diagnostics: RefreshDiagnostics | undefined;
  try {
    if (inputRevision() !== before) throw new ReviewRequired('Data changed during refresh. Retry using the latest imports and choices.');
    const baselineLedger = buildLedgerFromSourceFacts(db);
    const baseline = captureRefreshConflicts(db, baselineLedger);
    const annotations = captureAnnotations(db, baselineLedger);
    const savedTransactions = db.prepare('SELECT ledgerTransactionId,accountId,date,amountCents / 100.0 AS amount,description FROM ledgerTransactions').all() as NonNullable<RefreshDiagnostics['preview']>['removed'];
    const savedBalances = db.prepare('SELECT * FROM ledgerBalances').all();
    const mappings = candidates.flatMap(candidate => {
      const validated=validateCandidate(db,candidate);
      return [...new Map([...validated.transactions,...candidate.parsed.balances].map(fact=>{
        const mapping=validated.accountFor(fact);
        return [mapping.identity.remoteAccountId,{sourceFileId:candidate.file.id,sourceAccountKey:mapping.identity.remoteAccountId,accountId:mapping.accountId,evidence:mapping.evidence}];
      })).values()];
    });
    if (!options.validateOnly) (options.backup ?? (() => createDatabaseBackup('before-parser-refresh')))();
    db.transaction(() => {
      if (inputRevision() !== before) throw new ReviewRequired('Data changed during refresh. Retry.');
      for (const candidate of candidates) replaceFacts(db, candidate);
      const ledger = buildLedgerFromSourceFacts(db);
      diagnostics = compareRefreshConflicts(baseline, captureRefreshConflicts(db, ledger), before);
      const ids = new Set(ledger.transactions.map(row => row.ledgerTransactionId));
      const oldIds = new Set(savedTransactions.map(row=>row.ledgerTransactionId));
      const savedById = new Map(savedTransactions.map(row=>[row.ledgerTransactionId,row]));
      const oldBalances = new Map(savedBalances.map(row=>[`${row.accountId}:${row.month}`,row]));
      const nextBalances = new Map(ledger.balanceSnapshots.map(row=>[`${row.accountId}:${row.month}`,row]));
      const balanceChanges = [...new Set([...oldBalances.keys(),...nextBalances.keys()])].flatMap(key=>{
        const old=oldBalances.get(key),next=nextBalances.get(key);
        const beforeCents=old?Number(old.balanceCents):null,afterCents=next?Math.round(next.balance*100):null;
        const beforeDate=old?.capturedAt?String(old.capturedAt):null,afterDate=next?.capturedAt ?? null;
        return beforeCents===afterCents && beforeDate===afterDate ? [] : [{accountId:Number(old?.accountId ?? next!.accountId),month:String(old?.month ?? next!.month),beforeCents,afterCents,beforeDate,afterDate}];
      });
      const dispositions = planAnnotationRefresh(db,annotations,ledger);
      diagnostics.preview = { candidateFiles:candidates.length,transactionCountBefore:savedTransactions.length,transactionCountAfter:ledger.transactions.length,
        added:ledger.transactions.filter(row=>!oldIds.has(row.ledgerTransactionId)).map(({ledgerTransactionId,accountId,date,amount,description})=>({ledgerTransactionId,accountId,date,amount,description})),
        removed:savedTransactions.filter(row=>!ids.has(row.ledgerTransactionId)),
        updated:ledger.transactions.flatMap(row=>{const old=savedById.get(row.ledgerTransactionId);return old && (old.date!==row.date || old.description!==row.description) ? [{ledgerTransactionId:row.ledgerTransactionId,before:{date:old.date,description:old.description},after:{date:row.date,description:row.description}}] : [];}),
        annotations:dispositions.filter(row=>row.disposition!=='unchanged'),
        annotationCounts:Object.fromEntries(['unchanged','transferred','retained-history','review-required'].map(kind=>[kind,dispositions.filter(row=>row.disposition===kind).length])) as NonNullable<RefreshDiagnostics['preview']>['annotationCounts'],mappings,
        balancesBefore:savedBalances,balancesAfter:ledger.balanceSnapshots,balanceChanges };
      if (ledger.balanceConflicts?.length || diagnostics.conflicts.some(conflict => conflict.origin === 'new')) throw new ReviewRequired('Parser refresh introduces transaction ambiguity or contains conflicting balances. Review is required.');
      if (dispositions.some(row=>row.disposition==='review-required')) throw new ReviewRequired('An annotated transaction changed identity. Review its category or notes before applying the refresh.');
      if (options.validateOnly) throw new ReviewRequired('Diagnostic run only; validated changes were not applied.');
      applyAnnotationRefresh(db,dispositions,before);
      materializeLedger(db, ledger);
      for (const { file, version } of candidates) {
        report(db, file, version, 'current', null, before);
        db.prepare('UPDATE parserDerivations SET version=? WHERE sourceFileId=?').run(version, file.id);
      }
    })();
    db.prepare('DELETE FROM parserRefreshDiagnostics').run();
    return { refreshed: candidates.length, issues: parserRefreshStatus(db) };
  } catch (error) {
    const reason = error instanceof ReviewRequired ? error.message : 'Refresh validation failed. Previous facts and ledger were retained.';
    // Candidate evidence is saved only after rollback; no temporary fact IDs are
    // exposed as live references and no financial changes escape the transaction.
    db.prepare('DELETE FROM parserRefreshDiagnostics').run();
    if (diagnostics) db.prepare('INSERT INTO parserRefreshDiagnostics VALUES (1, ?)').run(JSON.stringify(diagnostics));
    const involved = new Set(diagnostics?.conflicts.flatMap(c => c.members.map(m => m.sourceFileId)) ?? []);
    for (const { file, version } of candidates) {
      const participant = involved.has(file.id);
      report(db, file, version, participant ? 'conflict-involved' : 'held', participant
        ? 'This file participates in a candidate-ledger conflict; see the conflict evidence.'
        : `Parsed successfully; held because the atomic batch was not applied. ${reason}`, before);
    }
    return { refreshed: 0, issues: parserRefreshStatus(db) };
  }
}

let activeRefresh: Promise<Awaited<ReturnType<typeof refreshParserDerivations>>> | undefined;
let refreshError: string | null = null;
export function parserMaintenanceStatus() {
  return { running: Boolean(activeRefresh), error: refreshError, issues: parserRefreshStatus(), diagnostics: readRefreshDiagnostics(getDb()), annotationHistory:readAnnotationHistory(getDb()) };
}
export function refreshChangedParsers(retry = false, options: { validateOnly?: boolean; expectedRevision?: string } = {}) {
  if (activeRefresh && (options.validateOnly || options.expectedRevision)) throw new ReviewRequired('Parser maintenance is already running. Wait for it to finish.');
  if (!activeRefresh) {
    refreshError = null;
    activeRefresh = recoverImportOriginals().then(() => refreshParserDerivations({ retry, ...options })).catch((error) => {
      refreshError = error instanceof ReviewRequired ? error.message : 'Automatic parser maintenance failed. Your previous ledger remains available; retry from Import.';
      return { refreshed: 0, issues: parserRefreshStatus() };
    }).finally(() => { activeRefresh = undefined; });
  }
  return activeRefresh;
}
