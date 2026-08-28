import { getDb, insertRow } from './database.ts';
import { DEFAULT_CATEGORIES, DEFAULT_RULES } from './defaultSeedData.ts';

interface ExistingCategoryRow {
  id: number;
  name: string;
}

interface ExistingRuleRow {
  pattern: string;
  categoryId: number;
}

export function seedDatabase() {
  const db = getDb();
  const existingCategories = db.prepare('SELECT id, name FROM categories').all() as ExistingCategoryRow[];
  const categoryIds = Object.fromEntries(existingCategories.map(category => [category.name, category.id]));

  for (const category of DEFAULT_CATEGORIES) {
    if (!categoryIds[category.name]) {
      categoryIds[category.name] = insertRow('categories', category);
    } else {
      db.prepare(`
        UPDATE categories
        SET categoryGroup = COALESCE(NULLIF(categoryGroup, ''), ?)
        WHERE name = ?
      `).run(category.categoryGroup, category.name);
    }
  }

  const existingRuleKeys = new Set(
    (db.prepare('SELECT pattern, categoryId FROM categorizationRules').all() as ExistingRuleRow[])
      .map(rule => `${rule.pattern}:${rule.categoryId}`)
  );

  for (const [pattern, categoryName, priority] of DEFAULT_RULES) {
    const categoryId = categoryIds[categoryName];
    const key = `${pattern}:${categoryId}`;
    if (!categoryId || existingRuleKeys.has(key)) continue;
    insertRow('categorizationRules', { pattern, categoryId, priority, matchType: 'contains' });
  }
}
