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
  const existingCategories = db
    .prepare('SELECT id, name FROM categories')
    .all() as ExistingCategoryRow[];
  const categoryIds = Object.fromEntries(
    existingCategories.map((category) => [category.name.toLowerCase(), category.id]),
  );
  const createdNames = new Set<string>();

  db.transaction(() => {
    for (const category of DEFAULT_CATEGORIES) {
      const key = category.name.toLowerCase();
      if (!categoryIds[key]) {
        categoryIds[key] = Number(
          insertRow('categories', {
            name: category.name,
            type: category.type,
            categoryGroup: category.categoryGroup,
            color: category.color,
            icon: category.icon,
            description: category.description ?? null,
          }),
        );
        createdNames.add(key);
      } else {
        db.prepare(
          `
          UPDATE categories
          SET categoryGroup = COALESCE(NULLIF(categoryGroup, ''), ?)
          WHERE id = ?
        `,
        ).run(category.categoryGroup, categoryIds[key]);
      }
    }

    // Adopt the new hierarchy once, without changing any transaction assignments.
    // Later launches must preserve parents and descriptions the user has edited.
    const migration = 'income-subcategories-v1';
    const isFirstRun = !db
      .prepare('SELECT name FROM schemaMigrations WHERE name = ?')
      .get(migration);
    for (const category of DEFAULT_CATEGORIES) {
      if (!category.parentName || (!isFirstRun && !createdNames.has(category.name.toLowerCase())))
        continue;
      const id = categoryIds[category.name.toLowerCase()];
      const parentId = categoryIds[category.parentName.toLowerCase()];
      // Older metadata can already place Income below one of these categories.
      // Do not create a cycle while adopting defaults.
      const wouldCycle = db
        .prepare(
          `WITH RECURSIVE ancestors(id, parentId) AS (
        SELECT id, parentId FROM categories WHERE id = ?
        UNION SELECT c.id, c.parentId FROM categories c JOIN ancestors a ON c.id = a.parentId
      ) SELECT id FROM ancestors WHERE id = ?`,
        )
        .get(parentId, id);
      if (wouldCycle) continue;
      db.prepare(
        `UPDATE categories
        SET parentId = COALESCE(parentId, ?), description = COALESCE(NULLIF(description, ''), ?)
        WHERE id = ? AND type = ? AND EXISTS (SELECT 1 FROM categories WHERE id = ? AND type = ?)`,
      ).run(parentId, category.description ?? null, id, category.type, parentId, category.type);
    }
    if (isFirstRun)
      db.prepare('INSERT INTO schemaMigrations (name, appliedAt) VALUES (?, ?)').run(
        migration,
        new Date().toISOString(),
      );

    const existingRuleKeys = new Set(
      (
        db.prepare('SELECT pattern, categoryId FROM categorizationRules').all() as ExistingRuleRow[]
      ).map((rule) => `${rule.pattern}:${rule.categoryId}`),
    );

    for (const [pattern, categoryName, priority] of DEFAULT_RULES) {
      const categoryId = categoryIds[categoryName.toLowerCase()];
      const key = `${pattern}:${categoryId}`;
      if (!categoryId || existingRuleKeys.has(key)) continue;
      insertRow('categorizationRules', { pattern, categoryId, priority, matchType: 'contains' });
    }
  })();
}
