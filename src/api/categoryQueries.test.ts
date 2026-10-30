import { expect, mock, test } from 'bun:test';
import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';

mock.module('electrobun/view', () => ({ Electroview: class {} }));
const { refreshCategoryData } = await import('./categoryQueries');
const { trpc } = await import('./trpc');

test('category changes invalidate affected reports and transactions without refreshing unrelated app services', async () => {
  const client = new QueryClient();
  const affected: QueryKey[] = [
    trpc.categories.merchantQueue.queryKey(),
    trpc.transactions.list.queryKey(),
    trpc.analytics.report.queryKey(),
    trpc.budgets.report.queryKey(),
    trpc.netWorth.report.queryKey(),
    trpc.reports.savingsRate.queryKey(),
    ['app', 'transactions', 'infinite', 'page'],
  ];
  const unaffected: QueryKey[] = [
    trpc.accounts.list.queryKey(),
    trpc.dataFreshness.report.queryKey(),
    trpc.imports.parserRefreshStatus.queryKey(),
    trpc.dataSync.jobs.queryKey(),
    trpc.backups.list.queryKey(),
  ];
  for (const key of [...affected, ...unaffected]) client.setQueryData(key, 'cached');
  let unrelatedFetches = 0;
  const observer = new QueryObserver(client, {
    queryKey: unaffected[0]!,
    queryFn: async () => {
      unrelatedFetches++;
      return 'cached';
    },
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await refreshCategoryData(client);
    for (const key of affected) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    for (const key of unaffected) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    expect(unrelatedFetches).toBe(0);
  } finally {
    unsubscribe();
    client.clear();
  }
});
