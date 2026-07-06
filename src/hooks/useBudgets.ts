import { useQuery } from '@tanstack/react-query';
import { queryClient, trpc, trpcClient } from '../api/trpc';

export function useBudgets(month?: string) {
  const budgetsQuery = useQuery(trpc.budgets.list.queryOptions(month ? { month } : {}));

  async function setBudget(categoryId: number | string, amount: number) {
    const result = await trpcClient.budgets.set.mutate({ categoryId, month: month || '', amount });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.budgets.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.budgets.report.queryKey() }),
    ]);
    return result;
  }

  async function deleteBudget(id: number | string) {
    const result = await trpcClient.budgets.delete.mutate({ id });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.budgets.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.budgets.report.queryKey() }),
    ]);
    return result;
  }

  return {
    budgets: budgetsQuery.data ?? [],
    setBudget,
    deleteBudget,
    isLoading: budgetsQuery.isLoading,
    isFetching: budgetsQuery.isFetching,
    error: budgetsQuery.error,
  };
}
