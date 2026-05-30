import { add, list, update } from '../db/api';
import { normalizeMerchantName } from './merchantNormalizer';

const CATEGORY_KEYWORDS = {
  'Food & Dining': [
    'bakery', 'bar', 'bbq', 'burger', 'cafe', 'coffee', 'deli', 'diner', 'dining',
    'donut', 'espresso', 'food', 'grill', 'kitchen', 'pizza', 'restaurant', 'sushi', 'taco'
  ],
  Groceries: [
    'aldi', 'costco', 'food lion', 'grocery', 'heb', 'kroger', 'market', 'meijer',
    'publix', 'safeway', 'sprouts', 'supermarket', 'trader joe', 'wegmans', 'whole foods'
  ],
  Transportation: [
    'airlines', 'airport', 'amtrak', 'bp', 'bus', 'chevron', 'exxon', 'fuel', 'gas',
    'lyft', 'metro', 'parking', 'shell', 'speedway', 'toll', 'transit', 'uber'
  ],
  Shopping: [
    'amazon', 'best buy', 'ebay', 'etsy', 'home depot', 'ikea', 'lowes', 'mall',
    'shop', 'store', 'target', 'tj maxx', 'walmart'
  ],
  Health: [
    'clinic', 'cvs', 'dental', 'dentist', 'doctor', 'health', 'hospital', 'medical',
    'pharmacy', 'therapy', 'urgent care', 'walgreens'
  ],
  Entertainment: [
    'amc', 'apple com bill', 'audible', 'cinema', 'disney', 'hbo', 'hulu', 'movie',
    'netflix', 'playstation', 'spotify', 'steam', 'theater', 'ticketmaster', 'youtube'
  ],
  Utilities: [
    'at t', 'bill pay', 'comcast', 'electric', 'internet', 'mobile', 'phone', 'power',
    'utility', 'verizon', 'water', 'xfinity'
  ],
  Housing: [
    'apartment', 'hoa', 'landlord', 'mortgage', 'property', 'rent', 'rental'
  ],
  Education: [
    'bookstore', 'college', 'course', 'school', 'student', 'tuition', 'university'
  ],
  Travel: [
    'airbnb', 'booking', 'delta', 'expedia', 'hotel', 'hyatt', 'marriott', 'southwest',
    'travel', 'united'
  ],
  'Personal Care': [
    'barber', 'beauty', 'cosmetic', 'hair', 'nail', 'salon', 'spa'
  ],
  Insurance: [
    'allstate', 'geico', 'insurance', 'progressive', 'state farm'
  ],
  Subscriptions: [
    'membership', 'patreon', 'recurring', 'subscription'
  ],
  Income: [
    'ach credit', 'direct dep', 'direct deposit', 'payroll', 'salary'
  ],
  'Internal Transfer': [
    'brokerage transfer', 'credit card payment', 'internal transfer', 'robinhood transfer'
  ],
  Transfer: [
    'cash app', 'cashapp', 'venmo', 'zelle'
  ]
};

function normalizeForMatch(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTextForCategorization(transactionOrDescription) {
  if (typeof transactionOrDescription === 'string') return transactionOrDescription;
  const merchant = normalizeMerchantName(transactionOrDescription.merchant || transactionOrDescription.description || '').displayName;
  return [
    transactionOrDescription.merchant,
    transactionOrDescription.description,
    transactionOrDescription.originalDescription,
    transactionOrDescription.originalCategory,
    merchant
  ].filter(Boolean).join(' ');
}

function categoryMapByName(categories) {
  return categories.reduce((map, category) => {
    map[category.name.toLowerCase()] = category;
    return map;
  }, {});
}

function inferCategoryByKeywords(transaction, categories) {
  const byName = categoryMapByName(categories);
  const text = normalizeForMatch(getTextForCategorization(transaction));

  for (const [categoryName, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const category = byName[categoryName.toLowerCase()];
    if (!category) continue;
    if (keywords.some(keyword => text.includes(normalizeForMatch(keyword)))) {
      return category.id;
    }
  }

  return null;
}

/**
 * Auto-categorize a transaction based on categorization rules
 * @param {string} description - Transaction description
 * @param {Array} rules - Array of categorization rules from the DB
 * @returns {number|null} Category ID if matched, null otherwise
 */
export function categorizeTransaction(description, rules) {
  if (!description || !rules?.length) return null;

  const lower = description.toLowerCase();

  // Sort by priority descending (higher priority = more specific)
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);

  for (const rule of sorted) {
    const pattern = rule.pattern.toLowerCase();

    switch (rule.matchType) {
      case 'contains':
        if (lower.includes(pattern)) return rule.categoryId;
        break;
      case 'startsWith':
        if (lower.startsWith(pattern)) return rule.categoryId;
        break;
      case 'exact':
        if (lower === pattern) return rule.categoryId;
        break;
      case 'regex':
        try {
          const re = new RegExp(pattern, 'i');
          if (re.test(description)) return rule.categoryId;
        } catch {
          // Invalid regex, skip
        }
        break;
    }
  }

  return null;
}

/**
 * Auto-categorize an array of transactions in batch
 * @param {Array} transactions - Transactions to categorize
 * @param {Array} rules - Categorization rules
 * @param {Array} categories - All categories (to find "Uncategorized" fallback)
 * @returns {Array} Transactions with categoryId set
 */
export function categorizeTransactions(transactions, rules, categories) {
  const uncategorized = categories.find(c => c.name === 'Uncategorized');
  const fallbackId = uncategorized?.id || null;

  return transactions.map(t => {
    // If already categorized and not "Uncategorized", keep it
    if (t.categoryId && t.categoryId !== fallbackId) return t;

    // Try to match from original category (from bank CSV)
    let categoryId = null;

    if (t.originalCategory) {
      const originalCategory = normalizeForMatch(t.originalCategory);
      const matchedCat = categories.find(c => {
        const categoryName = normalizeForMatch(c.name);
        return categoryName === originalCategory || originalCategory.includes(categoryName) || categoryName.includes(originalCategory);
      });
      if (matchedCat) categoryId = matchedCat.id;
    }

    // If no category from bank data, use rules
    if (!categoryId) {
      categoryId = categorizeTransaction(getTextForCategorization(t), rules) || inferCategoryByKeywords(t, categories) || fallbackId;
    }

    return { ...t, categoryId };
  });
}

/**
 * Create a new categorization rule from a manual categorization
 */
export async function createRuleFromTransaction(transaction, categoryId) {
  // Extract a clean keyword from the description
  const keyword = extractKeyword(transaction.description);
  if (!keyword) return null;

  // Check if rule already exists
  const pattern = keyword.toLowerCase();
  const rules = await list('categorizationRules');
  const existing = rules.find(rule => rule.pattern === pattern);

  if (existing) {
    // Update existing rule
    await update('categorizationRules', existing.id, { categoryId });
    return existing.id;
  }

  // Create new rule
  return add('categorizationRules', {
    categoryId,
    pattern,
    matchType: 'contains',
    priority: 10,
  });
}

/**
 * Extract a meaningful keyword from a transaction description
 */
function extractKeyword(description) {
  if (!description) return null;

  // Remove common noise words and numbers
  const cleaned = description
    .replace(/\b(purchase|authorized|debit|credit|card|on|at|in|the|for)\b/gi, '')
    .replace(/\d{4,}/g, '') // Remove long numbers (card numbers, IDs)
    .replace(/\s*#\d+/g, '') // Remove store numbers
    .replace(/[*]/g, '') // Remove asterisks
    .replace(/\s+/g, ' ')
    .trim();

  // Take the first meaningful word(s) — usually the merchant name
  const words = cleaned.split(' ').filter(w => w.length > 2);
  if (words.length === 0) return null;

  // Return first 2-3 words as the keyword
  return words.slice(0, 3).join(' ').toLowerCase();
}
