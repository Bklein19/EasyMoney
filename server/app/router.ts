import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { listAccounts } from './accounts.ts';
import { applyAiCategorizationSuggestions, getAiCategorizationTransactionDetails, previewAiCategorization } from './aiCategorization.ts';
import { listCategories } from './categories.ts';
import { saveLocalEnvValue } from './localEnv.ts';
import { getNetWorthReport } from './netWorth.ts';
import {
  categorizeTransactions,
  categorizeTransactionsByQuery,
  getLatestTransactionCategoryUndoOperation,
  listTransactions,
  restoreTransactionCategories,
} from './transactions.ts';

const t = initTRPC.create();

const optionalId = z.union([z.string(), z.number()]).nullish();

export const appRouter = t.router({
  accounts: t.router({
    list: t.procedure
      .input(z.object({
        includeArchived: z.boolean().optional(),
      }).optional())
      .query(({ input }) => listAccounts(input ?? {})),
  }),

  categories: t.router({
    list: t.procedure.query(() => listCategories()),
  }),

  transactions: t.router({
    list: t.procedure
      .input(z.object({
        accountId: optionalId,
        categoryId: optionalId,
        accountKind: z.string().nullish(),
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
        search: z.string().nullish(),
        type: z.string().nullish(),
        flowType: z.string().nullish(),
        sortBy: z.string().nullish(),
        limit: optionalId,
        offset: optionalId,
        includeArchived: z.boolean().nullish(),
      }).optional())
      .query(({ input }) => listTransactions(input ?? {})),

    categorize: t.procedure
      .input(z.object({
        transactionIds: z.array(z.union([z.string(), z.number()])).min(1),
        categoryId: optionalId,
      }))
      .mutation(({ input }) => categorizeTransactions(input)),

    categorizeMatching: t.procedure
      .input(z.object({
        query: z.object({
          accountId: optionalId,
          categoryId: optionalId,
          accountKind: z.string().nullish(),
          startDate: z.string().nullish(),
          endDate: z.string().nullish(),
          search: z.string().nullish(),
          type: z.string().nullish(),
          flowType: z.string().nullish(),
          sortBy: z.string().nullish(),
          includeArchived: z.boolean().nullish(),
        }).optional(),
        categoryId: optionalId,
      }))
      .mutation(({ input }) => categorizeTransactionsByQuery(input)),

    restoreCategories: t.procedure
      .input(z.object({
        undoOperationId: z.union([z.string(), z.number()]),
      }))
      .mutation(({ input }) => restoreTransactionCategories(input)),

    latestCategoryUndo: t.procedure
      .query(() => getLatestTransactionCategoryUndoOperation()),

    aiCategorizationPreview: t.procedure
      .input(z.object({
        limit: z.number().optional(),
      }).optional())
      .mutation(({ input }) => previewAiCategorization(input ?? {})),

    applyAiCategorization: t.procedure
      .input(z.object({
        suggestions: z.array(z.object({
          transactionId: z.string().min(1),
          categoryId: z.union([z.string(), z.number()]),
        })),
      }))
      .mutation(({ input }) => applyAiCategorizationSuggestions(input)),

    aiCategorizationTransactionDetails: t.procedure
      .input(z.object({
        transactionIds: z.array(z.string()).min(1),
      }))
      .query(({ input }) => getAiCategorizationTransactionDetails(input)),

    saveOpenAiCategorizationSettings: t.procedure
      .input(z.object({
        apiKey: z.string().min(1),
        model: z.string().optional(),
      }))
      .mutation(({ input }) => {
        saveLocalEnvValue('OPENAI_API_KEY', input.apiKey.trim());
        if (input.model?.trim()) {
          saveLocalEnvValue('OPENAI_CATEGORIZATION_MODEL', input.model.trim());
        }
        return { ok: true };
      }),
  }),

  netWorth: t.router({
    report: t.procedure.query(() => getNetWorthReport()),
  }),
});

export type AppRouter = typeof appRouter;
