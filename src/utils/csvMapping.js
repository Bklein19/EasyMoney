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

function findHeader(headers, hints) {
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

export function buildCustomProfile(mapping) {
  return {
    name: 'Custom CSV',
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
}

export function mappingFromProfile(profile, headers = []) {
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
