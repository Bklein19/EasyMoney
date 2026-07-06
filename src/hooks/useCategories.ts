import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryClient, trpc, trpcClient } from '../api/trpc';

export function useCategories() {
  const categoriesQuery = useQuery(trpc.categories.list.queryOptions());
  const rulesQuery = useQuery(trpc.categorizationRules.list.queryOptions());

  const categories = useMemo(() => categoriesQuery.data?.categories ?? [], [categoriesQuery.data]);
  const rules = rulesQuery.data ?? [];

  async function addCategory(category: Record<string, unknown>) {
    const result = await trpcClient.categories.create.mutate(category as Parameters<typeof trpcClient.categories.create.mutate>[0]);
    await queryClient.invalidateQueries({ queryKey: trpc.categories.list.queryKey() });
    return result.id;
  }

  async function updateCategory(id: number | string, changes: Record<string, unknown>) {
    const result = await trpcClient.categories.update.mutate({ id, ...changes } as Parameters<typeof trpcClient.categories.update.mutate>[0]);
    await queryClient.invalidateQueries({ queryKey: trpc.categories.list.queryKey() });
    return result;
  }

  async function deleteCategory(id: number | string) {
    const result = await trpcClient.categories.delete.mutate({ id });
    await queryClient.invalidateQueries({ queryKey: trpc.categories.list.queryKey() });
    await queryClient.invalidateQueries({ queryKey: trpc.categorizationRules.list.queryKey() });
    return result;
  }

  async function addRule(rule: Record<string, unknown>) {
    const result = await trpcClient.categorizationRules.create.mutate(rule as Parameters<typeof trpcClient.categorizationRules.create.mutate>[0]);
    await queryClient.invalidateQueries({ queryKey: trpc.categorizationRules.list.queryKey() });
    return result.id;
  }

  async function deleteRule(id: number | string) {
    const result = await trpcClient.categorizationRules.delete.mutate({ id });
    await queryClient.invalidateQueries({ queryKey: trpc.categorizationRules.list.queryKey() });
    return result;
  }

  const expenseCategories = categories.filter(category => category.type === 'expense');
  const incomeCategories = categories.filter(category => category.type === 'income');

  return {
    categories,
    rules,
    expenseCategories,
    incomeCategories,
    addCategory,
    updateCategory,
    deleteCategory,
    addRule,
    deleteRule,
    isLoading: categoriesQuery.isLoading,
    isFetching: categoriesQuery.isFetching || rulesQuery.isFetching,
    error: categoriesQuery.error || rulesQuery.error,
  };
}
