import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { listAccounts } from './accounts.ts';
import { listCategories } from './categories.ts';
import { upsertTransactionAnnotation } from './transactionAnnotations.ts';
import { listTransactions } from './transactions.ts';

const t = initTRPC.create();

const optionalId = z.union([z.string(), z.number()]).nullish();

export const appRouter = t.router({
  accounts: t.router({
    list: t.procedure.query(() => listAccounts()),
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
      }).optional())
      .query(({ input }) => listTransactions(input ?? {})),

    updateAnnotation: t.procedure
      .input(z.object({
        id: z.union([z.string(), z.number()]),
        categoryId: optionalId,
        notes: z.string().nullable().optional(),
      }))
      .mutation(({ input }) => {
        const ledgerTransactionId = upsertTransactionAnnotation(input.id, {
          categoryId: input.categoryId,
          notes: input.notes,
        });
        return { ok: true, ledgerTransactionId };
      }),
  }),
});

export type AppRouter = typeof appRouter;
