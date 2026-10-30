import { getDb } from '../database';
import { hashContent } from '../hash';
import { listCategories } from './categories';
import { previewConservativeCategoryCleanup } from './categoryCleanup';
import { getOpenAiModel, previewMerchantRecommendations } from './aiCategorization';
import { applyReviewedCategoryChanges, listTransactions } from './transactions';
import { buildReviewGroups, reviewedTransaction } from './transactionReview';
import type { TransactionListItem } from './types';

export type MerchantScope = 'current' | 'history' | 'all';
type RecommendationStatus =
  'idle' | 'unavailable' | 'queued' | 'running' | 'ready' | 'review' | 'failed' | 'not_needed';
type CachedRecommendation = {
  groupId: string;
  fingerprint: string;
  status: RecommendationStatus;
  categoryId: number | null;
  reason: string | null;
};
let recommendationsEnabled = false;
let recommendationsRunning = false;
let recommendationTimer: ReturnType<typeof setTimeout> | undefined;
const unknown = (row: TransactionListItem) =>
  !row.category || row.category.name.toLowerCase() === 'uncategorized';
const evidence = (row: TransactionListItem) =>
  hashContent(JSON.stringify([reviewedTransaction(row), row.merchant, row.transactionKind]));
const fingerprint = (rows: TransactionListItem[]) =>
  hashContent(JSON.stringify(rows.map((row) => [row.ledgerTransactionId, evidence(row)]).sort()));

function groups() {
  const db = getDb();
  const acknowledgements = new Map(
    (
      db.prepare('SELECT * FROM categoryReviewAcknowledgements').all() as Array<{
        groupId: string;
        ledgerTransactionId: string;
        fingerprint: string;
        baselineCategoryId: number | null;
      }>
    ).map((row) => [`${row.groupId}:${row.ledgerTransactionId}`, row]),
  );
  const legacy = new Set(
    (
      db
        .prepare("SELECT groupId, fingerprint FROM categoryReviewDecisions WHERE status='kept'")
        .all() as Array<{ groupId: string; fingerprint: string }>
    ).map((row) => `${row.groupId}:${row.fingerprint}`),
  );
  return buildReviewGroups(listTransactions().transactions).map((group) => {
    const id = hashContent(group.id).slice(0, 32);
    const legacyFingerprint = hashContent(
      JSON.stringify(
        group.transactions
          .map((row) => [reviewedTransaction(row), row.merchant, row.transactionKind, row.notes])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ),
    );
    const legacyKept = legacy.has(`${id}:${legacyFingerprint}`);
    const acknowledged = (row: TransactionListItem) =>
      legacyKept ||
      acknowledgements.get(`${id}:${row.ledgerTransactionId}`)?.fingerprint === evidence(row);
    const known = group.transactions.filter((row) => !unknown(row));
    const acknowledgedCategories = new Set(
      known.filter(acknowledged).map((row) => row.category!.id),
    );
    for (const row of known.filter(acknowledged)) {
      const baseline = acknowledgements.get(`${id}:${row.ledgerTransactionId}`)?.baselineCategoryId;
      if (baseline) acknowledgedCategories.add(baseline);
    }
    const unreviewed = known.filter((row) => !acknowledged(row));
    const categories = [...new Set(known.map((row) => row.category!.name))].sort();
    const conflict =
      categories.length > 1 &&
      unreviewed.some((row) => !acknowledgedCategories.has(row.category!.id));
    const movement = buildReviewGroups(unreviewed).some((item) =>
      item.reasons.some((reason) => reason.startsWith('Possible investment')),
    );
    const uncategorized = group.transactions.filter(unknown);
    const current = uncategorized.length ? uncategorized : movement && !conflict ? unreviewed : [];
    return {
      ...group,
      id,
      legacyFingerprint,
      legacyKept,
      acknowledged,
      known,
      categories,
      conflict,
      movement,
      current,
      fingerprint: fingerprint(group.transactions),
      kept: legacyKept || !(uncategorized.length || conflict || movement),
      unreviewed,
      uncategorizedCount: uncategorized.length,
    };
  });
}

function summary(group: ReturnType<typeof groups>[number]) {
  return {
    id: group.id,
    name: group.name,
    accountName: group.accountName,
    categories: group.categories,
    fingerprint: group.fingerprint,
    primaryFingerprint: fingerprint(group.current.length ? group.current : group.unreviewed),
    kept: group.kept,
    transactionCount: group.transactions.length,
    singleTransaction:
      group.transactions.length === 1
        ? {
            id: group.transactions[0]!.ledgerTransactionId!,
            date: group.transactions[0]!.date,
            amount: group.transactions[0]!.amount,
          }
        : null,
    currentCount: group.current.length,
    reviewCount: group.current.length ? group.current.length : group.unreviewed.length,
    currentAmountCents: group.current.reduce(
      (sum, row) => sum + Math.abs(Math.round(row.amount * 100)),
      0,
    ),
    uncategorizedCount: group.uncategorizedCount,
    conflict: group.conflict,
    movement: group.movement,
  };
}

function recommendationContext() {
  const categories = listCategories().categories;
  return { categories, taxonomy: hashContent(JSON.stringify([2, getOpenAiModel(), categories])) };
}

function recommendationFingerprint(group: ReturnType<typeof groups>[number], taxonomy: string) {
  // Include every fact supplied to the model and the complete review/history scope.
  // Notes are private and are neither sent nor used to invalidate advice.
  return hashContent(
    JSON.stringify([
      taxonomy,
      group.fingerprint,
      (group.current.length ? group.current : group.unreviewed).map(
        (row) => row.ledgerTransactionId,
      ),
      group.transactions.map((row) => [
        row.ledgerTransactionId,
        row.account,
        row.originalDescription,
        row.originalCategory,
        row.sourceRole,
      ]),
    ]),
  );
}

function cachedRecommendations() {
  return new Map(
    (getDb().prepare('SELECT * FROM merchantRecommendations').all() as CachedRecommendation[]).map(
      (row) => [row.groupId, row],
    ),
  );
}

/** Enqueue visible unresolved merchants once per evidence/taxonomy revision. Reads never call AI. */
export function queueMerchantRecommendations(input: { groupIds: string[]; retry?: boolean }) {
  const ids = new Set(input.groupIds.slice(0, 25));
  if (!process.env.OPENAI_API_KEY?.trim()) return { queued: 0 };
  const { taxonomy } = recommendationContext();
  const cached = cachedRecommendations();
  let queued = 0;
  for (const group of groups().filter((group) => ids.has(group.id) && !group.kept)) {
    const fingerprint = recommendationFingerprint(group, taxonomy);
    const previous = cached.get(group.id);
    if (previous?.fingerprint === fingerprint && !(input.retry && previous.status === 'failed'))
      continue;
    getDb()
      .prepare(
        `INSERT INTO merchantRecommendations (groupId,fingerprint,status,categoryId,reason,updatedAt)
      VALUES (?,?,'queued',NULL,NULL,?) ON CONFLICT(groupId) DO UPDATE SET
      fingerprint=excluded.fingerprint,status='queued',categoryId=NULL,reason=NULL,updatedAt=excluded.updatedAt`,
      )
      .run(group.id, fingerprint, new Date().toISOString());
    queued++;
  }
  scheduleMerchantRecommendations();
  return { queued };
}

/** Provider injection keeps tests isolated. Results are advice only, never category edits. */
export async function processMerchantRecommendationBatch(preview = previewMerchantRecommendations) {
  const tasks = getDb()
    .prepare(
      "SELECT * FROM merchantRecommendations WHERE status='queued' ORDER BY updatedAt,groupId LIMIT 25",
    )
    .all() as CachedRecommendation[];
  if (!tasks.length) return false;
  const { taxonomy } = recommendationContext();
  const all = new Map(groups().map((group) => [group.id, group]));
  const eligible = tasks.flatMap((task) => {
    const group = all.get(task.groupId);
    if (!group || group.kept || task.fingerprint !== recommendationFingerprint(group, taxonomy)) {
      getDb()
        .prepare('DELETE FROM merchantRecommendations WHERE groupId=? AND fingerprint=?')
        .run(task.groupId, task.fingerprint);
      return [];
    }
    return [{ task, group }];
  });
  const update = getDb()
    .prepare(`UPDATE merchantRecommendations SET status=?,categoryId=?,reason=?,updatedAt=?
    WHERE groupId=? AND fingerprint=? AND status='running'`);
  for (const { task } of eligible)
    getDb()
      .prepare(
        "UPDATE merchantRecommendations SET status='running' WHERE groupId=? AND fingerprint=?",
      )
      .run(task.groupId, task.fingerprint);
  if (!eligible.length) return true;
  try {
    const results = await preview(
      eligible.map(({ group }) => ({
        id: group.id,
        name: group.name,
        transactions: group.current.length ? group.current : group.unreviewed,
      })),
    );
    const latestContext = recommendationContext();
    const latest = new Map(groups().map((group) => [group.id, group]));
    for (const { task } of eligible) {
      const group = latest.get(task.groupId);
      if (
        !group ||
        group.kept ||
        task.fingerprint !== recommendationFingerprint(group, latestContext.taxonomy)
      ) {
        getDb()
          .prepare('DELETE FROM merchantRecommendations WHERE groupId=? AND fingerprint=?')
          .run(task.groupId, task.fingerprint);
        continue;
      }
      const matches = results.filter((result) => result.groupId === task.groupId);
      const advice = matches.length === 1 ? matches[0] : undefined;
      const categoryId = latestContext.categories.some(
        (category) => category.id === advice?.categoryId,
      )
        ? advice!.categoryId
        : null;
      update.run(
        categoryId ? 'ready' : 'review',
        categoryId,
        advice?.reason ?? 'No supported category recommendation. Choose a category.',
        new Date().toISOString(),
        task.groupId,
        task.fingerprint,
      );
    }
  } catch {
    for (const { task } of eligible)
      update.run(
        'failed',
        null,
        'AI recommendation failed. You can retry or choose a category.',
        new Date().toISOString(),
        task.groupId,
        task.fingerprint,
      );
  }
  return true;
}

function scheduleMerchantRecommendations() {
  if (!recommendationsEnabled || recommendationsRunning || recommendationTimer) return;
  recommendationTimer = setTimeout(() => {
    recommendationTimer = undefined;
    recommendationsRunning = true;
    void (async () => {
      try {
        while (await processMerchantRecommendationBatch())
          await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        recommendationsRunning = false;
      }
    })().catch(() => {
      /* failed jobs retain an explicit retry state */
    });
  }, 0);
}

export function startMerchantRecommendationWorker() {
  if (recommendationsEnabled) return;
  recommendationsEnabled = true;
  getDb()
    .prepare("UPDATE merchantRecommendations SET status='queued' WHERE status='running'")
    .run();
  if (process.env.OPENAI_API_KEY?.trim()) scheduleMerchantRecommendations();
}

export function hasPendingMerchantRecommendations() {
  return Boolean(
    getDb()
      .prepare("SELECT 1 FROM merchantRecommendations WHERE status IN ('queued','running') LIMIT 1")
      .get(),
  );
}

/** Compact merchant-level overview; no model requests and no transaction arrays. */
export function merchantReviewQueue(
  input: { search?: string; status?: 'open' | 'kept'; offset?: number } = {},
) {
  const all = groups();
  const search = input.search?.trim().toLowerCase() ?? '';
  const matching = all.filter(
    (group) =>
      group.kept === (input.status === 'kept') &&
      (!search ||
        `${group.name} ${group.accountName} ${group.categories.join(' ')}`
          .toLowerCase()
          .includes(search)),
  );
  const offset = input.offset ?? 0;
  const candidates = new Map(
    previewConservativeCategoryCleanup().candidates.map((candidate) => [
      candidate.transaction.ledgerTransactionId,
      candidate,
    ]),
  );
  const { categories, taxonomy } = recommendationContext();
  const cached = cachedRecommendations();
  return {
    groups: matching.slice(offset, offset + 25).map((group) => {
      const guesses = group.current.map((row) => candidates.get(row.ledgerTransactionId));
      const first = guesses[0];
      const conservative =
        first && guesses.every((guess) => guess?.categoryId === first.categoryId)
          ? { categoryId: first.categoryId, reason: first.reason, source: 'history' as const }
          : null;
      const stored = cached.get(group.id);
      const advice =
        stored?.fingerprint === recommendationFingerprint(group, taxonomy) ? stored : undefined;
      const suggestion =
        conservative ??
        (advice?.status === 'ready' && advice.categoryId
          ? { categoryId: advice.categoryId, reason: advice.reason ?? '', source: 'ai' as const }
          : null);
      const currentIds = new Set(group.current.map((row) => row.ledgerTransactionId));
      const history = group.known.filter(
        (row) => !currentIds.has(row.ledgerTransactionId) && !group.acknowledged(row),
      );
      return {
        ...summary(group),
        suggestion,
        recommendation: {
          status: (conservative || group.kept
            ? 'not_needed'
            : (advice?.status ??
              (process.env.OPENAI_API_KEY?.trim()
                ? 'idle'
                : 'unavailable'))) as RecommendationStatus,
          reason: advice?.reason ?? null,
        },
        reviewedCount: group.known.filter(group.acknowledged).length,
        historyTargets: categories.map((category) => ({
          categoryId: category.id,
          count: history.filter((row) => row.category!.id !== category.id).length,
          matchingCount: group.known.filter((row) => row.category!.id === category.id).length,
        })),
      };
    }),
    totalCount: matching.length,
    hasMore: offset + 25 < matching.length,
    nextOffset: offset + 25 < matching.length ? offset + 25 : null,
  };
}

function scoped(input: { groupId: string; scope: MerchantScope; categoryId?: number }) {
  const group = groups().find((group) => group.id === input.groupId);
  if (!group) throw new Error('This merchant no longer has review activity. Refresh the list.');
  if (input.scope === 'history' && !input.categoryId)
    throw new Error('Choose a category before reviewing earlier differences.');
  // Current entries and already-acknowledged differences never leak into history correction.
  const currentIds = new Set(group.current.map((row) => row.ledgerTransactionId));
  const rows =
    input.scope === 'all'
      ? group.transactions
      : input.scope === 'current'
        ? group.current.length
          ? group.current
          : group.unreviewed
        : group.known.filter(
            (row) =>
              !currentIds.has(row.ledgerTransactionId) &&
              !group.acknowledged(row) &&
              row.category!.id !== input.categoryId,
          );
  return { group, rows };
}

export function merchantReviewScope(input: {
  groupId: string;
  scope: MerchantScope;
  categoryId?: number;
  offset?: number;
}) {
  const { group, rows } = scoped(input);
  const offset = input.offset ?? 0;
  return {
    ...summary(group),
    fingerprint: fingerprint(rows),
    count: rows.length,
    transactions: rows.slice(offset, offset + 50),
    hasMore: offset + 50 < rows.length,
    nextOffset: offset + 50 < rows.length ? offset + 50 : null,
    matchingHistoryCount: group.known.filter((row) => row.category!.id === input.categoryId).length,
  };
}

/** Re-derive the complete displayed scope atomically, never just a loaded sample/page. */
export function saveMerchantCategories(input: {
  groupId: string;
  scope: MerchantScope;
  categoryId: number;
  fingerprint: string;
}) {
  return getDb().transaction(() => {
    const { rows } = scoped(input);
    if (!rows.length || fingerprint(rows) !== input.fingerprint)
      throw new Error('This review changed. Refresh before saving.');
    return applyReviewedCategoryChanges({
      label:
        input.scope === 'history'
          ? 'Earlier merchant category corrections'
          : 'Merchant category review',
      changes: rows.map((row) => ({ ...reviewedTransaction(row), categoryId: input.categoryId })),
    });
  })();
}

/** Intentional differences are durable choices about exact identities/facts, not a future merchant rule. */
export function keepMerchantDifferences(input: {
  groupId: string;
  scope: 'current' | 'history';
  categoryId?: number;
  fingerprint: string;
}) {
  const db = getDb();
  return db.transaction(() => {
    const { group, rows } = scoped(input);
    if (!rows.length || rows.some(unknown) || fingerprint(rows) !== input.fingerprint)
      throw new Error('This review changed. Refresh before keeping the differences.');
    const statement =
      db.prepare(`INSERT INTO categoryReviewAcknowledgements (groupId,ledgerTransactionId,fingerprint,baselineCategoryId,updatedAt)
      VALUES (?,?,?,?,?) ON CONFLICT(groupId,ledgerTransactionId) DO UPDATE SET fingerprint=excluded.fingerprint,baselineCategoryId=excluded.baselineCategoryId,updatedAt=excluded.updatedAt`);
    for (const row of rows)
      statement.run(
        group.id,
        row.ledgerTransactionId,
        evidence(row),
        input.scope === 'history' ? input.categoryId : null,
        new Date().toISOString(),
      );
    return { ok: true, count: rows.length };
  })();
}

export function reopenMerchantReview(input: { groupId: string; fingerprint: string }) {
  const db = getDb();
  return db.transaction(() => {
    const group = groups().find((group) => group.id === input.groupId);
    if (!group || group.fingerprint !== input.fingerprint)
      throw new Error('This review changed. Refresh before reopening.');
    db.prepare('DELETE FROM categoryReviewAcknowledgements WHERE groupId=?').run(group.id);
    db.prepare("UPDATE categoryReviewDecisions SET status='reopened' WHERE groupId=?").run(
      group.id,
    );
    return { ok: true };
  })();
}
