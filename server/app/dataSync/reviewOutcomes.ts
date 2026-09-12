import { Database } from 'bun:sqlite';
import { getDb } from '../../database.ts';
import { buildLedgerFromSourceFacts, isStatementSummary } from '../ledgerRebuild.ts';
import { findCommittedImportArtifactDuplicate, importArtifactFactFingerprint } from '../importArtifactIdentity.ts';
import { validatedSyncAccountMappings } from './review.ts';
import type { SyncAccountMappingDecision, SyncRunReview } from './types.ts';
import { hashContent } from '../../hash.ts';

export interface SyncReviewOutcomes {
  transactions: { parsed: number; new: number; represented: number; ambiguous: number; excludedSummaries: number };
  balances: { parsed: number; new: number; updated: number; unchanged: number; conflicting: number };
  historical: { transactionsAdded: number; transactionsRemoved: number; transactionsChanged: number; balancesChanged: number; ambiguousTransactions: number; conflictingBalances: number };
  revision: string;
  canConfirm: boolean;
  nothingNew: boolean;
}

type AppDatabase = ReturnType<typeof getDb>;

function calendarDate(value: string | null | undefined): string {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value.slice(0, 10) : parsed.toISOString().slice(0, 10);
}

/** A private, disposable source snapshot. Never change statuses/mappings on the live DB. */
export function simulateMappedImportOutcomes(
  db: AppDatabase,
  importFileIds: number[],
  mappings: Map<number, number>,
  newAccounts: Array<{ id: number; type: string }> = [],
): SyncReviewOutcomes {
  const snapshot = new Database(':memory:');
  try {
    const revisionParts: unknown[] = [importFileIds, [...mappings], newAccounts];
    db.transaction(() => {
      for (const table of ['accounts', 'sourceFiles', 'sourceAccounts', 'sourceTransactions', 'sourceBalances', 'importRows', 'ledgerTransactions', 'ledgerBalances']) {
        const schema = db.prepare('SELECT sql FROM sqlite_master WHERE type = \'table\' AND name = ?').get(table);
        if (!schema?.sql) throw new Error('Import outcome source schema is unavailable.');
        snapshot.exec(String(schema.sql));
        const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
        revisionParts.push([table, rows]);
        if (!rows.length) continue;
        const columns = Object.keys(rows[0]!);
        const insert = snapshot.prepare(`INSERT INTO ${table} (${columns.map(column => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        for (const row of rows) insert.run(...columns.map(column => row[column]));
      }
    })();
    // Bun's native database and the application wrapper expose the same query surface.
    const sourceDb = snapshot as unknown as AppDatabase;
    const baseline = buildLedgerFromSourceFacts(sourceDb);
    const persistedTransactions = new Map((snapshot.prepare('SELECT ledgerTransactionId, accountId, date, amountCents, description FROM ledgerTransactions').all() as Array<{ledgerTransactionId:string;accountId:number;date:string;amountCents:number;description:string}>).map(row => [row.ledgerTransactionId,row]));
    const baselineTransactionIds = new Set(baseline.transactions.map(row => row.ledgerTransactionId));
    const historical = {
      transactionsAdded: baseline.transactions.filter(row => !persistedTransactions.has(row.ledgerTransactionId)).length,
      transactionsRemoved: [...persistedTransactions.keys()].filter(id => !baselineTransactionIds.has(id)).length,
      transactionsChanged: baseline.transactions.filter(row => {
        const old = persistedTransactions.get(row.ledgerTransactionId);
        return old && (old.accountId !== row.accountId || calendarDate(old.date) !== calendarDate(row.date) || old.amountCents !== Math.round(row.amount * 100) || (old.description || '') !== row.description);
      }).length,
      balancesChanged: 0,
      ambiguousTransactions: (baseline.ambiguities ?? []).length,
      conflictingBalances: (baseline.balanceConflicts ?? []).length,
    };
    const persistedBalances = new Map((snapshot.prepare('SELECT accountId, month, balanceCents, capturedAt FROM ledgerBalances').all() as Array<{accountId:number;month:string;balanceCents:number;capturedAt:string}>).map(row => [`${row.accountId}|${row.month}`,row]));
    for (const row of baseline.balanceSnapshots) {
      const key = `${row.accountId}|${row.month}`;
      const old = persistedBalances.get(key);
      if (!old || old.balanceCents !== Math.round(row.balance * 100) || calendarDate(old.capturedAt) !== calendarDate(row.capturedAt)) historical.balancesChanged++;
      persistedBalances.delete(key);
    }
    historical.balancesChanged += persistedBalances.size;
    const baselineIds = new Set((baseline.provenance ?? []).map(row => row.sourceTransactionId));
    for (const account of newAccounts) snapshot.prepare('INSERT INTO accounts (id, name, type) VALUES (?, ?, ?)').run(account.id, 'Preview account', account.type);
    for (const [sourceId, accountId] of mappings) snapshot.prepare('UPDATE sourceAccounts SET accountId = ? WHERE id = ?').run(accountId, sourceId);
    const candidateTransactions = new Set<number>();
    const candidateBalanceIds = new Set<number>();
    for (const importFileId of new Set(importFileIds)) {
      const files = snapshot.prepare('SELECT id, status FROM sourceFiles WHERE importFileId = ?').all(importFileId) as Array<{id: number; status: string}>;
      for (const file of files) {
        if (file.status === 'committed') continue;
        if (file.status !== 'previewed') throw new Error('An import is no longer awaiting review.');
        for (const row of snapshot.prepare('SELECT id FROM sourceTransactions WHERE sourceFileId = ?').all(file.id) as Array<{id:number}>) candidateTransactions.add(row.id);
        for (const row of snapshot.prepare('SELECT id FROM sourceBalances WHERE sourceFileId = ?').all(file.id) as Array<{id:number}>) candidateBalanceIds.add(row.id);
        snapshot.prepare("UPDATE sourceFiles SET status = 'committed' WHERE id = ?").run(file.id);
      }
    }
    const combined = buildLedgerFromSourceFacts(sourceDb);
    const ambiguousIds = new Set((combined.ambiguities ?? []).flatMap(row => [row.sourceTransactionId, ...row.candidateSourceTransactionIds]));
    const groups = new Map<string, number[]>();
    for (const row of combined.provenance ?? []) {
      const group = groups.get(row.ledgerTransactionId) ?? [];
      group.push(row.sourceTransactionId);
      groups.set(row.ledgerTransactionId, group);
    }
    const transactions = { parsed: candidateTransactions.size, new: 0, represented: 0, ambiguous: 0, excludedSummaries: (combined.exclusions ?? []).filter(row => candidateTransactions.has(row.sourceTransactionId)).length };
    for (const ids of groups.values()) {
      const incoming = ids.filter(id => candidateTransactions.has(id));
      if (!incoming.length) continue;
      if (ids.some(id => ambiguousIds.has(id))) transactions.ambiguous += incoming.length;
      else if (ids.some(id => baselineIds.has(id))) transactions.represented += incoming.length;
      else { transactions.new += 1; transactions.represented += incoming.length - 1; }
    }
    if (transactions.new + transactions.represented + transactions.ambiguous + transactions.excludedSummaries !== transactions.parsed) {
      throw new Error('Ledger provenance does not account for every staged transaction.');
    }
    const oldBalances = new Map(baseline.balanceSnapshots.map(row => [`${row.accountId}|${row.month}`, row]));
    const conflictingBalanceIds = new Set((combined.balanceConflicts ?? []).flatMap(row => row.sourceBalanceIds).filter(id => candidateBalanceIds.has(id)));
    const balances = { parsed: candidateBalanceIds.size, new: 0, updated: 0, unchanged: 0, conflicting: conflictingBalanceIds.size };
    for (const row of combined.balanceSnapshots) {
      const old = oldBalances.get(`${row.accountId}|${row.month}`);
      if (!old) balances.new += 1;
      else if (old.balance !== row.balance || old.capturedAt !== row.capturedAt) balances.updated += 1;
    }
    balances.unchanged = Math.max(0, balances.parsed - balances.new - balances.updated - balances.conflicting);
    const canConfirm = transactions.ambiguous === 0 && balances.conflicting === 0 && Object.values(historical).every(count => count === 0);
    return { transactions, balances, historical, revision: hashContent(JSON.stringify(revisionParts)), canConfirm, nothingNew: canConfirm && transactions.new === 0 && balances.new === 0 && balances.updated === 0 };
  } finally { snapshot.close(); }
}

function previewSyncReviewOutcomesUnsafe(review: SyncRunReview, requested?: SyncAccountMappingDecision[] | null): SyncReviewOutcomes {
  const plan = validatedSyncAccountMappings(review, requested);
  const skipped = new Set<number>();
  const fingerprints = new Set<string>();
  for (const artifact of review.artifacts) {
    const fingerprint = importArtifactFactFingerprint(artifact.importFileId);
    if (artifact.status === 'already-imported' || findCommittedImportArtifactDuplicate(artifact.importFileId) !== null || (fingerprint !== null && fingerprints.has(fingerprint))) {
      skipped.add(artifact.importFileId);
    }
    if (fingerprint) fingerprints.add(fingerprint);
  }
  const mappings = new Map<number, number>();
  const created = new Map<string, {id:number;type:string}>();
  for (const [fileId, entries] of plan) for (const {remoteAccountId, mapping} of entries) {
    if (skipped.has(fileId)) continue;
    if (mapping.mode === 'create') {
      let account = created.get(remoteAccountId);
      if (!account) { account = { id: -1 - created.size, type: mapping.account.type || 'checking' }; created.set(remoteAccountId, account); }
      mappings.set(mapping.sourceAccountId, account.id);
    } else if (mapping.accountId != null) mappings.set(mapping.sourceAccountId, mapping.accountId);
    else throw new Error('Resolve every source account before calculating ledger changes.');
  }
  const outcome = simulateMappedImportOutcomes(getDb(), review.artifacts.filter(artifact => artifact.status === 'ready' && !skipped.has(artifact.importFileId)).map(artifact => artifact.importFileId), mappings, [...created.values()]);
  for (const artifact of review.artifacts) if (skipped.has(artifact.importFileId)) {
    outcome.transactions.parsed += artifact.transactionCount;
    const excludedCount = (getDb().prepare(`SELECT st.sourceRole, st.rawJson FROM sourceTransactions st JOIN sourceFiles sf ON sf.id = st.sourceFileId WHERE sf.importFileId = ?`).all(artifact.importFileId) as Array<{sourceRole:string|null;rawJson:string|null}>).filter(row => {
      let raw: Record<string, unknown> = {};
      try { raw = JSON.parse(row.rawJson || '{}') as Record<string, unknown>; } catch { /* Same invalid-raw behavior as the ledger builder. */ }
      return isStatementSummary({ sourceRole: row.sourceRole, raw });
    }).length;
    outcome.transactions.excludedSummaries += excludedCount;
    outcome.transactions.represented += artifact.transactionCount - excludedCount;
    outcome.balances.parsed += artifact.balanceCount;
    outcome.balances.unchanged += artifact.balanceCount;
  }
  outcome.revision = hashContent(JSON.stringify([outcome.revision, review, requested]));
  return outcome;
}

export function previewSyncReviewOutcomes(review: SyncRunReview, requested?: SyncAccountMappingDecision[] | null): SyncReviewOutcomes {
  return getDb().transaction(() => previewSyncReviewOutcomesUnsafe(review, requested))();
}

export function assertSyncReviewConfirmation(outcomes: SyncReviewOutcomes, expectedRevision: string): void {
  if (outcomes.revision !== expectedRevision) throw new Error('Import review is stale because source data or account mappings changed. Refresh the review before confirming.');
  if (!outcomes.canConfirm) throw new Error('Import is paused: resolve ambiguous overlaps, conflicting balances, or historical ledger changes before confirming.');
}
