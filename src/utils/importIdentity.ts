interface TransactionIdentityInput {
  accountId?: string | number | null;
  date?: string | null;
  amount?: string | number | null;
  originalDescription?: string | null;
  description?: string | null;
  merchant?: string | null;
  fingerprint?: string | null;
}

function normalizeText(value: string | number | null | undefined = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDate(value: string | null | undefined = '') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function normalizeAmount(value: string | number | null | undefined) {
  return Number(value || 0).toFixed(2);
}

export function getHeaderSignature(headers: string[] = []) {
  return headers.map(header => normalizeText(header)).join('|');
}

export function getTransactionFingerprint(transaction: TransactionIdentityInput, accountId: string | number | null | undefined) {
  const text = normalizeText(
    transaction.originalDescription ||
    transaction.description ||
    transaction.merchant ||
    ''
  );
  return [
    accountId,
    normalizeDate(transaction.date),
    normalizeAmount(transaction.amount),
    text
  ].join('|');
}

export function splitDuplicateTransactions<T extends TransactionIdentityInput>(
  transactions: T[],
  existingTransactions: TransactionIdentityInput[],
  accountId: string | number | null | undefined
) {
  const seen = new Set(
    existingTransactions.map(transaction =>
      transaction.fingerprint || getTransactionFingerprint(transaction, transaction.accountId || accountId)
    )
  );

  const unique = [];
  const duplicates = [];

  for (const transaction of transactions) {
    const fingerprint = getTransactionFingerprint(transaction, accountId);
    const withFingerprint = { ...transaction, fingerprint };
    if (seen.has(fingerprint)) {
      duplicates.push(withFingerprint);
    } else {
      seen.add(fingerprint);
      unique.push(withFingerprint);
    }
  }

  return { unique, duplicates };
}
