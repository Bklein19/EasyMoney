// @ts-nocheck
import { getDb, insertRow } from './database.ts';

const DEFAULT_CATEGORIES = [
  { name: 'Food & Dining', icon: 'utensils', color: '#f97316', type: 'expense', categoryGroup: 'discretionary' },
  { name: 'Groceries', icon: 'shopping-cart', color: '#22c55e', type: 'expense', categoryGroup: 'variable' },
  { name: 'Housing', icon: 'home', color: '#6366f1', type: 'expense', categoryGroup: 'fixed' },
  { name: 'Transportation', icon: 'car', color: '#3b82f6', type: 'expense', categoryGroup: 'variable' },
  { name: 'Shopping', icon: 'shopping-bag', color: '#ec4899', type: 'expense', categoryGroup: 'discretionary' },
  { name: 'Health', icon: 'heart-pulse', color: '#ef4444', type: 'expense', categoryGroup: 'variable' },
  { name: 'Entertainment', icon: 'film', color: '#a855f7', type: 'expense', categoryGroup: 'discretionary' },
  { name: 'Utilities', icon: 'zap', color: '#eab308', type: 'expense', categoryGroup: 'fixed' },
  { name: 'Education', icon: 'graduation-cap', color: '#14b8a6', type: 'expense', categoryGroup: 'variable' },
  { name: 'Travel', icon: 'plane', color: '#06b6d4', type: 'expense', categoryGroup: 'discretionary' },
  { name: 'Personal Care', icon: 'smile', color: '#f472b6', type: 'expense', categoryGroup: 'variable' },
  { name: 'Insurance', icon: 'shield', color: '#8b5cf6', type: 'expense', categoryGroup: 'fixed' },
  { name: 'Gifts & Donations', icon: 'gift', color: '#fb923c', type: 'expense', categoryGroup: 'discretionary' },
  { name: 'Subscriptions', icon: 'repeat', color: '#7c3aed', type: 'expense', categoryGroup: 'fixed' },
  { name: 'Income', icon: 'banknote', color: '#10b981', type: 'income', categoryGroup: 'income' },
  { name: 'Transfer', icon: 'arrow-left-right', color: '#64748b', type: 'transfer', categoryGroup: 'transfer' },
  { name: 'Internal Transfer', icon: 'shuffle', color: '#94a3b8', type: 'internal_transfer', categoryGroup: 'transfer' },
  { name: 'Investment', icon: 'trending-up', color: '#f59e0b', type: 'investment', categoryGroup: 'savings_investment' },
  { name: 'Uncategorized', icon: 'help-circle', color: '#94a3b8', type: 'expense', categoryGroup: 'other' }
];

const DEFAULT_RULES = [
  ['starbucks', 'Food & Dining', 10], ['mcdonald', 'Food & Dining', 10], ['chipotle', 'Food & Dining', 10],
  ['doordash', 'Food & Dining', 10], ['uber eats', 'Food & Dining', 10], ['restaurant', 'Food & Dining', 10],
  ['coffee', 'Food & Dining', 6], ['cafe', 'Food & Dining', 6],
  ['walmart', 'Groceries', 10], ['costco', 'Groceries', 10], ['trader joe', 'Groceries', 10],
  ['whole foods', 'Groceries', 10], ['kroger', 'Groceries', 10], ['safeway', 'Groceries', 10],
  ['grocery', 'Groceries', 10], ['market', 'Groceries', 4],
  ['shell', 'Transportation', 10], ['chevron', 'Transportation', 10], ['exxon', 'Transportation', 10],
  ['uber', 'Transportation', 5], ['lyft', 'Transportation', 10], ['parking', 'Transportation', 10],
  ['gas', 'Transportation', 5], ['fuel', 'Transportation', 8],
  ['amazon', 'Shopping', 5], ['target', 'Shopping', 5], ['best buy', 'Shopping', 10],
  ['home depot', 'Shopping', 10], ['lowes', 'Shopping', 10],
  ['netflix', 'Entertainment', 10], ['spotify', 'Entertainment', 10], ['hulu', 'Entertainment', 10],
  ['youtube', 'Entertainment', 10], ['steam', 'Entertainment', 10],
  ['cvs', 'Health', 10], ['walgreens', 'Health', 10], ['pharmacy', 'Health', 10],
  ['electric', 'Utilities', 10], ['comcast', 'Utilities', 10], ['xfinity', 'Utilities', 10],
  ['verizon', 'Utilities', 10], ['internet', 'Utilities', 8],
  ['rent', 'Housing', 5], ['mortgage', 'Housing', 10],
  ['airbnb', 'Travel', 10], ['hotel', 'Travel', 8], ['marriott', 'Travel', 10],
  ['salon', 'Personal Care', 8], ['barber', 'Personal Care', 8],
  ['insurance', 'Insurance', 5], ['geico', 'Insurance', 10],
  ['subscription', 'Subscriptions', 8], ['membership', 'Subscriptions', 8],
  ['payroll', 'Income', 10], ['direct dep', 'Income', 10], ['salary', 'Income', 10], ['direct deposit', 'Income', 10],
  ['transfer', 'Transfer', 3], ['zelle', 'Transfer', 10], ['venmo', 'Transfer', 10], ['cashapp', 'Transfer', 10],
  ['investment', 'Investment', 8], ['contribution', 'Investment', 8],
  ['robinhood transfer', 'Investment', 20], ['brokerage transfer', 'Investment', 20],
  ['credit card payment', 'Internal Transfer', 20]
];

export function seedDatabase() {
  const db = getDb();
  const existingCategories = db.prepare('SELECT id, name FROM categories').all();
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
    db.prepare('SELECT pattern, categoryId FROM categorizationRules').all()
      .map(rule => `${rule.pattern}:${rule.categoryId}`)
  );

  for (const [pattern, categoryName, priority] of DEFAULT_RULES) {
    const categoryId = categoryIds[categoryName];
    const key = `${pattern}:${categoryId}`;
    if (!categoryId || existingRuleKeys.has(key)) continue;
    insertRow('categorizationRules', { pattern, categoryId, priority, matchType: 'contains' });
  }
}
