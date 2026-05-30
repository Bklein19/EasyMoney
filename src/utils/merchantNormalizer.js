const GENERIC_SUFFIXES = new Set([
  'card',
  'debit',
  'visa',
  'mastercard',
  'purchase',
  'pos',
  'auth',
  'authorization',
  'transaction',
  'online',
  'i',
  'osv',
  'debits',
  'credits'
]);

const SMALL_WORDS = new Set(['and', 'of', 'the', 'a', 'an']);

function toTitleCase(value) {
  return value
    .split(' ')
    .filter(Boolean)
    .map((word, index) => {
      if (index > 0 && SMALL_WORDS.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

export function normalizeMerchantName(value) {
  const original = (value || 'Unknown').trim();
  if (!original) {
    return { key: 'UNKNOWN', displayName: 'Unknown', originalName: 'Unknown' };
  }

  let cleaned = original
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')
    .replace(/\b(?:card|visa|mastercard|debit)\s*[-*#]?\s*\d{3,}\b/g, ' ')
    .replace(/\b(?:x+|x{2,}[a-z]*|[a-z]*x{2,})\d{2,}(?:\s+[a-z]{2,}){0,3}\b/g, ' ')
    .replace(/\b(?:auth|authorization|ref|trace|id)\s*[-#: ]*\s*[a-z0-9]{4,}\b/g, ' ')
    .replace(/\b\d+[a-z][a-z0-9]{4,}(?:\s+[a-z]{2,}){0,3}\b/g, ' ')
    .replace(/\b[a-z]{2}\d{4,}\b/g, ' ')
    .replace(/\b[a-z0-9]*\d[a-z0-9]*[a-z][a-z0-9]*\b/g, ' ')
    .replace(/\s+#?\d{3,}\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let tokens = cleaned.split(' ').filter(Boolean);
  while (tokens.length > 1 && GENERIC_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
  }

  cleaned = tokens.join(' ').trim();
  if (!cleaned) cleaned = original.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || 'unknown';

  const key = cleaned.toUpperCase();
  return {
    key,
    displayName: toTitleCase(cleaned),
    originalName: original
  };
}

export function groupMerchantTransactions(transactions, getName) {
  const groups = {};

  transactions.forEach(transaction => {
    const { key, displayName, originalName } = normalizeMerchantName(getName(transaction));
    if (!groups[key]) {
      groups[key] = {
        name: displayName,
        normalized: key,
        amount: 0,
        count: 0,
        aliases: new Set(),
        transactionIds: [],
      };
    }

    groups[key].amount += Math.abs(transaction.amount);
    groups[key].count += 1;
    groups[key].aliases.add(originalName);
    groups[key].transactionIds.push(transaction.id);
  });

  return Object.values(groups).map(group => ({
    ...group,
    aliases: Array.from(group.aliases).sort((a, b) => a.localeCompare(b))
  }));
}

export function applyManualStacks(groups, stackMap = {}, labelMap = {}) {
  const byKey = {};
  groups.forEach(group => {
    byKey[group.normalized] = {
      ...group,
      aliases: new Set(group.aliases),
      transactionIds: [...group.transactionIds],
      stackedKeys: [group.normalized],
      manuallyStackedKeys: []
    };
  });

  Object.entries(stackMap).forEach(([sourceKey, targetKey]) => {
    if (!sourceKey || !targetKey || sourceKey === targetKey) return;
    const source = byKey[sourceKey];
    const target = byKey[targetKey];
    if (!source || !target) return;

    target.amount += source.amount;
    target.count += source.count;
    source.aliases.forEach(alias => target.aliases.add(alias));
    target.transactionIds.push(...source.transactionIds);
    target.stackedKeys.push(...source.stackedKeys);
    target.manuallyStackedKeys.push(sourceKey);
    delete byKey[sourceKey];
  });

  return Object.values(byKey).map(group => ({
    ...group,
    name: labelMap[group.normalized] || group.name,
    customName: labelMap[group.normalized] || '',
    aliases: Array.from(group.aliases).sort((a, b) => a.localeCompare(b)),
    transactionIds: Array.from(new Set(group.transactionIds)),
    stackedKeys: Array.from(new Set(group.stackedKeys)),
    manuallyStackedKeys: Array.from(new Set(group.manuallyStackedKeys))
  }));
}
