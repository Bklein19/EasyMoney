import { parse, isValid } from 'date-fns';

/**
 * Bank profile definitions for auto-detecting CSV formats
 */
export const BANK_PROFILES = [
  {
    name: 'Chase',
    headerFingerprint: ['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount'],
    dateColumns: ['Transaction Date'],
    dateFormats: ['MM/dd/yyyy'],
    descriptionColumn: 'Description',
    merchantColumn: 'Description',
    amountConfig: { type: 'single', column: 'Amount', negativeIsDebit: true },
    categoryColumn: 'Category',
  },
  {
    name: 'Bank of America',
    headerFingerprint: ['Date', 'Description', 'Amount', 'Running Bal.'],
    dateColumns: ['Date'],
    dateFormats: ['MM/dd/yyyy'],
    descriptionColumn: 'Description',
    merchantColumn: 'Description',
    amountConfig: { type: 'single', column: 'Amount', negativeIsDebit: true },
    categoryColumn: null,
  },
  {
    name: 'Wells Fargo Credit Card',
    headerFingerprint: ['DATE', 'DESCRIPTION', 'AMOUNT', 'CHECK #', 'STATUS'],
    statementType: 'credit_card',
    dateColumns: ['DATE'],
    dateFormats: ['MM/dd/yyyy'],
    descriptionColumn: 'DESCRIPTION',
    merchantColumn: 'DESCRIPTION',
    amountConfig: { type: 'single', column: 'AMOUNT', positiveIsCharge: false },
    categoryColumn: null,
  },
  {
    name: 'Wells Fargo',
    headerFingerprint: ['Date', 'Description', 'Deposits', 'Withdrawals'],
    dateColumns: ['Date'],
    dateFormats: ['MM/dd/yyyy'],
    descriptionColumn: 'Description',
    merchantColumn: 'Description',
    amountConfig: { type: 'split', debitColumn: 'Withdrawals', creditColumn: 'Deposits' },
    categoryColumn: null,
  },
  {
    name: 'Capital One',
    headerFingerprint: ['Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit'],
    dateColumns: ['Transaction Date'],
    dateFormats: ['yyyy-MM-dd'],
    descriptionColumn: 'Description',
    merchantColumn: 'Description',
    amountConfig: { type: 'split', debitColumn: 'Debit', creditColumn: 'Credit' },
    categoryColumn: 'Category',
  },
  {
    name: 'Citi',
    headerFingerprint: ['Status', 'Date', 'Description', 'Debit', 'Credit'],
    dateColumns: ['Date'],
    dateFormats: ['MM/dd/yyyy'],
    descriptionColumn: 'Description',
    merchantColumn: 'Description',
    amountConfig: { type: 'split', debitColumn: 'Debit', creditColumn: 'Credit' },
    categoryColumn: null,
  },
];

const HEADER_HINTS = {
  date: ['transaction date', 'posted date', 'post date', 'date'],
  description: ['description', 'details', 'memo', 'transaction description'],
  merchant: ['merchant', 'merchant name', 'payee', 'name', 'vendor', 'counterparty'],
  category: ['merchant category', 'category', 'transaction category', 'mcc category'],
  amount: ['amount', 'transaction amount'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'charge', 'charges'],
  credit: ['credit', 'deposit', 'deposits', 'payment', 'payments']
};

function normalizeHeader(value = '') {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function findHeader(headers, hints) {
  const normalizedHeaders = headers.map(header => ({
    original: header,
    normalized: normalizeHeader(header)
  }));

  for (const hint of hints) {
    const normalizedHint = normalizeHeader(hint);
    const exact = normalizedHeaders.find(header => header.normalized === normalizedHint);
    if (exact) return exact.original;
  }

  for (const hint of hints) {
    const normalizedHint = normalizeHeader(hint);
    const partial = normalizedHeaders.find(header =>
      header.normalized.includes(normalizedHint) || normalizedHint.includes(header.normalized)
    );
    if (partial) return partial.original;
  }

  return '';
}

function resolveHeader(headers, configuredHeader) {
  if (!configuredHeader) return configuredHeader;
  const exact = headers.find(header => header === configuredHeader);
  if (exact) return exact;

  const normalizedConfigured = normalizeHeader(configuredHeader);
  return headers.find(header => normalizeHeader(header) === normalizedConfigured) || configuredHeader;
}

function resolveProfileHeaders(profile, headers = []) {
  if (!profile) return profile;
  const amountConfig = profile.amountConfig || {};
  const resolvedAmountConfig = { ...amountConfig };

  for (const key of ['column', 'debitColumn', 'creditColumn', 'chargeColumn', 'paymentColumn']) {
    if (resolvedAmountConfig[key]) {
      resolvedAmountConfig[key] = resolveHeader(headers, resolvedAmountConfig[key]);
    }
  }

  return {
    ...profile,
    dateColumns: profile.dateColumns?.map(column => resolveHeader(headers, column)) || [],
    descriptionColumn: resolveHeader(headers, profile.descriptionColumn),
    merchantColumn: resolveHeader(headers, profile.merchantColumn),
    categoryColumn: resolveHeader(headers, profile.categoryColumn),
    amountConfig: resolvedAmountConfig
  };
}

export function inferMappingFromHeaders(headers = []) {
  const merchantColumn = findHeader(headers, HEADER_HINTS.merchant);
  const categoryColumn = findHeader(headers, HEADER_HINTS.category);

  return {
    dateColumn: findHeader(headers, HEADER_HINTS.date),
    descriptionColumn: findHeader(headers, HEADER_HINTS.description),
    merchantColumn: normalizeHeader(merchantColumn).includes('category') ? '' : merchantColumn,
    categoryColumn,
    amountColumn: findHeader(headers, HEADER_HINTS.amount),
    debitColumn: findHeader(headers, HEADER_HINTS.debit),
    creditColumn: findHeader(headers, HEADER_HINTS.credit),
  };
}

export function enhanceProfileWithHeaders(profile, headers = []) {
  if (!profile) return profile;
  const resolvedProfile = resolveProfileHeaders(profile, headers);
  const inferred = inferMappingFromHeaders(headers);
  const amountConfig = resolvedProfile.amountConfig || {};
  const enhancedAmountConfig = { ...amountConfig };

  if (amountConfig.type === 'single' && inferred.amountColumn && !headers.includes(amountConfig.column)) {
    enhancedAmountConfig.column = inferred.amountColumn;
  }

  if (amountConfig.type === 'split') {
    if (inferred.debitColumn && !headers.includes(amountConfig.debitColumn || amountConfig.chargeColumn)) {
      enhancedAmountConfig.debitColumn = inferred.debitColumn;
      enhancedAmountConfig.chargeColumn = inferred.debitColumn;
    }
    if (inferred.creditColumn && !headers.includes(amountConfig.creditColumn || amountConfig.paymentColumn)) {
      enhancedAmountConfig.creditColumn = inferred.creditColumn;
      enhancedAmountConfig.paymentColumn = inferred.creditColumn;
    }
  }

  return {
    ...resolvedProfile,
    dateColumns: resolvedProfile.dateColumns?.length ? resolvedProfile.dateColumns : [inferred.dateColumn].filter(Boolean),
    descriptionColumn: resolvedProfile.descriptionColumn || inferred.descriptionColumn || inferred.merchantColumn,
    merchantColumn: inferred.merchantColumn || resolvedProfile.merchantColumn || resolvedProfile.descriptionColumn,
    categoryColumn: inferred.categoryColumn || resolvedProfile.categoryColumn || null,
    amountConfig: enhancedAmountConfig
  };
}

/**
 * Auto-detect bank from CSV headers
 * @param {string[]} headers - Array of column header names from the CSV
 * @returns {object|null} Matching bank profile, or null if no match
 */
export function detectBank(headers) {
  const normalized = headers.map(h => h.trim());

  let bestMatch = null;
  let bestScore = 0;

  for (const profile of BANK_PROFILES) {
    const matchCount = profile.headerFingerprint.filter(fp =>
      normalized.some(h => h.toLowerCase() === fp.toLowerCase())
    ).length;

    const score = matchCount / profile.headerFingerprint.length;

    if (score > bestScore && score >= 0.6) {
      bestScore = score;
      bestMatch = profile;
    }
  }

  return bestMatch;
}

/**
 * Common date formats to try for auto-detection
 */
const COMMON_DATE_FORMATS = [
  'MM/dd/yyyy',
  'M/d/yyyy',
  'yyyy-MM-dd',
  'MM-dd-yyyy',
  'MM/dd/yy',
  'M/d/yy',
  'dd/MM/yyyy',
  'yyyy/MM/dd',
];

/**
 * Try to parse a date string using multiple formats
 */
export function parseDate(dateStr, formats = COMMON_DATE_FORMATS) {
  if (!dateStr) return null;
  const trimmed = dateStr.trim();

  // Try native ISO parsing first
  const isoDate = new Date(trimmed);
  if (isValid(isoDate) && trimmed.includes('-') && trimmed.length >= 10) {
    return isoDate;
  }

  // Try each format
  for (const fmt of formats) {
    const parsed = parse(trimmed, fmt, new Date());
    if (isValid(parsed)) {
      return parsed;
    }
  }

  return null;
}

/**
 * Parse an amount value from a CSV cell
 */
export function parseAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const cleaned = String(value)
    .replace(/[$,\s]/g, '')
    .replace(/\(([^)]+)\)/, '-$1'); // Handle parenthetical negatives
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Normalize a raw CSV row to a standard transaction shape
 * @param {object} row - Raw CSV row (key-value pairs)
 * @param {object} profile - Bank profile or manual column mapping
 * @returns {object} Normalized transaction
 */
export function normalizeTransaction(row, profile) {
  // Parse date
  const dateStr = row[profile.dateColumns[0]] || row[profile.dateColumns[1]];
  const formats = profile.dateFormats || COMMON_DATE_FORMATS;
  const date = parseDate(dateStr, formats);
  if (!date) return null;

  // Parse description
  const description = (row[profile.descriptionColumn] || '').trim();
  const merchant = profile.merchantColumn
    ? (row[profile.merchantColumn] || description).trim()
    : description;

  // Parse amount
  let amount = 0;
  const { amountConfig } = profile;

  if (amountConfig.type === 'single') {
    const raw = parseAmount(row[amountConfig.column]);
    if (raw === null) return null;
    if (profile.statementType === 'credit_card') {
      amount = amountConfig.positiveIsCharge !== false ? -raw : raw;
    } else {
      // Most banks: negative = debit/expense, positive = credit/income
      amount = amountConfig.negativeIsDebit ? raw : -raw;
    }
  } else if (amountConfig.type === 'split') {
    if (profile.statementType === 'credit_card') {
      const charges = parseAmount(row[amountConfig.chargeColumn || amountConfig.debitColumn]) || 0;
      const payments = parseAmount(row[amountConfig.paymentColumn || amountConfig.creditColumn]) || 0;
      amount = payments - charges;
    } else {
      const debit = parseAmount(row[amountConfig.debitColumn]) || 0;
      const credit = parseAmount(row[amountConfig.creditColumn]) || 0;
      // Debit = expense (negative), Credit = income (positive)
      amount = credit - debit;
    }
  }

  // Parse category if available
  const originalCategory = profile.categoryColumn
    ? (row[profile.categoryColumn] || '').trim()
    : null;

  return {
    date: date.toISOString(),
    description,
    merchant,
    originalDescription: description,
    amount: Math.round(amount * 100) / 100,
    originalCategory,
    type: amount >= 0 ? 'credit' : 'debit',
    transactionKind: profile.statementType === 'credit_card' && amount > 0 ? 'card_payment' : undefined,
    status: 'cleared',
    notes: '',
  };
}

/**
 * Build a generic mapping profile from user-selected columns
 */
export function buildCustomProfile(mapping) {
  const profile = {
    name: 'Custom',
    statementType: mapping.statementType || 'bank',
    dateColumns: [mapping.dateColumn],
    dateFormats: COMMON_DATE_FORMATS,
    descriptionColumn: mapping.descriptionColumn,
    merchantColumn: mapping.merchantColumn || mapping.descriptionColumn,
    categoryColumn: mapping.categoryColumn || null,
    amountConfig: mapping.splitAmount
      ? {
          type: 'split',
          debitColumn: mapping.debitColumn,
          creditColumn: mapping.creditColumn,
          chargeColumn: mapping.debitColumn,
          paymentColumn: mapping.creditColumn,
        }
      : {
          type: 'single',
          column: mapping.amountColumn,
          negativeIsDebit: mapping.negativeIsDebit !== false,
          positiveIsCharge: mapping.positiveIsCharge !== false,
        },
  };
  return profile;
}

export function mappingFromProfile(profile, headers = []) {
  const inferred = inferMappingFromHeaders(headers);
  if (!profile) {
    return {
      ...inferred,
      splitAmount: Boolean(inferred.debitColumn || inferred.creditColumn)
    };
  }

  const amountConfig = profile.amountConfig || {};
  return {
    statementType: profile.statementType || 'bank',
    dateColumn: profile.dateColumns?.[0] || inferred.dateColumn || '',
    descriptionColumn: profile.descriptionColumn || inferred.descriptionColumn || '',
    merchantColumn: profile.merchantColumn || inferred.merchantColumn || '',
    categoryColumn: profile.categoryColumn || inferred.categoryColumn || '',
    splitAmount: amountConfig.type === 'split',
    amountColumn: amountConfig.column || inferred.amountColumn || '',
    debitColumn: amountConfig.chargeColumn || amountConfig.debitColumn || inferred.debitColumn || '',
    creditColumn: amountConfig.paymentColumn || amountConfig.creditColumn || inferred.creditColumn || '',
    negativeIsDebit: amountConfig.negativeIsDebit !== false,
    positiveIsCharge: amountConfig.positiveIsCharge !== false
  };
}
