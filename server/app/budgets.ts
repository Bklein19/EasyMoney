import { deleteRow, getDb, insertRow, listRows, updateRow } from '../database.ts';

export function listBudgets(options: { month?: string | null } = {}) {
  return listRows('budgets', options.month ? { month: options.month } : {});
}

export function setBudget(input: { categoryId: number | string; month: string; amount: number }) {
  const categoryId = Number(input.categoryId);
  const amount = Number(input.amount);
  if (!Number.isFinite(categoryId)) throw new Error('Invalid category id');
  if (!input.month) throw new Error('Budget month is required');
  if (!Number.isFinite(amount)) throw new Error('Invalid budget amount');

  const existing = getDb().prepare('SELECT id FROM budgets WHERE categoryId = ? AND month = ?').get(categoryId, input.month) as
    | { id: number }
    | undefined;

  if (existing && amount <= 0) {
    deleteRow('budgets', existing.id);
    return { ok: true };
  }
  if (existing) {
    updateRow('budgets', existing.id, { amount });
    return { id: existing.id };
  }
  if (amount <= 0) {
    return { ok: true };
  }

  const id = Number(insertRow('budgets', { categoryId, month: input.month, amount }));
  return { id };
}

export function deleteBudget(id: number | string) {
  deleteRow('budgets', id);
  return { ok: true };
}
