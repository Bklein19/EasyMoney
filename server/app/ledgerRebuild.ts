import { getDb } from '../database.ts';
import { hashContent } from '../hash.ts';
import { readSecurityTrade, securityTradeKey } from './securityTrade';
import {
  assignLedgerTransactionIdentities,
  getLedgerTransactionBaseKey,
  getTransactionOccurrenceSortKey,
} from './transactionIdentity.ts';

export const LEDGER_REBUILD_POLICY_VERSION = 'structured-security-trades-v3';

interface SourceTransactionRow {
  id: number;
  sourceFileId: number;
  sourceAccountId: number;
  importRowId: number | null;
  stableSourceId: string;
  date: string;
  amountCents: number;
  description: string | null;
  sourceRole: string | null;
  priority: number | null;
  sourceType: string | null;
  rawJson: string | null;
  accountId: number;
  accountType: string | null;
  importFileId: number | null;
  sourceRowIndex: number | null;
}

interface SourceBalanceRow {
  id: number;
  sourceFileId: number;
  sourceAccountId: number;
  importRowId: number | null;
  date: string;
  balanceCents: number;
  priority: number | null;
  sourceType: string | null;
  rawJson: string | null;
  accountId: number;
}

export interface RebuiltTransaction {
  ledgerTransactionId: string;
  occurrenceIndex: number;
  accountId: number;
  date: string;
  amount: number;
  importBatchId: string;
  description: string;
  merchant: string;
  originalDescription: string;
  originalCategory: string | null;
  type: string;
  transactionKind: string | null;
  status: string;
  sourceRole: string;
  fingerprint: string;
  importRowId: number | null;
}

export interface RebuiltBalanceSnapshot {
  accountId: number;
  month: string;
  balance: number;
  capturedAt: string;
  sourceBalanceId: number;
}

export interface RebuiltLedger {
  transactions: RebuiltTransaction[];
  balanceSnapshots: RebuiltBalanceSnapshot[];
  provenance?: Array<{ ledgerTransactionId: string; sourceTransactionId: number; reason: string; selected: boolean }>;
  ambiguities?: Array<{ sourceTransactionId: number; candidateSourceTransactionIds: number[]; reason: string }>;
  exclusions?: Array<{ sourceTransactionId: number; reason: string }>;
  balanceConflicts?: Array<{ accountId: number; month: string; date: string; sourceBalanceIds: number[]; balanceCents: number[]; reason: string }>;
}

function normalizeText(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDate(value = '') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function normalizeAmount(value: unknown) {
  return Number(value || 0).toFixed(2);
}

function dollarsFromCents(value: number) {
  return Math.round(value) / 100;
}

function dateDistanceInDays(left: string, right: string) {
  const leftTime = Date.parse(`${normalizeDate(left)}T00:00:00.000Z`);
  const rightTime = Date.parse(`${normalizeDate(right)}T00:00:00.000Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return Number.POSITIVE_INFINITY;
  return Math.abs(leftTime - rightTime) / 86_400_000;
}

function isCreditAccount(accountType: string | null | undefined) {
  return accountType === 'credit' || accountType === 'credit_card' || accountType === 'credit-card';
}

function getBalanceSourceRank(sourceType: string | null | undefined) {
  return sourceType === 'statement' ? 2 : 1;
}

function getTransactionSourceScore(transaction: { sourceType?: string | null; priority?: number | null }) {
  const sourceRank = transaction.sourceType === 'activity-export' ? 2 : 1;
  return sourceRank * 1_000_000 + (transaction.priority ?? 0);
}

function compareSourceBalances(a: SourceBalanceRow, b: SourceBalanceRow) {
  const sourceRankDelta = getBalanceSourceRank(a.sourceType) - getBalanceSourceRank(b.sourceType);
  if (sourceRankDelta !== 0) return sourceRankDelta;

  const priorityDelta = (a.priority ?? 0) - (b.priority ?? 0);
  if (priorityDelta !== 0) return priorityDelta;

  return normalizeDate(a.date).localeCompare(normalizeDate(b.date));
}

function parseRaw(rawJson: string | null) {
  if (!rawJson) return {};
  try {
    return JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getTransactionFingerprint(transaction: {
  accountId: number;
  date: string;
  amount: number;
  originalDescription?: string | null;
  description?: string | null;
  merchant?: string | null;
}) {
  const text = normalizeText(
    transaction.originalDescription ||
    transaction.description ||
    transaction.merchant ||
    ''
  );
  return [
    transaction.accountId,
    normalizeDate(transaction.date),
    normalizeAmount(transaction.amount),
    text,
  ].join('|');
}

function getMaterializedImportBatchId(fingerprint: string) {
  return `import-row-${hashContent(fingerprint).slice(0, 16)}`;
}

export function isStatementSummary(transaction: {
  sourceRole?: string | null;
  raw: Record<string, unknown>;
}) {
  return transaction.sourceRole === 'statement-summary' ||
    transaction.raw.type === 'statement-cash-flow-summary' ||
    ['tiaa-statement-summary', '401k-statement-summary', 'fidelity-netbenefits-statement-summary'].includes(String(transaction.raw.source || '')) ||
    (transaction.raw.source === 'fidelity-portfolio-statement' && transaction.raw.type === 'securities-transferred-out');
}

export function buildLedgerFromSourceFacts(db = getDb()): RebuiltLedger {
  const decisions = new Map<number, { representative: number; reason: string }>();
  const sourceTransactions = db.prepare(`
    SELECT
      st.id,
      st.sourceFileId,
      st.sourceAccountId,
      st.importRowId,
      st.stableSourceId,
      st.date,
      st.amountCents,
      st.description,
      st.sourceRole,
      st.priority,
      sf.sourceType,
      st.rawJson,
      sa.accountId,
      a.type AS accountType,
      sf.importFileId,
      ir.rowIndex AS sourceRowIndex
    FROM sourceTransactions st
    JOIN sourceFiles sf ON sf.id = st.sourceFileId
    JOIN sourceAccounts sa ON sa.id = st.sourceAccountId
    JOIN accounts a ON a.id = sa.accountId
    LEFT JOIN importRows ir ON ir.id = st.importRowId
    WHERE sf.status = 'committed'
      AND sa.accountId IS NOT NULL
    ORDER BY st.sourceFileId ASC, st.id ASC
  `).all() as SourceTransactionRow[];

  const transactionInputs = sourceTransactions.map(row => {
    const raw = parseRaw(row.rawJson);
    const securityTrade = readSecurityTrade(raw.securityTrade);
    const date = securityTrade?.tradeDate ?? row.date;
    const amount = dollarsFromCents(row.amountCents);
    const description = row.description || '';
    const merchant = typeof raw.merchant === 'string' ? raw.merchant : description;
    const originalDescription = typeof raw.originalDescription === 'string' ? raw.originalDescription : description;
    const originalCategory = typeof raw.originalCategory === 'string' && raw.originalCategory.trim()
      ? raw.originalCategory
      : typeof raw.category === 'string' && raw.category.trim()
        ? raw.category
        : null;
    const rawKind = typeof raw.transactionKind === 'string' ? raw.transactionKind : null;
    const transactionKind = isCreditAccount(row.accountType) && amount > 0
      ? 'card_payment'
      : rawKind;
    const fingerprint = getTransactionFingerprint({
      accountId: row.accountId,
      date,
      amount,
      originalDescription,
      description,
      merchant,
    });

    return {
      ...row,
      date,
      securityTrade,
      accountId: row.accountId,
      amount,
      description,
      merchant,
      originalDescription,
      originalCategory,
      raw,
      type: amount >= 0 ? 'credit' : 'debit',
      transactionKind,
      status: typeof raw.status === 'string' ? raw.status : 'cleared',
      sourceRole: row.sourceRole || 'activity',
      fingerprint,
      importBatchId: getMaterializedImportBatchId(fingerprint),
    };
  });

  const sourceIdentityKey = (transaction: {
    accountId: number;
    sourceType: string | null;
    raw: Record<string, unknown>;
    stableSourceId: string;
  }) => `${transaction.accountId}\0${transaction.sourceType}\0${typeof transaction.raw.moneyId === 'string'
    ? `money:${transaction.raw.moneyId}`
    : `source:${transaction.stableSourceId}`}`;
  const exclusions: NonNullable<RebuiltLedger['exclusions']> = transactionInputs.filter(isStatementSummary).map(row => ({
    sourceTransactionId: row.id,
    reason: 'Statement aggregate summary excluded: a monthly total is not an individual transaction. The source fact is preserved.',
  }));
  // Count occurrences in ORIGINAL documents before reconciling parser IDs.
  // Otherwise shared IDs can redistribute rows across files and shrink maxima.
  const dedupedTransactionInputs = transactionInputs.filter(row => !isStatementSummary(row));

  const activityExportGroups = new Map<string, typeof dedupedTransactionInputs>();
  const retainedTransactionInputs = new Set(dedupedTransactionInputs);
  const economicKey = (row: typeof dedupedTransactionInputs[number]) => JSON.stringify([
    row.accountId, normalizeDate(row.date), row.amountCents,
    row.securityTrade ? securityTradeKey(row.securityTrade) : null,
  ]);
  const reconciledEconomicKeys = new Set<string>();
  reconcileEconomicDocuments();
  for (const transaction of retainedTransactionInputs) {
    if (!['activity-export', 'statement'].includes(transaction.sourceType || '')) continue;
    if (reconciledEconomicKeys.has(economicKey(transaction))) continue;
    const key = `${transaction.sourceType}\0${transaction.securityTrade ? economicKey(transaction) : getLedgerTransactionBaseKey(transaction)}`;
    const group = activityExportGroups.get(key);
    if (group) {
      group.push(transaction);
    } else {
      activityExportGroups.set(key, [transaction]);
    }
  }

  for (const group of activityExportGroups.values()) {
    const bySourceFile = new Map<number, typeof group>();
    for (const transaction of group) {
      const sourceGroup = bySourceFile.get(transaction.sourceFileId);
      if (sourceGroup) {
        sourceGroup.push(transaction);
      } else {
        bySourceFile.set(transaction.sourceFileId, [transaction]);
      }
    }
    if (bySourceFile.size <= 1) continue;

    const representative = [...bySourceFile.entries()]
      .sort(([sourceFileIdA, rowsA], [sourceFileIdB, rowsB]) =>
        rowsB.length - rowsA.length ||
        sourceFileIdA - sourceFileIdB
      )[0]?.[1] ?? [];
    const selected = new Set(
      representative
        .sort((a, b) => getTransactionOccurrenceSortKey(a).localeCompare(getTransactionOccurrenceSortKey(b)))
    );

    for (const transaction of group) {
      if (!selected.has(transaction)) {
        const siblings = [...(bySourceFile.get(transaction.sourceFileId) ?? [])].sort((a, b) => getTransactionOccurrenceSortKey(a).localeCompare(getTransactionOccurrenceSortKey(b)));
        const representativeRow = [...selected][siblings.indexOf(transaction)];
        if (representativeRow) decisions.set(transaction.id, { representative: representativeRow.id, reason: 'Overlapping documents of the same source type; identical transactions matched by occurrence within the file. The largest file occurrence count is retained.' });
        retainedTransactionInputs.delete(transaction);
      }
    }
  }

  // Legacy parser moneyIds can be hashes, not authoritative bank IDs. They
  // must never collapse multiple occurrences retained from the same document.
  const sourceIdentityGroups = new Map<string, Map<number, typeof transactionInputs>>();
  for (const transaction of [...retainedTransactionInputs].sort((a, b) =>
    getTransactionOccurrenceSortKey(a).localeCompare(getTransactionOccurrenceSortKey(b)))) {
    // Document activity already has occurrence-aware matching above. A parser
    // hash cannot establish equality for otherwise different descriptions.
    if (['activity-export', 'statement'].includes(transaction.sourceType || '')) continue;
    const identity = sourceIdentityKey(transaction);
    const files = sourceIdentityGroups.get(identity) ?? new Map<number, typeof transactionInputs>();
    sourceIdentityGroups.set(identity, files);
    const rows = files.get(transaction.sourceFileId) ?? [];
    files.set(transaction.sourceFileId, rows);
    rows.push(transaction);
  }
  for (const files of sourceIdentityGroups.values()) {
    const ordered = [...files.values()].sort((a, b) =>
      b.length - a.length || (b[0]!.priority ?? 0) - (a[0]!.priority ?? 0) || a[0]!.sourceFileId - b[0]!.sourceFileId);
    const representative = ordered[0]!;
    for (const rows of ordered.slice(1)) {
      rows.forEach((row, index) => {
        decisions.set(row.id, { representative: representative[index]!.id, reason: 'Same parser source identity matched by file occurrence; largest occurrence count retained.' });
        retainedTransactionInputs.delete(row);
      });
    }
  }

  // Same-account/date/amount is the cross-format fallback policy. Descriptions
  // often differ between an export and a statement. Match document occurrences
  // one-to-one, never collapse two rows from the same original document.
  function reconcileEconomicDocuments() {
    const economicGroups = new Map<string, typeof dedupedTransactionInputs>();
    for (const row of retainedTransactionInputs) {
      if (row.sourceRole !== 'activity' || !['activity-export', 'statement'].includes(row.sourceType || '')) continue;
      const key = economicKey(row);
      const group = economicGroups.get(key) ?? [];
      group.push(row); economicGroups.set(key, group);
    }
    for (const group of economicGroups.values()) {
      if (new Set(group.map(row => row.sourceType)).size < 2) continue;
      reconciledEconomicKeys.add(economicKey(group[0]!));
      const files = new Map<number, typeof group>();
      for (const row of group) {
        const rows = files.get(row.sourceFileId) ?? [];
        rows.push(row); files.set(row.sourceFileId, rows);
      }
      const ordered = [...files.values()].sort((a, b) =>
        Math.max(...b.map(getTransactionSourceScore)) - Math.max(...a.map(getTransactionSourceScore)) ||
        b.length - a.length || a[0]!.sourceFileId - b[0]!.sourceFileId);
      const canonical: typeof group = [];
      for (const rows of ordered) {
        const used = new Set<number>();
        for (const row of [...rows].sort((a,b) => getTransactionOccurrenceSortKey(a).localeCompare(getTransactionOccurrenceSortKey(b)))) {
          const available = canonical.filter(candidate => !used.has(candidate.id));
          const match = available.find(candidate => normalizeText(candidate.originalDescription || candidate.description) === normalizeText(row.originalDescription || row.description)) ?? available[0];
          if (match) {
            used.add(match.id);
          decisions.set(row.id, { representative: match.id, reason: row.securityTrade
            ? 'Same account, amount, security, quantity, action, trade date and settlement date; matched one-to-one by document occurrence.'
            : 'Same account, date and amount across statement/export documents; matched one-to-one by document occurrence, with higher-priority source wording retained.' });
            retainedTransactionInputs.delete(row);
          } else {
            canonical.push(row);
            used.add(row.id);
          }
        }
      }
    }
  }

  const crossSourceGroups = new Map<string, typeof dedupedTransactionInputs>();
  for (const transaction of retainedTransactionInputs) {
    if (
      transaction.sourceRole !== 'activity' ||
      !['activity-export', 'statement'].includes(transaction.sourceType || '')
    ) continue;
    // These rows already used their same-day document occurrence budget.
    // A second fuzzy-date pass must not consume an excess real occurrence.
    if (reconciledEconomicKeys.has(economicKey(transaction))) continue;
    // Explicit trade evidence must not fall back to generic description/date
    // matching and accidentally reconcile a different security or quantity.
    if (transaction.securityTrade) continue;
    const crossSourceIdentity = typeof transaction.raw.crossSourceIdentity === 'string'
      ? transaction.raw.crossSourceIdentity.trim()
      : '';
    const descriptionIdentity = normalizeText(
      transaction.originalDescription || transaction.description || transaction.merchant,
    );
    if (!crossSourceIdentity && !descriptionIdentity) continue;
    const key = [
      transaction.accountId,
      transaction.amountCents,
      crossSourceIdentity ? `parser:${crossSourceIdentity}` : `description:${descriptionIdentity}`,
    ].join('\0');
    const group = crossSourceGroups.get(key);
    if (group) {
      group.push(transaction);
    } else {
      crossSourceGroups.set(key, [transaction]);
    }
  }

  for (const group of crossSourceGroups.values()) {
    const bySourceFile = new Map<number, typeof group>();
    for (const transaction of group) {
      const sourceGroup = bySourceFile.get(transaction.sourceFileId);
      if (sourceGroup) {
        sourceGroup.push(transaction);
      } else {
        bySourceFile.set(transaction.sourceFileId, [transaction]);
      }
    }
    if (bySourceFile.size <= 1) continue;

    const orderedSourceGroups = [...bySourceFile.entries()].sort(([sourceFileIdA, rowsA], [sourceFileIdB, rowsB]) =>
      Math.max(...rowsB.map(getTransactionSourceScore)) - Math.max(...rowsA.map(getTransactionSourceScore)) ||
      rowsB.length - rowsA.length ||
      sourceFileIdA - sourceFileIdB
    );
    const canonical: typeof group = [];

    for (const [, rows] of orderedSourceGroups) {
      const matchedCanonical = new Set<number>();
      for (const transaction of [...rows].sort((a, b) =>
        normalizeDate(a.date).localeCompare(normalizeDate(b.date)) ||
        getTransactionOccurrenceSortKey(a).localeCompare(getTransactionOccurrenceSortKey(b))
      )) {
        const matches = canonical
          .map((candidate, index) => ({ candidate, index, distance: dateDistanceInDays(candidate.date, transaction.date) }))
          .filter(({ candidate, index, distance }) =>
            candidate.sourceType !== transaction.sourceType &&
            !matchedCanonical.has(index) &&
            distance > 0 &&
            distance <= 3
          )
          .sort((a, b) =>
            a.distance - b.distance ||
            getTransactionOccurrenceSortKey(a.candidate).localeCompare(getTransactionOccurrenceSortKey(b.candidate))
          );
        // Repeated occurrences on one date are interchangeable, but rows on
        // different dates are not. Do not guess which posting date is intended.
        const nearest = matches.filter(item => item.distance === matches[0]?.distance);
        const match = new Set(nearest.map(item => normalizeDate(item.candidate.date))).size === 1
          ? nearest[0] : undefined;

        if (match) {
          decisions.set(transaction.id, { representative: match.candidate.id, reason: 'Activity and statement occurrence matched by account, amount, description or parser identity, within three posting days.' });
          matchedCanonical.add(match.index);
          retainedTransactionInputs.delete(transaction);
        } else {
          canonical.push(transaction);
        }
      }
    }
  }

  const ambiguities: NonNullable<RebuiltLedger['ambiguities']> = [];
  const amountGroups = new Map<string, typeof transactionInputs>();
  for (const row of retainedTransactionInputs) {
    if (row.sourceRole !== 'activity' || !['activity-export', 'statement'].includes(row.sourceType || '')) continue;
    const key = `${row.accountId}\0${row.amountCents}`;
    const group = amountGroups.get(key) ?? [];
    group.push(row);
    amountGroups.set(key, group);
  }
  for (const group of amountGroups.values()) {
    for (const row of group) {
      const candidates = group.filter(candidate => {
        if (candidate.sourceType === row.sourceType || dateDistanceInDays(candidate.date, row.date) > 3) return false;
        if (row.securityTrade && candidate.securityTrade && securityTradeKey(row.securityTrade) !== securityTradeKey(candidate.securityTrade)) return false;
        // Same-day leftovers are excess real occurrences under the document
        // policy above, not additional unresolved pairs.
        return normalizeDate(row.date) !== normalizeDate(candidate.date) || Boolean(row.securityTrade) !== Boolean(candidate.securityTrade);
      });
      if (candidates.length) ambiguities.push({
        sourceTransactionId: row.id,
        candidateSourceTransactionIds: candidates.map(candidate => candidate.id).sort((a, b) => a - b),
        reason: 'Possible cross-source overlap by account, amount and posting date; identity or occurrence evidence is insufficient. Both rows retained.',
      });
    }
  }

  const assigned = assignLedgerTransactionIdentities([...retainedTransactionInputs]);
  const ledgerIdsBySource = new Map(assigned.map(item => [item.transaction.id, item.ledgerTransactionId]));
  const provenance: NonNullable<RebuiltLedger['provenance']> = [];
  for (const row of sourceTransactions) {
    let representative = row.id;
    const visited = new Set<number>();
    const reasons: string[] = [];
    while (decisions.has(representative) && !visited.has(representative)) {
      visited.add(representative);
      const decision = decisions.get(representative)!;
      reasons.push(decision.reason);
      representative = decision.representative;
    }
    const ledgerTransactionId = ledgerIdsBySource.get(representative);
    if (ledgerTransactionId) provenance.push({ ledgerTransactionId, sourceTransactionId: row.id, selected: row.id === representative,
      reason: reasons.join(' ') || 'Source occurrence retained in the ledger.' });
  }
  const transactions = assigned.map((item) => ({
    ledgerTransactionId: item.ledgerTransactionId,
    occurrenceIndex: item.occurrenceIndex,
    accountId: item.transaction.accountId,
    date: normalizeDate(item.transaction.date),
    amount: item.transaction.amount,
    importBatchId: item.transaction.importBatchId,
    description: item.transaction.description,
    merchant: item.transaction.merchant,
    originalDescription: item.transaction.originalDescription,
    originalCategory: item.transaction.originalCategory,
    type: item.transaction.type,
    transactionKind: item.transaction.transactionKind,
    status: item.transaction.status,
    sourceRole: item.transaction.sourceRole,
    fingerprint: item.transaction.fingerprint,
    importRowId: item.transaction.importRowId,
  })).sort((a, b) => a.ledgerTransactionId.localeCompare(b.ledgerTransactionId));

  const sourceBalances = db.prepare(`
    SELECT
      sb.id,
      sb.sourceFileId,
      sb.sourceAccountId,
      sb.importRowId,
      sb.date,
      sb.balanceCents,
      sb.priority,
      sf.sourceType,
      sb.rawJson,
      sa.accountId
    FROM sourceBalances sb
    JOIN sourceFiles sf ON sf.id = sb.sourceFileId
    JOIN sourceAccounts sa ON sa.id = sb.sourceAccountId
    WHERE sf.status = 'committed'
      AND sa.accountId IS NOT NULL
    ORDER BY sb.date ASC, sb.id ASC
  `).all() as SourceBalanceRow[];
  const balancesByAccountMonth = new Map<string, RebuiltBalanceSnapshot>();
  const sourceBalanceByAccountMonth = new Map<string, SourceBalanceRow[]>();
  const balanceConflicts: NonNullable<RebuiltLedger['balanceConflicts']> = [];
  for (const balance of sourceBalances) {
    const month = normalizeDate(balance.date).slice(0, 7);
    const key = `${balance.accountId}|${month}`;
    const existing = sourceBalanceByAccountMonth.get(key);
    const comparison = existing ? compareSourceBalances(balance, existing[0]!) : 1;
    if (comparison < 0) continue;
    sourceBalanceByAccountMonth.set(key, comparison === 0 ? [...existing!, balance] : [balance]);
  }
  for (const [key, candidates] of sourceBalanceByAccountMonth) {
    const balance = [...candidates].sort((a, b) => a.id - b.id)[0]!;
    const month = normalizeDate(balance.date).slice(0, 7);
    if (new Set(candidates.map(row => row.balanceCents)).size > 1) {
      balanceConflicts.push({
        accountId: balance.accountId, month, date: normalizeDate(balance.date),
        sourceBalanceIds: candidates.map(row => row.id).sort((a, b) => a - b),
        balanceCents: [...new Set(candidates.map(row => row.balanceCents))].sort((a, b) => a - b),
        reason: 'Equally authoritative balances on the same date disagree. No monthly balance is selected until resolved.',
      });
      continue;
    }
    balancesByAccountMonth.set(key, {
      accountId: balance.accountId,
      month,
      balance: dollarsFromCents(balance.balanceCents),
      capturedAt: `${normalizeDate(balance.date)}T00:00:00.000Z`,
      sourceBalanceId: balance.id,
    });
  }

  return {
    transactions,
    provenance,
    ambiguities,
    exclusions,
    balanceConflicts: balanceConflicts.sort((a, b) => a.accountId - b.accountId || a.month.localeCompare(b.month)),
    balanceSnapshots: [...balancesByAccountMonth.values()].sort((a, b) =>
      `${a.accountId}|${a.month}`.localeCompare(`${b.accountId}|${b.month}`)
    ),
  };
}

export function ledgerFingerprint(ledger: RebuiltLedger) {
  return hashContent(JSON.stringify({
    transactions: ledger.transactions,
    balanceSnapshots: ledger.balanceSnapshots,
  }));
}

export function materializeLedger(db = getDb(), ledger = buildLedgerFromSourceFacts(db)) {
  if (ledger.balanceConflicts?.length) {
    throw new Error('Ledger contains conflicting same-date balances; resolve conflicts before materializing.');
  }
  db.transaction(() => {
    db.prepare('DELETE FROM ledgerProvenance').run();
    db.prepare('DELETE FROM ledgerTransactions').run();
    db.prepare('DELETE FROM ledgerBalances').run();
    db.prepare('DELETE FROM transactions').run();
    db.prepare('DELETE FROM balanceSnapshots').run();

    const insertTransaction = db.prepare(`
      INSERT INTO transactions (
        accountId,
        categoryId,
        date,
        amount,
        importBatchId,
        description,
        merchant,
        originalDescription,
        originalCategory,
        type,
        transactionKind,
        status,
        notes,
        fingerprint,
        ledgerTransactionId,
        occurrenceIndex,
        createdAt
      ) VALUES (
        @accountId,
        NULL,
        @date,
        @amount,
        @importBatchId,
        @description,
        @merchant,
        @originalDescription,
        @originalCategory,
        @type,
        @transactionKind,
        @status,
        NULL,
        @fingerprint,
        @ledgerTransactionId,
        @occurrenceIndex,
        @createdAt
      )
    `);
    const updateImportRow = db.prepare(`
      UPDATE importRows
      SET transactionId = @transactionId, fingerprint = @fingerprint
      WHERE id = @importRowId
    `);
    const insertLedgerTransaction = db.prepare(`
      INSERT INTO ledgerTransactions (
        ledgerTransactionId,
        legacyTransactionId,
        accountId,
        date,
        amountCents,
        importBatchId,
        description,
        merchant,
        originalDescription,
        originalCategory,
        type,
        transactionKind,
        status,
        fingerprint,
        sourceRole,
        occurrenceIndex,
        importFileId,
        importRowId,
        sourceTransactionId,
        createdAt,
        updatedAt
      ) VALUES (
        @ledgerTransactionId,
        @legacyTransactionId,
        @accountId,
        @date,
        @amountCents,
        @importBatchId,
        @description,
        @merchant,
        @originalDescription,
        @originalCategory,
        @type,
        @transactionKind,
        @status,
        @fingerprint,
        @sourceRole,
        @occurrenceIndex,
        (
          SELECT importFileId
          FROM importRows
          WHERE id = @importRowId
        ),
        @importRowId,
        (
          SELECT id
          FROM sourceTransactions
          WHERE importRowId = @importRowId
          LIMIT 1
        ),
        @createdAt,
        @updatedAt
      )
    `);
    const now = new Date().toISOString();
    for (const transaction of ledger.transactions) {
      const result = insertTransaction.run({
        ...transaction,
        createdAt: now,
      });
      if (transaction.importRowId) {
        updateImportRow.run({
          importRowId: transaction.importRowId,
          transactionId: result.lastInsertRowid,
          fingerprint: transaction.fingerprint,
        });
      }
      insertLedgerTransaction.run({
        ...transaction,
        legacyTransactionId: result.lastInsertRowid,
        amountCents: Math.round(transaction.amount * 100),
        sourceRole: transaction.sourceRole,
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const source of ledger.provenance ?? []) {
      db.prepare('INSERT INTO ledgerProvenance (ledgerTransactionId, sourceTransactionId, reason, selected) VALUES (?, ?, ?, ?)')
        .run(source.ledgerTransactionId, source.sourceTransactionId, source.reason, source.selected ? 1 : 0);
      if (source.selected) db.prepare('UPDATE ledgerTransactions SET sourceTransactionId = ? WHERE ledgerTransactionId = ?')
        .run(source.sourceTransactionId, source.ledgerTransactionId);
    }

    const insertBalance = db.prepare(`
      INSERT INTO balanceSnapshots (accountId, month, balance, capturedAt)
      VALUES (@accountId, @month, @balance, @capturedAt)
    `);
    const insertLedgerBalance = db.prepare(`
      INSERT INTO ledgerBalances (
        accountId,
        month,
        balanceCents,
        capturedAt,
        sourceBalanceId,
        createdAt,
        updatedAt
      ) VALUES (
        @accountId,
        @month,
        @balanceCents,
        @capturedAt,
        @sourceBalanceId,
        @createdAt,
        @updatedAt
      )
    `);
    for (const balance of ledger.balanceSnapshots) {
      insertBalance.run(balance);
      insertLedgerBalance.run({
        ...balance,
        balanceCents: Math.round(balance.balance * 100),
        createdAt: now,
        updatedAt: now,
      });
    }
  })();

  return {
    transactionCount: ledger.transactions.length,
    balanceSnapshotCount: ledger.balanceSnapshots.length,
  };
}
