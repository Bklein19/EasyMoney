import { apiAction, remove } from '../db/api';
import { useApiTable } from './useApiTable';

export function useBudgets(month) {
  const budgets = useApiTable('budgets', month ? { month } : {}, [month]);

  async function setBudget(categoryId, amount) {
    return apiAction('/budgets/set', {
      method: 'POST',
      body: JSON.stringify({ categoryId, month, amount })
    });
  }

  async function deleteBudget(id) {
    return remove('budgets', id);
  }

  return { budgets, setBudget, deleteBudget };
}
