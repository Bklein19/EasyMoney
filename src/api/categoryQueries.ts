import type { QueryClient } from '@tanstack/react-query';
import { queryClient, trpc } from './trpc';

/** Refresh category-dependent views, not account freshness, parser maintenance, or sync jobs. */
export async function refreshCategoryData(client: QueryClient = queryClient) {
  await Promise.all(
    [
      trpc.categories.pathKey(),
      trpc.transactions.pathKey(),
      trpc.analytics.pathKey(),
      trpc.budgets.pathKey(),
      trpc.netWorth.pathKey(),
      trpc.reports.pathKey(),
      ['app', 'transactions', 'infinite'],
    ].map((queryKey) => client.invalidateQueries({ queryKey })),
  );
}
