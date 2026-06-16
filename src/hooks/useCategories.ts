import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { add, apiAction, remove, update } from '../db/api';
import { queryClient, trpc } from '../api/trpc';
import { subscribeToDataChanges } from '../db/api';
import { useApiTable } from './useApiTable';

export function useCategories() {
  const categoriesQuery = useQuery(trpc.categories.list.queryOptions());
  const rules = useApiTable('categorizationRules');

  useEffect(() => {
    const unsubscribe = subscribeToDataChanges(() => {
      queryClient.invalidateQueries({ queryKey: trpc.categories.list.queryKey() });
    });
    return () => {
      unsubscribe();
    };
  }, []);

  const categories = useMemo(() => categoriesQuery.data?.categories ?? [], [categoriesQuery.data]);

  async function addCategory(category: Record<string, unknown>) {
    return add('categories', category);
  }

  async function updateCategory(id: number | string, changes: Record<string, unknown>) {
    return update('categories', id, changes);
  }

  async function deleteCategory(id: number | string) {
    return apiAction(`/categories/${id}/delete`, { method: 'POST' });
  }

  async function addRule(rule: Record<string, unknown>) {
    return add('categorizationRules', rule);
  }

  async function deleteRule(id: number | string) {
    return remove('categorizationRules', id);
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
    isFetching: categoriesQuery.isFetching,
    error: categoriesQuery.error,
  };
}
