import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { archiveAccount, closeAccount, listAccounts, unarchiveAccount, updateAccountMetadata } from './accounts.ts';
import { getAnalyticsReport } from './analytics.ts';
import { getBudgetingReport } from './budgetingReport.ts';
import {
  autoApplyAiCategorization,
  applyAiCategorizationSuggestions,
  createMerchantGroupingRule,
  getAutoApplyAiCategorizationJob,
  getAiCategorizationTransactionDetails,
  previewAiCategorization,
  startAutoApplyAiCategorizationJob,
} from './aiCategorization.ts';
import { listBudgets, setBudget, deleteBudget } from './budgets.ts';
import {
  createCategorizationRule,
  deleteCategorizationRule,
  listCategorizationRules,
  updateCategorizationRule,
} from './categorizationRules.ts';
import { createCategory, deleteCategory, listCategories, updateCategory } from './categories.ts';
import { getDataFreshnessReport } from './dataFreshness.ts';
import { cancelSyncJob, confirmSyncJob, discardSyncJob, getSyncJob, startSyncJob } from './dataSync/jobs.ts';
import { isSyncInstitutionId } from './dataSync/registry.ts';
import { listSyncTargets } from './dataSync/runner.ts';
import type { SyncInstitutionId } from './dataSync/types.ts';
import { commitImport, listImportHistory, previewImport, reimportFile, reimportFiles, unimportFile, unimportFiles } from './imports.ts';
import { listImportProfiles, upsertImportProfile } from './importProfiles.ts';
import { getInvestmentNetWorthReport, getSavingsRateReport } from './investmentReports.ts';
import { saveLocalEnvValue } from './localEnv.ts';
import { getNetWorthReport } from './netWorth.ts';
import {
  categorizeTransactions,
  categorizeTransactionsByQuery,
  getTransactionCategorizationCoverage,
  getLatestTransactionCategoryUndoOperation,
  listTransactions,
  restoreTransactionCategories,
} from './transactions.ts';

const t = initTRPC.create();

const optionalId = z.union([z.string(), z.number()]).nullish();
const categoryInput = z.object({
  name: z.string().min(1),
  parentId: optionalId,
  type: z.string().nullish(),
  categoryGroup: z.string().nullish(),
  description: z.string().nullish(),
  color: z.string().nullish(),
  icon: z.string().nullish(),
});
const categoryUpdateInput = categoryInput.partial().extend({
  id: z.union([z.string(), z.number()]),
});
const accountMetadataInput = z.object({
  id: z.union([z.string(), z.number()]),
  changes: z.object({
    name: z.unknown().optional(),
    institution: z.unknown().optional(),
    type: z.unknown().optional(),
    currency: z.unknown().optional(),
    accountHolder: z.unknown().optional(),
  }),
});
const commitImportInput = z.object({
  accountId: optionalId,
  importFileId: optionalId,
  importRowIds: z.array(z.union([z.string(), z.number()])).nullish(),
  forceImportRowIds: z.array(z.union([z.string(), z.number()])).nullish(),
  balanceRowIds: z.array(z.union([z.string(), z.number()])).nullish(),
  transactions: z.array(z.unknown()).optional(),
  accountMappings: z.array(z.unknown()).nullish(),
  importMeta: z.any().nullish(),
});
const syncGoalInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current'), overlapDays: z.number().int().min(0).max(31).default(7) }),
  z.object({ kind: z.literal('backfill'), stopAt: z.string().optional() }),
  z.object({ kind: z.literal('range'), startDate: z.string(), endDate: z.string() }),
]);

function bytesFromBase64(value?: string | null) {
  if (!value) return new Uint8Array();
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

export const appRouter = t.router({
  accounts: t.router({
    list: t.procedure
      .input(z.object({
        includeArchived: z.boolean().optional(),
      }).optional())
      .query(({ input }) => listAccounts(input ?? {})),

    updateMetadata: t.procedure
      .input(accountMetadataInput)
      .mutation(({ input }) => updateAccountMetadata(input.id, input.changes)),

    archive: t.procedure
      .input(z.object({ id: z.union([z.string(), z.number()]) }))
      .mutation(({ input }) => archiveAccount(input.id)),

    markClosed: t.procedure
      .input(z.object({ id: z.union([z.string(), z.number()]) }))
      .mutation(({ input }) => closeAccount(input.id)),

    unarchive: t.procedure
      .input(z.object({ id: z.union([z.string(), z.number()]) }))
      .mutation(({ input }) => unarchiveAccount(input.id)),
  }),

  categories: t.router({
    list: t.procedure.query(() => listCategories()),

    create: t.procedure
      .input(categoryInput)
      .mutation(({ input }) => createCategory(input)),

    update: t.procedure
      .input(categoryUpdateInput)
      .mutation(({ input }) => {
        const { id, ...changes } = input;
        return updateCategory(id, changes);
      }),

    delete: t.procedure
      .input(z.object({ id: z.union([z.string(), z.number()]) }))
      .mutation(({ input }) => deleteCategory(input.id)),
  }),

  categorizationRules: t.router({
    list: t.procedure.query(() => listCategorizationRules()),

    create: t.procedure
      .input(z.object({
        categoryId: z.union([z.string(), z.number()]),
        pattern: z.string().min(1),
        matchType: z.string().nullish(),
        priority: z.union([z.string(), z.number()]).nullish(),
      }))
      .mutation(({ input }) => createCategorizationRule(input)),

    update: t.procedure
      .input(z.object({
        id: z.union([z.string(), z.number()]),
        categoryId: z.union([z.string(), z.number()]).optional(),
        pattern: z.string().optional(),
        matchType: z.string().nullish(),
        priority: z.union([z.string(), z.number()]).nullish(),
      }))
      .mutation(({ input }) => {
        const { id, ...changes } = input;
        return updateCategorizationRule(id, changes);
      }),

    delete: t.procedure
      .input(z.object({ id: z.union([z.string(), z.number()]) }))
      .mutation(({ input }) => deleteCategorizationRule(input.id)),
  }),

  budgets: t.router({
    list: t.procedure
      .input(z.object({ month: z.string().nullish() }).optional())
      .query(({ input }) => listBudgets(input ?? {})),

    report: t.procedure
      .input(z.object({
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
        month: z.string().nullish(),
        globalBudget: z.number().nullish(),
        categoryPercents: z.record(z.string(), z.number()).nullish(),
        periodScale: z.number().nullish(),
      }).optional())
      .query(({ input }) => getBudgetingReport(input ?? {})),

    set: t.procedure
      .input(z.object({
        categoryId: z.union([z.string(), z.number()]),
        month: z.string().min(1),
        amount: z.number(),
      }))
      .mutation(({ input }) => setBudget(input)),

    delete: t.procedure
      .input(z.object({ id: z.union([z.string(), z.number()]) }))
      .mutation(({ input }) => deleteBudget(input.id)),
  }),

  importProfiles: t.router({
    list: t.procedure.query(() => listImportProfiles()),

    upsert: t.procedure
      .input(z.object({
        headerSignature: z.string().min(1),
        profileName: z.string().nullish(),
        profileJson: z.string().min(1),
        mappingJson: z.string().nullish(),
        lastAccountId: optionalId,
      }))
      .mutation(({ input }) => upsertImportProfile(input)),
  }),

  imports: t.router({
    preview: t.procedure
      .input(z.object({
        fileName: z.string().min(1),
        text: z.string(),
        fileBase64: z.string().nullish(),
        customProfile: z.any().nullish(),
      }))
      .mutation(({ input }) => previewImport({
        fileName: input.fileName,
        text: input.text,
        fileBytes: bytesFromBase64(input.fileBase64),
        customProfile: input.customProfile,
      })),

    commit: t.procedure
      .input(commitImportInput)
      .mutation(({ input }) => commitImport(input as Parameters<typeof commitImport>[0])),

    history: t.procedure.query(() => ({ imports: listImportHistory() })),

    unimport: t.procedure
      .input(z.object({ importFileId: z.union([z.string(), z.number()]) }))
      .mutation(({ input }) => unimportFile(input.importFileId)),

    reimport: t.procedure
      .input(z.object({ importFileId: z.union([z.string(), z.number()]) }))
      .mutation(({ input }) => reimportFile(input.importFileId)),

    bulkUnimport: t.procedure
      .input(z.object({ importFileIds: z.array(z.union([z.string(), z.number()])) }))
      .mutation(({ input }) => unimportFiles(input.importFileIds)),

    bulkReimport: t.procedure
      .input(z.object({ importFileIds: z.array(z.union([z.string(), z.number()])) }))
      .mutation(({ input }) => reimportFiles(input.importFileIds)),
  }),

  dataFreshness: t.router({
    report: t.procedure
      .input(z.object({ today: z.string().optional() }).optional())
      .query(({ input }) => getDataFreshnessReport(input ?? {})),

    catchUp: t.procedure
      .input(z.object({ today: z.string().optional() }).optional())
      .query(({ input }) => getDataFreshnessReport(input ?? {}).catchUp),
  }),

  dataSync: t.router({
    targets: t.procedure.query(() => listSyncTargets()),

    start: t.procedure
      .input(z.object({
        institutionId: z.custom<SyncInstitutionId>(isSyncInstitutionId, 'Unsupported institution connector'),
        connectionId: z.string().optional(),
        goal: syncGoalInput,
      }))
      .mutation(({ input }) => startSyncJob(input)),

    status: t.procedure
      .input(z.object({ runId: z.string().min(1) }))
      .query(({ input }) => getSyncJob(input.runId)),

    cancel: t.procedure
      .input(z.object({ runId: z.string().min(1) }))
      .mutation(({ input }) => cancelSyncJob(input.runId)),

    confirm: t.procedure
      .input(z.object({ runId: z.string().min(1) }))
      .mutation(({ input }) => confirmSyncJob(input.runId)),

    discard: t.procedure
      .input(z.object({ runId: z.string().min(1) }))
      .mutation(({ input }) => discardSyncJob(input.runId)),
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

    categorizationCoverage: t.procedure
      .query(() => getTransactionCategorizationCoverage()),

    aiCategorizationPreview: t.procedure
      .input(z.object({
        limit: z.number().optional(),
        sort: z.enum(['count', 'money']).optional(),
      }).optional())
      .mutation(({ input }) => previewAiCategorization(input ?? {})),

    createMerchantGroupingRule: t.procedure
      .input(z.object({
        sourceMerchantKey: z.string().min(1),
        strategy: z.enum(['bank_description_counterparty', 'individual_transactions']).optional(),
      }))
      .mutation(({ input }) => createMerchantGroupingRule(input)),

    applyAiCategorization: t.procedure
      .input(z.object({
        suggestions: z.array(z.object({
          transactionId: z.string().min(1),
          categoryId: z.union([z.string(), z.number()]),
        })),
      }))
      .mutation(({ input }) => applyAiCategorizationSuggestions(input)),

    autoApplyAiCategorization: t.procedure
      .input(z.object({
        sort: z.enum(['count', 'money']).optional(),
      }).optional())
      .mutation(({ input }) => autoApplyAiCategorization(input ?? {})),

    startAutoApplyAiCategorization: t.procedure
      .input(z.object({
        sort: z.enum(['count', 'money']).optional(),
      }).optional())
      .mutation(({ input }) => startAutoApplyAiCategorizationJob(input ?? {})),

    autoApplyAiCategorizationJob: t.procedure
      .input(z.object({
        jobId: z.string().min(1),
      }))
      .query(({ input }) => getAutoApplyAiCategorizationJob(input)),

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

  reports: t.router({
    netWorth: t.procedure.query(() => getInvestmentNetWorthReport()),
    savingsRate: t.procedure.query(() => getSavingsRateReport()),
  }),

  analytics: t.router({
    report: t.procedure
      .input(z.object({
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
        accountId: optionalId,
        categoryFilterIds: z.array(z.union([z.string(), z.number()])).optional(),
        categoryFilterMode: z.enum(['include', 'exclude']).nullish(),
        groupMode: z.enum(['Auto', 'Daily', 'Weekly', 'Monthly', 'Yearly']).nullish(),
      }).optional())
      .query(({ input }) => getAnalyticsReport(input ?? {})),
  }),
});

export type AppRouter = typeof appRouter;
