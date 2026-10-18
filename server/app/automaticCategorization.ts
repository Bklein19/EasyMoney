import { getDb } from '../database.ts';
import { previewAiCategorization } from './aiCategorization.ts';
import { applyReviewedCategoryChanges } from './transactions.ts';

// Categorization is a standing workflow over the ledger, not an import phase.
// Startup and periodic discovery cover historical and newly uncategorized rows.
let enabled = false;
let running = false;
let scheduled: ReturnType<typeof setTimeout> | undefined;

interface Evidence {
  categoryId: number | null;
  annotationUpdatedAt: string | null;
  notes: string | null;
  accountId: number;
  date: string;
  amountCents: number;
  description: string | null;
  merchant: string | null;
  originalDescription: string | null;
  originalCategory: string | null;
  transactionKind: string | null;
  sourceRole: string | null;
  accountType: string;
  accountInstitution: string | null;
}

function eligibleRows() {
  return getDb().prepare(`SELECT t.ledgerTransactionId, ta.categoryId, ta.updatedAt AS annotationUpdatedAt,
      ta.notes, t.accountId, t.date, t.amountCents,
      t.description, t.merchant, t.originalDescription, t.originalCategory,
      t.transactionKind, t.sourceRole, a.type AS accountType, a.institution AS accountInstitution
    FROM ledgerTransactions t JOIN accounts a ON a.id = t.accountId
    LEFT JOIN transactionAnnotations ta ON ta.ledgerTransactionId = t.ledgerTransactionId
    LEFT JOIN categories c ON c.id = ta.categoryId
    WHERE (ta.categoryId IS NULL OR lower(c.name) = 'uncategorized')
      AND COALESCE(ta.categoryOrigin, '') != 'manual'
      AND COALESCE(a.status, 'active') != 'archived'
    ORDER BY t.ledgerTransactionId`).all() as Array<Evidence & { ledgerTransactionId: string }>;
}

function evidenceJson(row: Evidence & { ledgerTransactionId: string }) {
  const { ledgerTransactionId: _id, ...evidence } = row;
  return JSON.stringify(evidence);
}

function categoryContext() {
  return JSON.stringify([
    getDb().prepare('SELECT * FROM categories ORDER BY id').all(),
    getDb().prepare('SELECT * FROM merchantGroupingRules ORDER BY id').all(),
  ]);
}

/** Give every eligible uncategorized identity one automatic first pass. */
export function queueUncategorizedTransactions() {
  const now = new Date().toISOString();
  const insert = getDb().prepare(`INSERT INTO automaticCategorizationTasks
    (ledgerTransactionId, evidenceJson, status, createdAt, updatedAt) VALUES (?, ?, 'queued', ?, ?)
    ON CONFLICT(ledgerTransactionId) DO UPDATE SET evidenceJson = excluded.evidenceJson,
      status = 'queued', reason = NULL, categoryId = NULL, undoOperationId = NULL, updatedAt = excluded.updatedAt
    WHERE automaticCategorizationTasks.status IN ('skipped', 'applied')
      OR (automaticCategorizationTasks.status = 'review' AND automaticCategorizationTasks.evidenceJson != excluded.evidenceJson)`);
  let queued = 0;
  for (const row of eligibleRows()) {
    queued += insert.run(row.ledgerTransactionId, evidenceJson(row), now, now).changes;
  }
  schedule();
  return queued;
}

export function automaticCategorizationStatus() {
  const counts = getDb().prepare(`SELECT status, COUNT(*) AS count FROM automaticCategorizationTasks GROUP BY status`)
    .all() as Array<{ status: string; count: number }>;
  const count = (status: string) => counts.find(row => row.status === status)?.count ?? 0;
  const latest = getDb().prepare(`SELECT MAX(updatedAt) AS revision FROM automaticCategorizationTasks`).get() as { revision: string | null };
  return {
    pending: count('queued') + count('running'), applied: count('applied'),
    needsReview: count('review'), failed: count('failed'), skipped: count('skipped'),
    configured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    // Counts make same-millisecond changes observable too.
    revision: JSON.stringify([latest.revision, counts]),
  };
}

/** Retry only failed jobs; never rerun an applied/undone or deliberately skipped guess. */
export function retryAutomaticCategorization() {
  getDb().prepare(`UPDATE automaticCategorizationTasks SET status = 'queued', reason = NULL,
    updatedAt = ? WHERE status = 'failed'`).run(new Date().toISOString());
  schedule();
  return automaticCategorizationStatus();
}

type Preview = typeof previewAiCategorization;

/** Public for deterministic tests; production always uses the shared AI workflow. */
export async function processAutomaticCategorizationBatch(preview: Preview = previewAiCategorization) {
  const db = getDb();
  const tasks = db.prepare(`SELECT ledgerTransactionId, evidenceJson FROM automaticCategorizationTasks
    WHERE status = 'queued' ORDER BY createdAt, ledgerTransactionId LIMIT 128`).all() as
    Array<{ ledgerTransactionId: string; evidenceJson: string }>;
  if (!tasks.length) return false;
  const update = db.prepare(`UPDATE automaticCategorizationTasks SET status = ?, reason = ?, categoryId = ?,
    undoOperationId = ?, updatedAt = ? WHERE ledgerTransactionId = ?`);
  const mark = (id: string, status: string, reason: string | null, categoryId: number | null = null, undoId: number | null = null) =>
    update.run(status, reason, categoryId, undoId, new Date().toISOString(), id);
  const current = new Map(eligibleRows().map(row => [row.ledgerTransactionId, evidenceJson(row)]));
  const eligible = tasks.filter(task => {
    if (current.get(task.ledgerTransactionId) === task.evidenceJson) return true;
    mark(task.ledgerTransactionId, 'skipped', 'Transaction was edited, removed, or archived before categorization.');
    return false;
  });
  if (!eligible.length) return true;
  for (const task of eligible) mark(task.ledgerTransactionId, 'running', null);
  const taxonomy = categoryContext();
  try {
    const result = await preview({ transactionIds: eligible.map(task => task.ledgerTransactionId), limit: 500 });
    db.transaction(() => {
      const latest = new Map(eligibleRows().map(row => [row.ledgerTransactionId, evidenceJson(row)]));
      const unchangedTaxonomy = taxonomy === categoryContext();
      const changes: Parameters<typeof applyReviewedCategoryChanges>[0]['changes'] = [];
      for (const task of eligible) {
        const id = task.ledgerTransactionId;
        if (latest.get(id) !== task.evidenceJson) {
          mark(id, 'skipped', 'Your edit or a ledger change took priority over the automatic guess.');
          continue;
        }
        if (!unchangedTaxonomy) {
          mark(id, 'failed', 'Categories changed during categorization. Retry with the current categories.');
          continue;
        }
        const guesses = result.suggestions.filter(suggestion => suggestion.transactionIds.includes(id));
        const question = result.questions.find(question => question.transactionIds.includes(id));
        if (!question && guesses.length === 1 && guesses[0]!.confidence === 'high') {
          const evidence = JSON.parse(task.evidenceJson) as Evidence;
          changes.push({ transactionId: id, categoryId: guesses[0]!.categoryId,
            expected: evidence });
        } else {
          mark(id, !result.configured && !question ? 'failed' : 'review', question?.reason ??
            (!result.configured ? 'AI is not configured. Historical matching found no category.' : 'No unambiguous category was returned.'));
        }
      }
      // Category-only annotation changes, stable identities, notes untouched, one Undo per batch.
      const applied = applyReviewedCategoryChanges({ label: 'Automatic categorization', categoryOrigin: 'automatic', changes });
      for (const change of changes) {
        const suggestion = result.suggestions.find(suggestion => suggestion.transactionIds.includes(change.transactionId))!;
        mark(change.transactionId, 'applied', suggestion.reason, change.categoryId, applied.undoOperation?.id ?? null);
      }
    })();
  } catch {
    // Never expose provider responses/prompts or turn a categorization failure into an import failure.
    db.transaction(() => {
      for (const task of eligible) mark(task.ledgerTransactionId, 'failed', 'Automatic categorization failed. Your import is safe; retry categorization.');
    })();
  }
  return true;
}

function schedule() {
  if (!enabled || running || scheduled) return;
  scheduled = setTimeout(() => {
    scheduled = undefined;
    running = true;
    void (async () => {
      try {
        while (await processAutomaticCategorizationBatch()) {
          // History-only batches also yield to navigation and other app requests.
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      } finally {
        running = false;
      }
    })().catch(() => { /* persisted tasks resume after restart */ });
  }, 0);
}

export function startAutomaticCategorizationWorker() {
  // Only the application entrypoint starts the worker, never DB migration or parser tests.
  if (enabled) return;
  enabled = true;
  resumeInterruptedCategorization();
  queueUncategorizedTransactions();
  // Also catches category deletion, parser refresh, and account unarchival.
  // Reads and React renders never initiate a model request.
  const discovery = setInterval(queueUncategorizedTransactions, 15_000);
  discovery.unref();
}

export function resumeInterruptedCategorization() {
  getDb().prepare(`UPDATE automaticCategorizationTasks SET status = 'queued' WHERE status = 'running'`).run();
}
