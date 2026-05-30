import { add, apiAction, remove, update } from '../db/api';
import { useApiTable } from './useApiTable';

export function useCategories() {
  const categories = useApiTable('categories');
  const rules = useApiTable('categorizationRules');

  async function addCategory(category) {
    return add('categories', category);
  }

  async function updateCategory(id, changes) {
    return update('categories', id, changes);
  }

  async function deleteCategory(id) {
    return apiAction(`/categories/${id}/delete`, { method: 'POST' });
  }

  async function addRule(rule) {
    return add('categorizationRules', rule);
  }

  async function deleteRule(id) {
    return remove('categorizationRules', id);
  }

  const expenseCategories = categories.filter(c => c.type === 'expense');
  const incomeCategories = categories.filter(c => c.type === 'income');

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
  };
}
