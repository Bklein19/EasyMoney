import { parse, isValid } from 'date-fns';
import type { ImportProfile } from '../importTypes.ts';

export type CsvMapping = {
  statementType?: string;
  dateColumn?: string;
  descriptionColumn?: string;
  merchantColumn?: string;
  categoryColumn?: string | null;
  splitAmount?: boolean;
  amountColumn?: string;
  debitColumn?: string;
  creditColumn?: string;
  negativeIsDebit?: boolean;
  positiveIsCharge?: boolean;
};

export type NormalizedCsvTransaction = {
  date: string;
  amount: number;
  description: string;
  merchant: string;
  originalDescription: string;
  originalCategory: string | null;
  type: string;
  transactionKind?: string | null;
  status: string;
  notes: string;
};

type CsvAmountConfig = {
  type?: 'single' | 'split';
  column?: string;
  debitColumn?: string;
  creditColumn?: string;
  chargeColumn?: string;
  paymentColumn?: string;
  negativeIsDebit?: boolean;
  positiveIsCharge?: boolean;
};

const HEADER_HINTS = {
  date: ['transaction date', 'posted date', 'post date', 'date'],
  description: ['description', 'details', 'memo', 'transaction description'],
  merchant: ['merchant', 'merchant name', 'payee', 'name', 'vendor', 'counterparty'],
  category: ['merchant category', 'category', 'transaction category', 'mcc category'],
  amount: ['amount', 'transaction amount'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'charge', 'charges'],
  credit: ['credit', 'deposit', 'deposits', 'payment', 'payments'],
};

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

function normalizeHeader(value = '') {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function findHeader(headers: string[], hints: string[]) {
  const normalizedHeaders = headers.map(header => ({
    original: header,
    normalized: normalizeHeader(header),
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

function resolveHeader(headers: string[], configuredHeader?: string | null) {
  if (!configuredHeader) return configuredHeader || '';
  const exact = headers.find(header => header === configuredHeader);
  if (exact) return exact;

  const normalizedConfigured = normalizeHeader(configuredHeader);
  return headers.find(header => normalizeHeader(header) === normalizedConfigured) || configuredHeader;
}

export function inferMappingFromHeaders(headers: string[] = []) {
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

export function buildCustomProfile(mapping: CsvMapping): ImportProfile {
  return {
    name: 'Custom CSV',
    statementType: mapping.statementType || 'bank',
    dateColumns: [mapping.dateColumn || ''],
    dateFormats: COMMON_DATE_FORMATS,
    descriptionColumn: mapping.descriptionColumn || '',
    merchantColumn: mapping.merchantColumn || mapping.descriptionColumn || '',
    categoryColumn: mapping.categoryColumn || null,
    amountConfig: mapping.splitAmount
      ? {
          type: 'split',
          debitColumn: mapping.debitColumn || '',
          creditColumn: mapping.creditColumn || '',
          chargeColumn: mapping.debitColumn || '',
          paymentColumn: mapping.creditColumn || '',
        }
      : {
          type: 'single',
          column: mapping.amountColumn || '',
          negativeIsDebit: mapping.negativeIsDebit !== false,
          positiveIsCharge: mapping.positiveIsCharge !== false,
        },
  };
}

export function mappingFromProfile(profile: ImportProfile | null | undefined, headers: string[] = []) {
  const inferred = inferMappingFromHeaders(headers);
  if (!profile) {
    return {
      ...inferred,
      splitAmount: Boolean(inferred.debitColumn || inferred.creditColumn),
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
    positiveIsCharge: amountConfig.positiveIsCharge !== false,
  };
}

export function enhanceProfileWithHeaders(profile: ImportProfile, headers: string[] = []): ImportProfile {
  const amountConfig = profile.amountConfig || {};
  const resolvedAmountConfig = { ...amountConfig };

  for (const key of ['column', 'debitColumn', 'creditColumn', 'chargeColumn', 'paymentColumn']) {
    if (resolvedAmountConfig[key]) {
      resolvedAmountConfig[key] = resolveHeader(headers, resolvedAmountConfig[key] as string);
    }
  }

  return {
    ...profile,
    dateColumns: profile.dateColumns?.map(column => resolveHeader(headers, column)) || [],
    descriptionColumn: resolveHeader(headers, profile.descriptionColumn),
    merchantColumn: resolveHeader(headers, profile.merchantColumn),
    categoryColumn: resolveHeader(headers, profile.categoryColumn),
    amountConfig: resolvedAmountConfig,
  };
}

export function parseDate(dateStr: string, formats = COMMON_DATE_FORMATS) {
  if (!dateStr) return null;
  const trimmed = dateStr.trim();

  const isoDate = new Date(trimmed);
  if (isValid(isoDate) && trimmed.includes('-') && trimmed.length >= 10) {
    return isoDate;
  }

  for (const fmt of formats) {
    const parsed = parse(trimmed, fmt, new Date());
    if (isValid(parsed)) return parsed;
  }

  return null;
}

export function parseAmount(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const cleaned = String(value)
    .replace(/[$,\s]/g, '')
    .replace(/\(([^)]+)\)/, '-$1');
  const num = Number.parseFloat(cleaned);
  return Number.isNaN(num) ? null : num;
}

export function normalizeMappedCsvTransaction(row: Record<string, string>, profile: ImportProfile): NormalizedCsvTransaction | null {
  const resolvedProfile = profile;
  const dateStr = row[resolvedProfile.dateColumns?.[0] || ''] || row[resolvedProfile.dateColumns?.[1] || ''];
  const date = parseDate(dateStr, resolvedProfile.dateFormats || COMMON_DATE_FORMATS);
  if (!date) return null;

  const rawDescription = (row[resolvedProfile.descriptionColumn || ''] || '').trim();
  const rawMerchant = resolvedProfile.merchantColumn
    ? (row[resolvedProfile.merchantColumn] || '').trim()
    : '';
  const description = rawDescription || rawMerchant;
  const merchant = resolvedProfile.merchantColumn ? rawMerchant || description : description;
  const amountConfig = (resolvedProfile.amountConfig || {}) as CsvAmountConfig;
  let amount = 0;

  if (amountConfig.type === 'single') {
    const raw = parseAmount(row[amountConfig.column || '']);
    if (raw === null) return null;
    if (resolvedProfile.statementType === 'credit_card') {
      amount = amountConfig.positiveIsCharge !== false ? -raw : raw;
    } else {
      amount = amountConfig.negativeIsDebit ? raw : -raw;
    }
  } else if (amountConfig.type === 'split') {
    if (resolvedProfile.statementType === 'credit_card') {
      const charges = parseAmount(row[amountConfig.chargeColumn || amountConfig.debitColumn || '']) || 0;
      const payments = parseAmount(row[amountConfig.paymentColumn || amountConfig.creditColumn || '']) || 0;
      amount = payments - charges;
    } else {
      const debit = parseAmount(row[amountConfig.debitColumn || '']) || 0;
      const credit = parseAmount(row[amountConfig.creditColumn || '']) || 0;
      amount = credit - debit;
    }
  } else {
    return null;
  }

  const originalCategory = resolvedProfile.categoryColumn
    ? (row[resolvedProfile.categoryColumn] || '').trim()
    : null;

  return {
    date: date.toISOString(),
    description,
    merchant,
    originalDescription: description,
    amount: Math.round(amount * 100) / 100,
    originalCategory,
    type: amount >= 0 ? 'credit' : 'debit',
    transactionKind: resolvedProfile.statementType === 'credit_card' && amount > 0 ? 'card_payment' : null,
    status: 'cleared',
    notes: '',
  };
}
