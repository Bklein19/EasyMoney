import { getDb } from '../database.js';
import { upsertTransactionAnnotation } from './transactionAnnotations.ts';
import type { CategorySummary } from './types.ts';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-5.4-mini';
const MAX_TRANSACTIONS = 500;
const BATCH_SIZE = 40;

interface UncategorizedTransactionRow {
  id: number;
  ledgerTransactionId: string;
  accountName: string | null;
  accountInstitution: string | null;
  accountType: string | null;
  date: string;
  amountCents: number;
  description: string | null;
  merchant: string | null;
  originalDescription: string | null;
  originalCategory: string | null;
  transactionKind: string | null;
}

interface ModelAssignment {
  transactionId: string;
  categoryName: string | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

interface ModelQuestion {
  pattern: string;
  transactionIds: string[];
  reason: string;
}

interface ModelResponse {
  assignments: ModelAssignment[];
  questions: ModelQuestion[];
}

export interface AiCategorySuggestion {
  transactionId: string;
  categoryId: number;
  categoryName: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  transaction: AiCategorizationTransaction;
}

export interface AiCategoryQuestion {
  pattern: string;
  transactionIds: string[];
  reason: string;
  transactions: AiCategorizationTransaction[];
}

export interface AiCategorizationTransaction {
  transactionId: string;
  date: string;
  amount: number;
  description: string | null;
  merchant: string | null;
  account: string | null;
}

function getOpenAiKey() {
  return process.env.OPENAI_API_KEY?.trim() || '';
}

function getOpenAiModel() {
  return process.env.OPENAI_CATEGORIZATION_MODEL?.trim() || DEFAULT_MODEL;
}

function clampLimit(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 200;
  return Math.max(1, Math.min(MAX_TRANSACTIONS, Math.trunc(parsed)));
}

function listCategorizationCategories() {
  return getDb()
    .prepare(
      `SELECT id, name, parentId, type, color, icon
       FROM categories
       WHERE lower(name) != 'uncategorized'
       ORDER BY name ASC, id ASC`
    )
    .all() as CategorySummary[];
}

function listUncategorizedTransactions(limit: number) {
  return getDb()
    .prepare(
      `SELECT
        t.id,
        t.ledgerTransactionId,
        a.name AS accountName,
        a.institution AS accountInstitution,
        a.type AS accountType,
        t.date,
        t.amountCents,
        t.description,
        t.merchant,
        t.originalDescription,
        t.originalCategory,
        t.transactionKind
       FROM ledgerTransactions t
       LEFT JOIN accounts a ON a.id = t.accountId
       LEFT JOIN transactionAnnotations ta ON ta.ledgerTransactionId = t.ledgerTransactionId
       LEFT JOIN categories c ON c.id = ta.categoryId
       WHERE t.ledgerTransactionId IS NOT NULL
         AND (ta.categoryId IS NULL OR lower(c.name) = 'uncategorized')
         AND COALESCE(a.status, 'active') != 'archived'
       ORDER BY t.date DESC, t.id DESC
       LIMIT ?`
    )
    .all(limit) as UncategorizedTransactionRow[];
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function buildResponseSchema(categoryNames: string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['assignments', 'questions'],
    properties: {
      assignments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['transactionId', 'categoryName', 'confidence', 'reason'],
          properties: {
            transactionId: { type: 'string' },
            categoryName: {
              anyOf: [
                { type: 'string', enum: categoryNames },
                { type: 'null' },
              ],
            },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            reason: { type: 'string' },
          },
        },
      },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['pattern', 'transactionIds', 'reason'],
          properties: {
            pattern: { type: 'string' },
            transactionIds: {
              type: 'array',
              items: { type: 'string' },
            },
            reason: { type: 'string' },
          },
        },
      },
    },
  };
}

function compactTransaction(row: UncategorizedTransactionRow) {
  return {
    id: row.ledgerTransactionId,
    date: row.date,
    amount: row.amountCents / 100,
    description: row.description,
    merchant: row.merchant,
    originalDescription: row.originalDescription,
    originalCategory: row.originalCategory,
    account: [row.accountInstitution, row.accountName].filter(Boolean).join(' ') || null,
    accountType: row.accountType,
    transactionKind: row.transactionKind,
  };
}

function transactionSummary(row: UncategorizedTransactionRow): AiCategorizationTransaction {
  return {
    transactionId: row.ledgerTransactionId,
    date: row.date,
    amount: row.amountCents / 100,
    description: row.description,
    merchant: row.merchant,
    account: [row.accountInstitution, row.accountName].filter(Boolean).join(' ') || null,
  };
}

export function getAiCategorizationTransactionDetails(input: { transactionIds: string[] }) {
  const ids = [...new Set((input.transactionIds ?? []).map(id => String(id)).filter(Boolean))].slice(0, MAX_TRANSACTIONS);
  if (!ids.length) return { transactions: [] as AiCategorizationTransaction[] };

  const placeholders = ids.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(
      `SELECT
        t.id,
        t.ledgerTransactionId,
        a.name AS accountName,
        a.institution AS accountInstitution,
        a.type AS accountType,
        t.date,
        t.amountCents,
        t.description,
        t.merchant,
        t.originalDescription,
        t.originalCategory,
        t.transactionKind
       FROM ledgerTransactions t
       LEFT JOIN accounts a ON a.id = t.accountId
       WHERE t.ledgerTransactionId IN (${placeholders})
       ORDER BY t.date DESC, t.id DESC`
    )
    .all(...ids) as UncategorizedTransactionRow[];

  return { transactions: rows.map(transactionSummary) };
}

function parseModelJson(responseBody: any): ModelResponse {
  const text = typeof responseBody.output_text === 'string'
    ? responseBody.output_text
    : responseBody.output
      ?.flatMap((item: any) => item.content ?? [])
      ?.map((content: any) => content.text ?? '')
      ?.join('');

  if (!text) throw new Error('OpenAI response did not include structured output text.');
  return JSON.parse(text) as ModelResponse;
}

async function categorizeBatchWithOpenAi(input: {
  apiKey: string;
  model: string;
  categories: CategorySummary[];
  transactions: UncategorizedTransactionRow[];
}) {
  const categoryNames = input.categories.map(category => category.name);
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      instructions: [
        'You categorize personal finance transactions into the provided existing categories.',
        'Only use an exact category name from the category list.',
        'Return null categoryName when you are not confident. Do not guess.',
        'If several transactions share a clear pattern but the category is ambiguous, add a question describing the pattern and transaction IDs.',
        'Prefer high confidence only for obvious merchant/category matches.',
      ].join('\n'),
      input: JSON.stringify({
        categories: input.categories.map(category => ({
          name: category.name,
          type: category.type,
        })),
        transactions: input.transactions.map(compactTransaction),
      }),
      text: {
        format: {
          type: 'json_schema',
          name: 'transaction_categorization',
          strict: true,
          schema: buildResponseSchema(categoryNames),
        },
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI categorization request failed (${response.status}): ${detail.slice(0, 500)}`);
  }

  return parseModelJson(await response.json());
}

export async function previewAiCategorization(options: { limit?: unknown } = {}) {
  const apiKey = getOpenAiKey();
  const model = getOpenAiModel();
  const limit = clampLimit(options.limit);
  const categories = listCategorizationCategories();
  const transactions = listUncategorizedTransactions(limit);

  if (!apiKey) {
    return {
      configured: false,
      model,
      scanned: transactions.length,
      suggestions: [] as AiCategorySuggestion[],
      questions: [] as AiCategoryQuestion[],
      message: 'Set OPENAI_API_KEY on the server to enable AI categorization.',
    };
  }

  if (!categories.length || !transactions.length) {
    return {
      configured: true,
      model,
      scanned: transactions.length,
      suggestions: [] as AiCategorySuggestion[],
      questions: [] as AiCategoryQuestion[],
    };
  }

  const categoryByName = new Map(categories.map(category => [category.name, category]));
  const transactionIds = new Set(transactions.map(transaction => transaction.ledgerTransactionId));
  const transactionById = new Map(transactions.map(transaction => [transaction.ledgerTransactionId, transaction]));
  const suggestions: AiCategorySuggestion[] = [];
  const questions: AiCategoryQuestion[] = [];

  for (const batch of chunk(transactions, BATCH_SIZE)) {
    const result = await categorizeBatchWithOpenAi({
      apiKey,
      model,
      categories,
      transactions: batch,
    });

    for (const assignment of result.assignments ?? []) {
      if (assignment.confidence !== 'high') continue;
      if (!assignment.categoryName) continue;
      const category = categoryByName.get(assignment.categoryName);
      const transaction = transactionById.get(assignment.transactionId);
      if (!category || !transaction) continue;
      suggestions.push({
        transactionId: assignment.transactionId,
        categoryId: category.id,
        categoryName: category.name,
        confidence: assignment.confidence,
        reason: assignment.reason,
        transaction: transactionSummary(transaction),
      });
    }

    for (const question of result.questions ?? []) {
      const ids = [...new Set(question.transactionIds.filter(id => transactionIds.has(id)))];
      if (!ids.length) continue;
      questions.push({
        pattern: question.pattern,
        transactionIds: ids,
        reason: question.reason,
        transactions: ids
          .map(id => transactionById.get(id))
          .filter((transaction): transaction is UncategorizedTransactionRow => Boolean(transaction))
          .map(transactionSummary),
      });
    }
  }

  return {
    configured: true,
    model,
    scanned: transactions.length,
    suggestions,
    questions,
  };
}

export function applyAiCategorizationSuggestions(input: {
  suggestions: Array<{ transactionId: string; categoryId: number | string }>;
}) {
  const suggestions = input.suggestions ?? [];
  const validCategories = new Set(
    (getDb().prepare('SELECT id FROM categories').all() as Array<{ id: number }>).map(row => Number(row.id))
  );
  const requested = new Map<string, number>();

  for (const suggestion of suggestions) {
    const transactionId = String(suggestion.transactionId || '');
    const categoryId = Number(suggestion.categoryId);
    if (!transactionId || !Number.isFinite(categoryId)) continue;
    if (!validCategories.has(categoryId)) continue;
    requested.set(transactionId, categoryId);
  }

  const ids = [...requested.keys()];
  const rows = ids.length
    ? getDb().prepare(`
        SELECT
          t.ledgerTransactionId,
          ta.categoryId,
          c.name AS categoryName
        FROM ledgerTransactions t
        LEFT JOIN transactionAnnotations ta ON ta.ledgerTransactionId = t.ledgerTransactionId
        LEFT JOIN categories c ON c.id = ta.categoryId
        WHERE t.ledgerTransactionId IN (${ids.map(() => '?').join(', ')})
      `).all(...ids) as Array<{ ledgerTransactionId: string; categoryId: number | null; categoryName: string | null }>
    : [];
  const rowById = new Map(rows.map(row => [row.ledgerTransactionId, row]));
  const applyIds: string[] = [];
  const skipped: Array<{ transactionId: string; reason: string }> = [];

  for (const transactionId of ids) {
    const row = rowById.get(transactionId);
    if (!row) {
      skipped.push({ transactionId, reason: 'Transaction not found' });
      continue;
    }
    if (row.categoryId !== null && row.categoryName?.toLowerCase() !== 'uncategorized') {
      skipped.push({ transactionId, reason: 'Already categorized' });
      continue;
    }
    applyIds.push(transactionId);
  }

  const apply = getDb().transaction(() => {
    for (const transactionId of applyIds) {
      const categoryId = requested.get(transactionId);
      if (!categoryId) continue;
      upsertTransactionAnnotation(transactionId, { categoryId });
    }
  });
  apply();

  return {
    ok: true,
    count: applyIds.length,
    requested: ids.length,
    appliedTransactionIds: applyIds,
    skipped,
  };
}
