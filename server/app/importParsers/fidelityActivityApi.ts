import type {
  AppImportParseInput,
  AppImportParseResult,
  AppImportParser,
  ParsedImportTransaction,
} from '../importTypes.ts';
import { fidelityRetailActivityRemoteAccountId } from './fidelityAccountIdentity.ts';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function normalizedText(value: unknown): string | null {
  return typeof value === 'string' && value.replace(/\s+/g, ' ').trim()
    ? value.replace(/\s+/g, ' ').trim()
    : null;
}

function activityResponse(value: unknown): JsonRecord[] {
  const root = record(value);
  const errors = root?.errors;
  if (!root || (errors !== undefined && errors !== null && (!Array.isArray(errors) || errors.length > 0))) {
    throw new Error('Fidelity activity API response contains errors');
  }
  const data = record(root.data);
  if (!data || !Array.isArray(data.transactions)) {
    throw new Error('Fidelity activity API response is missing transactions');
  }
  return data.transactions.map(transaction => {
    const item = record(transaction);
    if (!item) throw new Error('Fidelity activity API transaction is invalid');
    return item;
  });
}

function apiDate(value: unknown): string {
  if (typeof value !== 'number' || !Number.isInteger(value)
      || value < 946_684_800 || value > 4_102_444_800) {
    throw new Error('Fidelity activity API transaction date is invalid');
  }
  return new Date(value * 1_000).toISOString();
}

function sourceAccountName(rawAccountId: string, remoteAccountId: string): string {
  if (remoteAccountId.startsWith('fidelity:retail-token:')) {
    return `Fidelity retirement plan ${rawAccountId}`;
  }
  const digits = rawAccountId.replace(/\D/g, '');
  return `Fidelity account${digits.length >= 4 ? ` ending in ${digits.slice(-4)}` : ''}`;
}

function fundNames(transaction: JsonRecord): string[] {
  if (!Array.isArray(transaction.dcDetails)) return [];
  const names = transaction.dcDetails.flatMap(detail => {
    const fund = record(record(detail)?.fundDetail);
    const name = normalizedText(fund?.longName);
    return name ? [name] : [];
  });
  return [...new Set(names)];
}

function transactionDescription(transaction: JsonRecord, remoteAccountId: string): string {
  const description = normalizedText(transaction.description);
  if (!description) throw new Error('Fidelity activity API transaction description is invalid');
  if (!remoteAccountId.startsWith('fidelity:retail-token:')) return description;
  const category = normalizedText(record(transaction.catDetail)?.txnCatDesc);
  return [...new Set([category, description, ...fundNames(transaction)].filter(
    (value): value is string => Boolean(value),
  ))].join(': ');
}

function parsedTransaction(transaction: JsonRecord, sourceRowIndex: number): ParsedImportTransaction | null {
  const rawAccountId = normalizedText(transaction.acctNum);
  const remoteAccountId = rawAccountId
    ? fidelityRetailActivityRemoteAccountId(rawAccountId)
    : null;
  const amount = record(transaction.amtDetail)?.net;
  if (!rawAccountId || !remoteAccountId || typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error('Fidelity activity API transaction account or amount is invalid');
  }
  const date = apiDate(transaction.date);
  const description = transactionDescription(transaction, remoteAccountId);
  if (amount === 0) return null;
  const category = record(transaction.catDetail);
  const security = record(transaction.securityDetail);
  return {
    sourceRowIndex,
    date,
    amountCents: Math.round(amount * 100),
    description,
    institution: 'Fidelity',
    account: sourceAccountName(rawAccountId, remoteAccountId),
    remoteAccountId,
    sourceRole: 'activity',
    raw: {
      source: 'fidelity-activity-api-json',
      transactionNumber: normalizedText(transaction.txnNum) ?? undefined,
      transactionType: normalizedText(category?.txnTypeDesc ?? category?.txnCatDesc) ?? undefined,
      securityDescription: normalizedText(security?.desc) ?? undefined,
      symbol: normalizedText(security?.symbol) ?? undefined,
      quantity: normalizedText(transaction.quantity) ?? undefined,
    },
  };
}

export function parseFidelityActivityApi(input: AppImportParseInput): AppImportParseResult {
  let value: unknown;
  try {
    value = JSON.parse(input.text) as unknown;
  } catch {
    throw new Error('Fidelity activity API artifact is not valid JSON');
  }
  const transactions = activityResponse(value);
  const rawAccountIds = new Set(transactions.map(transaction => {
    const rawAccountId = normalizedText(transaction.acctNum);
    const remoteAccountId = rawAccountId
      ? fidelityRetailActivityRemoteAccountId(rawAccountId)
      : null;
    if (!remoteAccountId) throw new Error('Fidelity activity API transaction account is invalid');
    return rawAccountId;
  }));
  if (rawAccountIds.size > 1) {
    throw new Error('Fidelity activity API response contains multiple accounts');
  }
  const parsed = transactions.map(parsedTransaction);
  const dates = transactions.map(transaction => apiDate(transaction.date).slice(0, 10)).sort();
  return {
    transactions: parsed,
    balances: [],
    coveredFrom: dates[0] ?? null,
    coveredTo: dates.at(-1) ?? null,
  };
}

function hasFidelityActivityApiShape(sample: string): boolean {
  try {
    const value = JSON.parse(sample) as unknown;
    const root = record(value);
    const data = record(root?.data);
    return Boolean(root && data && Array.isArray(data.transactions));
  } catch {
    const prefix = sample.replace(/^\uFEFF/, '').trimStart();
    return prefix.startsWith('{')
      && /"data"\s*:\s*\{/.test(prefix)
      && /"transactions"\s*:\s*\[/.test(prefix)
      && /"acctNum"\s*:/.test(prefix)
      && /"date"\s*:/.test(prefix)
      && /"amtDetail"\s*:\s*\{/.test(prefix);
  }
}

export const fidelityActivityApiParser: AppImportParser = {
  id: 'fidelity-activity-api-json',
  name: 'Fidelity Activity',
  institution: 'Fidelity',
  sourceType: 'activity-export',
  priority: 110,
  matches: ({ fileName, sample }) => (
    /^fidelity-(?:retail|netbenefits)-[a-z0-9-]+-activity-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.json$/i
      .test(fileName)
      && hasFidelityActivityApiShape(sample)
  ),
  parse: parseFidelityActivityApi,
};
