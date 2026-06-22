import { Agent, OpenAIProvider, Runner } from '@openai/agents';
import { z } from 'zod';
import { getDb } from '../database.js';
import { upsertTransactionAnnotation } from './transactionAnnotations.ts';
import type { CategorySummary } from './types.ts';

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
  groupId: string;
  categoryName: string | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

interface ModelQuestion {
  groupId: string;
  pattern: string;
  reason: string;
}

interface ModelResponse {
  assignments: ModelAssignment[];
  questions: ModelQuestion[];
}

export interface AiCategorySuggestion {
  id: string;
  groupId: string;
  merchantName: string;
  aliases: string[];
  transactionIds: string[];
  transactionCount: number;
  totalAmount: number;
  categoryId: number;
  categoryName: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  transactions: AiCategorizationTransaction[];
}

export interface AiCategoryQuestion {
  groupId: string;
  pattern: string;
  transactionIds: string[];
  aliases: string[];
  transactionCount: number;
  totalAmount: number;
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

interface MerchantCategorizationGroup {
  id: string;
  merchantName: string;
  normalizedMerchant: string;
  aliases: string[];
  transactions: UncategorizedTransactionRow[];
  transactionIds: string[];
  transactionCount: number;
  totalAmount: number;
  absoluteAmount: number;
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

function normalizeMerchantText(value: string | null | undefined) {
  const original = (value || 'Unknown').trim() || 'Unknown';
  let cleaned = original
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')
    .replace(/\b(?:card|visa|mastercard|debit)\s*[-*#]?\s*\d{3,}\b/g, ' ')
    .replace(/\b(?:auth|authorization|ref|trace|id)\s*[-#: ]*\s*[a-z0-9]{4,}\b/g, ' ')
    .replace(/\b[a-z0-9]*\d[a-z0-9]*[a-z][a-z0-9]*\b/g, ' ')
    .replace(/\s+#?\d{3,}\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) cleaned = original.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || 'unknown';

  return {
    key: cleaned.toUpperCase(),
    displayName: cleaned
      .split(' ')
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' '),
    originalName: original,
  };
}

function transactionMerchantText(row: UncategorizedTransactionRow) {
  return row.merchant || row.description || row.originalDescription || 'Unknown';
}

export function groupTransactionsForAiCategorization(rows: UncategorizedTransactionRow[]): MerchantCategorizationGroup[] {
  const groupsByKey = new Map<string, MerchantCategorizationGroup>();

  for (const row of rows) {
    const normalized = normalizeMerchantText(transactionMerchantText(row));
    const groupId = `merchant:${normalized.key}`;
    const existing = groupsByKey.get(groupId);
    const amount = row.amountCents / 100;
    const group = existing ?? {
      id: groupId,
      merchantName: normalized.displayName,
      normalizedMerchant: normalized.key,
      aliases: [],
      transactions: [],
      transactionIds: [],
      transactionCount: 0,
      totalAmount: 0,
      absoluteAmount: 0,
    };

    group.transactions.push(row);
    group.transactionIds.push(row.ledgerTransactionId);
    group.transactionCount += 1;
    group.totalAmount += amount;
    group.absoluteAmount += Math.abs(amount);
    if (!group.aliases.includes(normalized.originalName)) {
      group.aliases.push(normalized.originalName);
    }
    groupsByKey.set(groupId, group);
  }

  return [...groupsByKey.values()]
    .map(group => {
      const transactions = group.transactions.sort((a, b) => b.date.localeCompare(a.date));
      return {
        ...group,
        aliases: group.aliases.sort((a, b) => a.localeCompare(b)),
        transactions,
        transactionIds: transactions.map(transaction => transaction.ledgerTransactionId),
      };
    })
    .sort((a, b) =>
      b.transactionCount - a.transactionCount ||
      b.absoluteAmount - a.absoluteAmount ||
      a.merchantName.localeCompare(b.merchantName)
    );
}

function compactMerchantGroup(group: MerchantCategorizationGroup) {
  return {
    groupId: group.id,
    merchantName: group.merchantName,
    aliases: group.aliases.slice(0, 8),
    transactionCount: group.transactionCount,
    totalAmount: Math.round(group.totalAmount * 100) / 100,
    absoluteAmount: Math.round(group.absoluteAmount * 100) / 100,
    sampleTransactions: group.transactions.slice(0, 6).map(compactTransaction),
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

function buildCategorizationOutputSchema(categoryNames: [string, ...string[]]) {
  const categoryName = z.union([z.enum(categoryNames), z.null()]);

  return z.strictObject({
    assignments: z.array(z.strictObject({
      groupId: z.string(),
      categoryName,
      confidence: z.enum(['high', 'medium', 'low']),
      reason: z.string(),
    })),
    questions: z.array(z.strictObject({
      groupId: z.string(),
      pattern: z.string(),
      reason: z.string(),
    })),
  });
}

async function categorizeBatchWithOpenAi(input: {
  apiKey: string;
  model: string;
  categories: CategorySummary[];
  groups: MerchantCategorizationGroup[];
}) {
  const categoryNames = input.categories.map(category => category.name) as [string, ...string[]];
  const agent = new Agent({
    name: 'Transaction categorization',
    model: input.model,
    instructions: [
      'You categorize personal finance merchant/payee groups into the provided existing categories.',
      'Only use an exact category name from the category list.',
      'Return null categoryName when you are not confident. Do not guess.',
      'Treat the whole merchant/payee group as one decision.',
      'If a group is probably variable, such as Venmo, Zelle, PayPal, checks, cash app, or a generic bank transfer, add a question instead of an assignment.',
      'Prefer high confidence only for obvious merchant/category matches that should apply to the whole group.',
    ].join('\n'),
    outputType: buildCategorizationOutputSchema(categoryNames),
  });

  const runner = new Runner({
    modelProvider: new OpenAIProvider({ apiKey: input.apiKey }),
    traceIncludeSensitiveData: false,
    workflowName: 'EasyMoney AI categorization',
  });
  const result = await runner.run(
    agent,
    JSON.stringify({
      categories: input.categories.map(category => ({
        name: category.name,
        type: category.type,
      })),
      merchantGroups: input.groups.map(compactMerchantGroup),
    }),
    { maxTurns: 1 }
  );

  if (!result.finalOutput) {
    throw new Error('OpenAI categorization request did not return structured output.');
  }

  return result.finalOutput as ModelResponse;
}

export async function previewAiCategorization(options: { limit?: unknown } = {}) {
  const apiKey = getOpenAiKey();
  const model = getOpenAiModel();
  const limit = clampLimit(options.limit);
  const categories = listCategorizationCategories();
  const transactions = listUncategorizedTransactions(limit);
  const groups = groupTransactionsForAiCategorization(transactions);

  if (!apiKey) {
    return {
      configured: false,
      model,
      scanned: transactions.length,
      groupCount: groups.length,
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
      groupCount: groups.length,
      suggestions: [] as AiCategorySuggestion[],
      questions: [] as AiCategoryQuestion[],
    };
  }

  const categoryByName = new Map(categories.map(category => [category.name, category]));
  const groupById = new Map(groups.map(group => [group.id, group]));
  const suggestions: AiCategorySuggestion[] = [];
  const questions: AiCategoryQuestion[] = [];

  for (const batch of chunk(groups, BATCH_SIZE)) {
    const result = await categorizeBatchWithOpenAi({
      apiKey,
      model,
      categories,
      groups: batch,
    });

    for (const assignment of result.assignments ?? []) {
      if (assignment.confidence !== 'high') continue;
      if (!assignment.categoryName) continue;
      const category = categoryByName.get(assignment.categoryName);
      const group = groupById.get(assignment.groupId);
      if (!category || !group) continue;
      suggestions.push({
        id: group.id,
        groupId: group.id,
        merchantName: group.merchantName,
        aliases: group.aliases,
        transactionIds: group.transactionIds,
        transactionCount: group.transactionCount,
        totalAmount: Math.round(group.totalAmount * 100) / 100,
        categoryId: category.id,
        categoryName: category.name,
        confidence: assignment.confidence,
        reason: assignment.reason,
        transactions: group.transactions.slice(0, 6).map(transactionSummary),
      });
    }

    for (const question of result.questions ?? []) {
      const group = groupById.get(question.groupId);
      if (!group) continue;
      questions.push({
        groupId: group.id,
        pattern: question.pattern,
        transactionIds: group.transactionIds,
        aliases: group.aliases,
        transactionCount: group.transactionCount,
        totalAmount: Math.round(group.totalAmount * 100) / 100,
        reason: question.reason,
        transactions: group.transactions.slice(0, 8).map(transactionSummary),
      });
    }
  }

  return {
    configured: true,
    model,
    scanned: transactions.length,
    groupCount: groups.length,
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
