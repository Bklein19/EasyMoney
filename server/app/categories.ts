import { getDb } from '../database.js';
import type { CategoryListResponse, CategorySummary } from './types';

interface CategoryRow {
  id: number;
  name: string;
  parentId: number | null;
  type: string | null;
  color: string | null;
  icon: string | null;
}

function toCategorySummary(row: CategoryRow): CategorySummary {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    type: row.type,
    color: row.color,
    icon: row.icon,
  };
}

export function listCategories(): CategoryListResponse {
  const rows = getDb()
    .prepare(
      `SELECT id, name, parentId, type, color, icon
       FROM categories
       ORDER BY name ASC, id ASC`
    )
    .all() as CategoryRow[];

  return { categories: rows.map(toCategorySummary) };
}
