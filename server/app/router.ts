import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { listAccounts } from './accounts.ts';
import { listCategories } from './categories.ts';
import { getNetWorthReport } from './netWorth.ts';
import { categorizeTransactions, listTransactions } from './transactions.ts';

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
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
        search: z.string().nullish(),
        type: z.string().nullish(),
        limit: optionalId,
        includeArchived: z.boolean().nullish(),
      }).optional())
      .query(({ input }) => listTransactions(input ?? {})),

    categorize: t.procedure
      .input(z.object({
        transactionIds: z.array(z.union([z.string(), z.number()])).min(1),
        categoryId: optionalId,
      }))
      .mutation(({ input }) => categorizeTransactions(input)),
  }),

  netWorth: t.router({
    report: t.procedure.query(() => getNetWorthReport()),
  }),
});

export type AppRouter = typeof appRouter;
