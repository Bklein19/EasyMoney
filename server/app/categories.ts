import { getDb, insertRow, updateRow } from '../database.js';
import type { CategoryListResponse, CategorySummary } from './types';

interface CategoryRow {
  id: number;
  name: string;
  parentId: number | null;
  type: string | null;
  categoryGroup: string | null;
  description: string | null;
  color: string | null;
  icon: string | null;
}

function toCategorySummary(row: CategoryRow): CategorySummary {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    type: row.type,
    categoryGroup: row.categoryGroup,
    description: row.description,
    color: row.color,
    icon: row.icon,
  };
}

function definedFields<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined));
}

export function listCategories(): CategoryListResponse {
  const rows = getDb()
    .prepare(
      `SELECT id, name, parentId, type, categoryGroup, description, color, icon
       FROM categories
       ORDER BY name ASC, id ASC`
    )
    .all() as CategoryRow[];

  return { categories: rows.map(toCategorySummary) };
}

type CategoryMutationInput = Omit<Partial<CategorySummary>, 'parentId'> & {
  parentId?: number | string | null;
};

export function createCategory(category: CategoryMutationInput) {
  const id = Number(insertRow('categories', {
    name: category.name,
    parentId: category.parentId ?? null,
    type: category.type ?? null,
    categoryGroup: category.categoryGroup ?? null,
    description: category.description ?? null,
    color: category.color ?? null,
    icon: category.icon ?? null,
  }));
  return { id };
}

export function updateCategory(id: number | string, changes: CategoryMutationInput) {
  updateRow('categories', id, definedFields({
    name: changes.name,
    parentId: changes.parentId,
    type: changes.type,
    categoryGroup: changes.categoryGroup,
    description: changes.description,
    color: changes.color,
    icon: changes.icon,
  }));
  return { ok: true };
}

export function deleteCategory(id: number | string) {
  const db = getDb();
  const uncategorized = db.prepare("SELECT id FROM categories WHERE name = 'Uncategorized'").get() as { id: number } | undefined;
  if (uncategorized && String(uncategorized.id) === String(id)) {
    throw new Error('Uncategorized cannot be deleted.');
  }

  db.transaction(() => {
    if (uncategorized) {
      db.prepare('UPDATE transactionAnnotations SET categoryId = ? WHERE categoryId = ?').run(uncategorized.id, id);
    }
    db.prepare('DELETE FROM categorizationRules WHERE categoryId = ?').run(id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  })();

  return { ok: true };
}
