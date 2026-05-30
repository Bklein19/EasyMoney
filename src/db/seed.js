import db from './database';

const DEFAULT_CATEGORIES = [
  { name: 'Food & Dining',   icon: 'utensils',         color: '#f97316', type: 'expense' },
  { name: 'Groceries',       icon: 'shopping-cart',     color: '#22c55e', type: 'expense' },
  { name: 'Housing',         icon: 'home',              color: '#6366f1', type: 'expense' },
  { name: 'Transportation',  icon: 'car',               color: '#3b82f6', type: 'expense' },
  { name: 'Shopping',        icon: 'shopping-bag',      color: '#ec4899', type: 'expense' },
  { name: 'Health',          icon: 'heart-pulse',       color: '#ef4444', type: 'expense' },
  { name: 'Entertainment',   icon: 'film',              color: '#a855f7', type: 'expense' },
  { name: 'Utilities',       icon: 'zap',               color: '#eab308', type: 'expense' },
  { name: 'Education',       icon: 'graduation-cap',    color: '#14b8a6', type: 'expense' },
  { name: 'Travel',          icon: 'plane',             color: '#06b6d4', type: 'expense' },
  { name: 'Personal Care',   icon: 'smile',             color: '#f472b6', type: 'expense' },
  { name: 'Insurance',       icon: 'shield',            color: '#8b5cf6', type: 'expense' },
  { name: 'Gifts & Donations', icon: 'gift',            color: '#fb923c', type: 'expense' },
  { name: 'Subscriptions',   icon: 'repeat',            color: '#7c3aed', type: 'expense' },
  { name: 'Income',          icon: 'banknote',          color: '#10b981', type: 'income' },
  { name: 'Transfer',        icon: 'arrow-left-right',  color: '#64748b', type: 'transfer' },
  { name: 'Internal Transfer', icon: 'shuffle',          color: '#94a3b8', type: 'internal_transfer' },
  { name: 'Investment',      icon: 'trending-up',       color: '#f59e0b', type: 'investment' },
  { name: 'Uncategorized',   icon: 'help-circle',       color: '#94a3b8', type: 'expense' },
];

const DEFAULT_RULES = [
  // Food & Dining
  { pattern: 'starbucks',       matchType: 'contains', priority: 10 },
  { pattern: 'mcdonald',        matchType: 'contains', priority: 10 },
  { pattern: 'chipotle',        matchType: 'contains', priority: 10 },
  { pattern: 'doordash',        matchType: 'contains', priority: 10 },
  { pattern: 'uber eats',       matchType: 'contains', priority: 10 },
  { pattern: 'grubhub',         matchType: 'contains', priority: 10 },
  { pattern: 'chick-fil-a',     matchType: 'contains', priority: 10 },
  { pattern: 'subway',          matchType: 'contains', priority: 10 },
  { pattern: 'pizza',           matchType: 'contains', priority: 10 },
  { pattern: 'restaurant',      matchType: 'contains', priority: 10 },
  { pattern: 'taco bell',       matchType: 'contains', priority: 10 },
  { pattern: 'wendy',           matchType: 'contains', priority: 10 },
  { pattern: 'panera',          matchType: 'contains', priority: 10 },
  { pattern: 'dunkin',          matchType: 'contains', priority: 10 },
  { pattern: 'coffee',          matchType: 'contains', priority: 6 },
  { pattern: 'cafe',            matchType: 'contains', priority: 6 },
  { pattern: 'bar and grill',   matchType: 'contains', priority: 8 },
  // Groceries
  { pattern: 'walmart',         matchType: 'contains', priority: 10, categoryName: 'Groceries' },
  { pattern: 'costco',          matchType: 'contains', priority: 10, categoryName: 'Groceries' },
  { pattern: 'trader joe',      matchType: 'contains', priority: 10, categoryName: 'Groceries' },
  { pattern: 'whole foods',     matchType: 'contains', priority: 10, categoryName: 'Groceries' },
  { pattern: 'kroger',          matchType: 'contains', priority: 10, categoryName: 'Groceries' },
  { pattern: 'safeway',         matchType: 'contains', priority: 10, categoryName: 'Groceries' },
  { pattern: 'aldi',            matchType: 'contains', priority: 10, categoryName: 'Groceries' },
  { pattern: 'publix',          matchType: 'contains', priority: 10, categoryName: 'Groceries' },
  { pattern: 'grocery',         matchType: 'contains', priority: 10, categoryName: 'Groceries' },
  { pattern: 'market',          matchType: 'contains', priority: 4, categoryName: 'Groceries' },
  { pattern: 'supermarket',     matchType: 'contains', priority: 10, categoryName: 'Groceries' },
  { pattern: 'food lion',       matchType: 'contains', priority: 10, categoryName: 'Groceries' },
  { pattern: 'meijer',          matchType: 'contains', priority: 10, categoryName: 'Groceries' },
  { pattern: 'heb',             matchType: 'contains', priority: 10, categoryName: 'Groceries' },
  { pattern: 'wegmans',         matchType: 'contains', priority: 10, categoryName: 'Groceries' },
  // Transportation
  { pattern: 'shell',           matchType: 'contains', priority: 10, categoryName: 'Transportation' },
  { pattern: 'chevron',         matchType: 'contains', priority: 10, categoryName: 'Transportation' },
  { pattern: 'exxon',           matchType: 'contains', priority: 10, categoryName: 'Transportation' },
  { pattern: 'uber',            matchType: 'contains', priority: 5, categoryName: 'Transportation' },
  { pattern: 'lyft',            matchType: 'contains', priority: 10, categoryName: 'Transportation' },
  { pattern: 'parking',         matchType: 'contains', priority: 10, categoryName: 'Transportation' },
  { pattern: 'gas',             matchType: 'contains', priority: 5, categoryName: 'Transportation' },
  { pattern: 'fuel',            matchType: 'contains', priority: 8, categoryName: 'Transportation' },
  { pattern: 'toll',            matchType: 'contains', priority: 8, categoryName: 'Transportation' },
  { pattern: 'transit',         matchType: 'contains', priority: 8, categoryName: 'Transportation' },
  { pattern: 'amtrak',          matchType: 'contains', priority: 10, categoryName: 'Transportation' },
  // Shopping
  { pattern: 'amazon',          matchType: 'contains', priority: 5, categoryName: 'Shopping' },
  { pattern: 'target',          matchType: 'contains', priority: 5, categoryName: 'Shopping' },
  { pattern: 'best buy',        matchType: 'contains', priority: 10, categoryName: 'Shopping' },
  { pattern: 'apple.com',       matchType: 'contains', priority: 10, categoryName: 'Shopping' },
  { pattern: 'lowes',           matchType: 'contains', priority: 10, categoryName: 'Shopping' },
  { pattern: 'home depot',      matchType: 'contains', priority: 10, categoryName: 'Shopping' },
  { pattern: 'ikea',            matchType: 'contains', priority: 10, categoryName: 'Shopping' },
  { pattern: 'ebay',            matchType: 'contains', priority: 10, categoryName: 'Shopping' },
  { pattern: 'etsy',            matchType: 'contains', priority: 10, categoryName: 'Shopping' },
  // Entertainment
  { pattern: 'netflix',         matchType: 'contains', priority: 10, categoryName: 'Entertainment' },
  { pattern: 'spotify',         matchType: 'contains', priority: 10, categoryName: 'Entertainment' },
  { pattern: 'hulu',            matchType: 'contains', priority: 10, categoryName: 'Entertainment' },
  { pattern: 'disney+',         matchType: 'contains', priority: 10, categoryName: 'Entertainment' },
  { pattern: 'youtube',         matchType: 'contains', priority: 10, categoryName: 'Entertainment' },
  { pattern: 'hbo',             matchType: 'contains', priority: 10, categoryName: 'Entertainment' },
  { pattern: 'amc',             matchType: 'contains', priority: 10, categoryName: 'Entertainment' },
  { pattern: 'steam',           matchType: 'contains', priority: 10, categoryName: 'Entertainment' },
  { pattern: 'playstation',     matchType: 'contains', priority: 10, categoryName: 'Entertainment' },
  { pattern: 'audible',         matchType: 'contains', priority: 10, categoryName: 'Entertainment' },
  { pattern: 'ticketmaster',    matchType: 'contains', priority: 10, categoryName: 'Entertainment' },
  // Health
  { pattern: 'cvs',             matchType: 'contains', priority: 10, categoryName: 'Health' },
  { pattern: 'walgreens',       matchType: 'contains', priority: 10, categoryName: 'Health' },
  { pattern: 'pharmacy',        matchType: 'contains', priority: 10, categoryName: 'Health' },
  { pattern: 'doctor',          matchType: 'contains', priority: 10, categoryName: 'Health' },
  { pattern: 'hospital',        matchType: 'contains', priority: 10, categoryName: 'Health' },
  // Utilities
  { pattern: 'electric',        matchType: 'contains', priority: 10, categoryName: 'Utilities' },
  { pattern: 'water bill',      matchType: 'contains', priority: 10, categoryName: 'Utilities' },
  { pattern: 'comcast',         matchType: 'contains', priority: 10, categoryName: 'Utilities' },
  { pattern: 'xfinity',         matchType: 'contains', priority: 10, categoryName: 'Utilities' },
  { pattern: 'at&t',            matchType: 'contains', priority: 10, categoryName: 'Utilities' },
  { pattern: 'verizon',         matchType: 'contains', priority: 10, categoryName: 'Utilities' },
  { pattern: 't-mobile',        matchType: 'contains', priority: 10, categoryName: 'Utilities' },
  { pattern: 'phone bill',      matchType: 'contains', priority: 10, categoryName: 'Utilities' },
  { pattern: 'internet',        matchType: 'contains', priority: 8, categoryName: 'Utilities' },
  { pattern: 'utility',         matchType: 'contains', priority: 8, categoryName: 'Utilities' },
  // Housing
  { pattern: 'rent',            matchType: 'contains', priority: 5, categoryName: 'Housing' },
  { pattern: 'mortgage',        matchType: 'contains', priority: 10, categoryName: 'Housing' },
  { pattern: 'hoa',             matchType: 'contains', priority: 10, categoryName: 'Housing' },
  { pattern: 'apartment',       matchType: 'contains', priority: 8, categoryName: 'Housing' },
  { pattern: 'landlord',        matchType: 'contains', priority: 8, categoryName: 'Housing' },
  // Travel
  { pattern: 'airbnb',          matchType: 'contains', priority: 10, categoryName: 'Travel' },
  { pattern: 'hotel',           matchType: 'contains', priority: 8, categoryName: 'Travel' },
  { pattern: 'marriott',        matchType: 'contains', priority: 10, categoryName: 'Travel' },
  { pattern: 'hyatt',           matchType: 'contains', priority: 10, categoryName: 'Travel' },
  { pattern: 'delta',           matchType: 'contains', priority: 8, categoryName: 'Travel' },
  { pattern: 'southwest',       matchType: 'contains', priority: 8, categoryName: 'Travel' },
  { pattern: 'united airlines', matchType: 'contains', priority: 10, categoryName: 'Travel' },
  // Personal Care
  { pattern: 'salon',           matchType: 'contains', priority: 8, categoryName: 'Personal Care' },
  { pattern: 'barber',          matchType: 'contains', priority: 8, categoryName: 'Personal Care' },
  { pattern: 'spa',             matchType: 'contains', priority: 8, categoryName: 'Personal Care' },
  // Subscriptions
  { pattern: 'subscription',    matchType: 'contains', priority: 8, categoryName: 'Subscriptions' },
  { pattern: 'membership',      matchType: 'contains', priority: 8, categoryName: 'Subscriptions' },
  // Income
  { pattern: 'payroll',         matchType: 'contains', priority: 10, categoryName: 'Income' },
  { pattern: 'direct dep',      matchType: 'contains', priority: 10, categoryName: 'Income' },
  { pattern: 'salary',          matchType: 'contains', priority: 10, categoryName: 'Income' },
  { pattern: 'direct deposit',  matchType: 'contains', priority: 10, categoryName: 'Income' },
  // Transfers
  { pattern: 'transfer',        matchType: 'contains', priority: 3, categoryName: 'Transfer' },
  { pattern: 'zelle',           matchType: 'contains', priority: 10, categoryName: 'Transfer' },
  { pattern: 'venmo',           matchType: 'contains', priority: 10, categoryName: 'Transfer' },
  { pattern: 'cashapp',         matchType: 'contains', priority: 10, categoryName: 'Transfer' },
  { pattern: 'investment',    matchType: 'contains', priority: 8, categoryName: 'Investment' },
  { pattern: 'contribution',  matchType: 'contains', priority: 8, categoryName: 'Investment' },
  { pattern: 'robinhood transfer', matchType: 'contains', priority: 20, categoryName: 'Investment' },
  { pattern: 'brokerage transfer', matchType: 'contains', priority: 20, categoryName: 'Investment' },
  { pattern: 'credit card payment', matchType: 'contains', priority: 20, categoryName: 'Internal Transfer' },
  // Insurance
  { pattern: 'geico',           matchType: 'contains', priority: 10, categoryName: 'Insurance' },
  { pattern: 'state farm',      matchType: 'contains', priority: 10, categoryName: 'Insurance' },
  { pattern: 'allstate',        matchType: 'contains', priority: 10, categoryName: 'Insurance' },
  { pattern: 'insurance',       matchType: 'contains', priority: 5, categoryName: 'Insurance' },
];

export async function seedDatabase() {
  const categoryIds = {};
  const existingCategories = await db.categories.toArray();
  existingCategories.forEach(category => {
    categoryIds[category.name] = category.id;
  });

  for (const cat of DEFAULT_CATEGORIES) {
    if (!categoryIds[cat.name]) {
      const id = await db.categories.add(cat);
      categoryIds[cat.name] = id;
    } else if (cat.name === 'Investment') {
      await db.categories.update(categoryIds[cat.name], { type: 'investment', color: cat.color, icon: cat.icon });
    }
  }

  const existingRules = await db.categorizationRules.toArray();
  const existingRuleKeys = new Set(existingRules.map(rule => `${rule.pattern}:${rule.categoryId}`));
  const rules = DEFAULT_RULES.map(rule => ({
    pattern: rule.pattern,
    matchType: rule.matchType,
    priority: rule.priority,
    categoryId: categoryIds[rule.categoryName || 'Food & Dining'],
  })).filter(rule => !existingRuleKeys.has(`${rule.pattern}:${rule.categoryId}`));

  if (rules.length > 0) {
    await db.categorizationRules.bulkAdd(rules);
  }
}
