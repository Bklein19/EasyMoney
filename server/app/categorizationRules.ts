import { deleteRow, insertRow, listRows, updateRow } from '../database.js';

function definedFields<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined));
}

export function listCategorizationRules() {
  return listRows('categorizationRules');
}

export function createCategorizationRule(input: {
  categoryId: number | string;
  pattern: string;
  matchType?: string | null;
  priority?: number | string | null;
}) {
  const id = Number(insertRow('categorizationRules', {
    categoryId: input.categoryId,
    pattern: input.pattern,
    matchType: input.matchType || 'contains',
    priority: input.priority ?? 0,
  }));
  return { id };
}

export function updateCategorizationRule(id: number | string, changes: {
  categoryId?: number | string;
  pattern?: string;
  matchType?: string | null;
  priority?: number | string | null;
}) {
  updateRow('categorizationRules', id, definedFields(changes));
  return { ok: true };
}

export function deleteCategorizationRule(id: number | string) {
  deleteRow('categorizationRules', id);
  return { ok: true };
}
