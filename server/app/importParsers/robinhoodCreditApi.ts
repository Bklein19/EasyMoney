import type {
  AppImportParseInput,
  AppImportParseResult,
  AppImportParser,
  ParsedImportTransaction,
} from '../importTypes.ts';
import { robinhoodCreditCrossSourceIdentity } from './robinhoodCrossSourceIdentity.ts';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function invalid(detail: string): never {
  throw new Error(`Robinhood credit API artifact ${detail}`);
}

function responseData(value: unknown): JsonRecord {
  if (typeof value !== 'string') invalid('is missing an original response');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid('contains an invalid original JSON response');
  }
  const root = record(parsed);
  const errors = root?.errors;
  if (
    !root ||
    (errors !== undefined && errors !== null && (!Array.isArray(errors) || errors.length))
  ) {
    invalid('contains an API error');
  }
  return record(root.data) ?? invalid('is missing response data');
}

function calendarDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    invalid('has an invalid coverage date');
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    invalid('has an invalid coverage date');
  }
  return value;
}

function dateFormatter(timeZone: unknown): Intl.DateTimeFormat {
  if (!text(timeZone)) invalid('is missing its time zone');
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone as string,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    invalid('has an invalid time zone');
  }
}

function localDate(timestamp: number, formatter: Intl.DateTimeFormat): string {
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < Date.UTC(2000, 0, 1) ||
    timestamp >= Date.UTC(2100, 0, 1)
  ) {
    invalid('has an invalid transaction timestamp');
  }
  const parts = formatter.formatToParts(timestamp);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? invalid('has an invalid date');
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function microCents(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    invalid('has an invalid micro-unit amount');
  }
  if (value % 10_000 !== 0) invalid('contains a fractional-cent amount');
  return value / 10_000;
}

function magnitudeCents(value: unknown): number {
  const amount = microCents(value);
  if (amount < 0) invalid('has a negative transaction magnitude');
  return amount;
}

export function parseRobinhoodCreditApi(input: AppImportParseInput): AppImportParseResult {
  let value: unknown;
  try {
    value = JSON.parse(input.text);
  } catch {
    invalid('is not valid JSON');
  }
  const root = record(value);
  if (root?.format !== 'easymoney-robinhood-credit-v1') invalid('has an unknown format');
  const account = record(root.account);
  const accountId = text(account?.id);
  const customerId = text(account?.customerId);
  const name = text(account?.name);
  if (!accountId || !customerId || !name) invalid('is missing account identity');
  const request = record(root.request);
  const from = calendarDate(request?.from);
  const to = calendarDate(request?.to);
  if (from > to) invalid('has reversed coverage dates');
  const formatter = dateFormatter(request?.timeZone);
  const capturedAt = text(root.capturedAt);
  const capturedMs = capturedAt ? Date.parse(capturedAt) : NaN;
  if (!Number.isFinite(capturedMs)) invalid('has an invalid capture date');

  const identity = record(responseData(root.identityResponse).authIdentity);
  const customers = identity?.creditCustomers;
  if (!text(identity?.id) || !Array.isArray(customers)) invalid('is missing discovery data');
  const matches = customers.map(record).filter((customer) => customer?.id === customerId);
  if (matches.length !== 1 || record(matches[0]?.account)?.id !== accountId) {
    invalid('does not match its discovered account');
  }

  const remoteAccountId = `robinhood:credit:${accountId}`;
  const result: AppImportParseResult = {
    transactions: [],
    balances: [],
    coveredFrom: from,
    coveredTo: to,
  };
  if (root.accountResponse !== undefined && root.accountResponse !== null) {
    const accountIdentity = record(responseData(root.accountResponse).authIdentity);
    const accountCustomers = accountIdentity?.creditCustomers;
    if (accountIdentity?.id !== identity?.id || !Array.isArray(accountCustomers)) {
      invalid('has mismatched balance discovery data');
    }
    const balanceCustomers = accountCustomers.map(record).filter((item) => item?.id === customerId);
    if (balanceCustomers.length !== 1) invalid('has an ambiguous balance account');
    const creditAccount = record(balanceCustomers[0]?.account);
    if (creditAccount?.id !== accountId) invalid('has a mismatched balance account');
    const balances = record(creditAccount.balances);
    if (!balances) invalid('is missing its current balance');
    result.balances.push({
      sourceRowIndex: null,
      date: localDate(capturedMs, formatter),
      balanceCents: -microCents(balances.currentMicro),
      account: name,
      remoteAccountId,
      institution: 'Robinhood',
      raw: { source: 'robinhood-credit-api-json' },
    });
  }
  if (!Array.isArray(root.transactionResponses) || !root.transactionResponses.length) {
    invalid('is missing transaction pages');
  }
  const seen = new Map<string, string>();
  let sourceRowIndex = 0;
  for (const response of root.transactionResponses) {
    const search = record(responseData(response).unifiedTransactionSearch);
    const transactions = record(search?.transactions);
    if (
      !Array.isArray(transactions?.items) ||
      (transactions.cursor !== null && typeof transactions.cursor !== 'string')
    ) {
      invalid('has an invalid transaction page');
    }
    for (const value of transactions.items) {
      const rowIndex = sourceRowIndex++;
      const row = record(value);
      const details = record(row?.details);
      if (details?.__typename !== 'CreditTransaction') invalid('contains a non-credit transaction');
      const id = text(details.id);
      if (!id || !text(row?.id)) invalid('is missing transaction identity');
      const date = localDate(row?.at as number, formatter);
      const amount = magnitudeCents(row?.amountMicro);
      const description = text(row?.description);
      const status = text(details.transactionStatus);
      const visibility = text(row?.visibility);
      const detailVisibility = text(details.visibility);
      if (!description || !status || !visibility || !detailVisibility) {
        invalid('is missing transaction metadata');
      }
      const merchant = record(details.merchantDetails);
      const originalDescription = text(merchant?.rawMerchantName) ?? description;
      const signature = JSON.stringify({
        date,
        amount,
        flow: details.flow,
        status,
        visibility,
        detailVisibility,
        originalDescription,
        transactionType: details.transactionType,
      });
      const previous = seen.get(id);
      if (previous !== undefined && previous !== signature) {
        invalid('contains conflicting versions of a transaction');
      }
      seen.set(id, signature);
      if (
        previous !== undefined ||
        status !== 'POSTED' ||
        visibility !== 'VISIBLE' ||
        detailVisibility !== 'VISIBLE' ||
        date < from ||
        date > to ||
        amount === 0
      ) {
        result.transactions.push(null);
        continue;
      }
      if (details.flow !== 'INBOUND' && details.flow !== 'OUTBOUND') invalid('has an invalid flow');
      const transaction: ParsedImportTransaction = {
        sourceRowIndex: rowIndex,
        date,
        amountCents: details.flow === 'OUTBOUND' ? -amount : amount,
        description: originalDescription,
        account: name,
        remoteAccountId,
        institution: 'Robinhood',
        sourceRole: 'activity',
        raw: {
          source: 'robinhood-credit-api-json',
          moneyId: `robinhood-credit:${id}`,
          transactionType: text(details.transactionType) ?? undefined,
          merchant: text(merchant?.merchantName) ?? undefined,
          apiDescription: description,
          crossSourceIdentity: robinhoodCreditCrossSourceIdentity(originalDescription),
        },
      };
      result.transactions.push(transaction);
    }
  }
  return result;
}

export const robinhoodCreditApiParser: AppImportParser = {
  id: 'robinhood-credit-card-api-json',
  name: 'Robinhood Credit Card Activity',
  institution: 'Robinhood',
  sourceType: 'activity-export',
  priority: 110,
  matches: ({ fileName, sample }) =>
    /^robinhood-credit-[a-z0-9-]+-activity-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.json$/i.test(
      fileName,
    ) && /"format"\s*:\s*"easymoney-robinhood-credit-v1"/.test(sample),
  parse: parseRobinhoodCreditApi,
};
