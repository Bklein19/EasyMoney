import type { Page } from 'playwright';

import { authenticatedHttpContentType, runAuthenticatedHttpRequest } from '../authenticatedHttp.ts';

export const ROBINHOOD_CREDIT_GRAPHQL_URL = 'https://api.robinhood.com/creditcard/graphql';
// The client metadata is from Robinhood Banking 2.28.2, whose signed Android
// distribution supplied the current read-only GraphQL contracts below.
export const ROBINHOOD_CREDIT_CLIENT = 'mobile-app-rh@2.28.2';

export const ROBINHOOD_CREDIT_IDENTITY_QUERY =
  'query CriticalDataProviderQuery{authIdentity{id creditCustomers{id account{id}}}}';
export const ROBINHOOD_CREDIT_ACCOUNT_QUERY =
  'query CreditCardScreenQuery{authIdentity{id creditCustomers{id account{id basicInfo{id accountStatus} balances{id currentMicro pendingMicro pendingPaymentsMicro}}}}}';
export const ROBINHOOD_CREDIT_STATEMENTS_QUERY =
  'query StatementsScreenQuery{authIdentity{id creditCustomers{id account{id statementClosingDate statements{id closingDate}}}}}';
export const ROBINHOOD_CREDIT_TRANSACTIONS_QUERY =
  'query UnifiedTransactionListQuery($q:UnifiedTransactionSearchRequest!){unifiedTransactionSearch(q:$q){transactions{items{id amountMicro at description visibility details{__typename ... on CreditTransaction{id flow transactionStatus transactionType visibility merchantDetails{merchantName rawMerchantName} links{creditCustomer{id creditCustomerId}}}}} cursor}}}';

type JsonRecord = Record<string, unknown>;

export function robinhoodRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

export class RobinhoodAuthenticationRequired extends Error {
  constructor() {
    super('Robinhood authentication is required');
  }
}

export interface RobinhoodCreditApiResponse {
  body: string;
  data: JsonRecord;
  capturedAt?: string;
}

export type RobinhoodCreditQuery = (
  operationName: string,
  query: string,
  variables?: JsonRecord,
) => Promise<RobinhoodCreditApiResponse>;

export function parseRobinhoodCreditResponse(body: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('Robinhood credit API returned an invalid response');
  }
  const response = robinhoodRecord(parsed);
  if (
    !response ||
    (response.errors !== undefined &&
      response.errors !== null &&
      (!Array.isArray(response.errors) || response.errors.length > 0))
  ) {
    throw new Error('Robinhood credit API rejected the read request');
  }
  const data = robinhoodRecord(response.data);
  if (!data) throw new Error('Robinhood credit API response is missing data');
  return data;
}

export function createRobinhoodCreditQuery(
  page: Page,
  token: string,
  request: typeof runAuthenticatedHttpRequest = runAuthenticatedHttpRequest,
): RobinhoodCreditQuery {
  return async (operationName, query, variables = {}) => {
    const response = await request(page, {
      url: ROBINHOOD_CREDIT_GRAPHQL_URL,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-x1-client': ROBINHOOD_CREDIT_CLIENT,
      },
      body: JSON.stringify({ operationName, query, variables }),
      maxRedirects: 0,
      timeoutMs: 30_000,
      crossOriginPolicy: {
        applicationOrigin: 'https://robinhood.com',
        destinationOrigin: 'https://api.robinhood.com',
        institutionHostname: 'robinhood.com',
      },
    })
      .catch(() => {
        // Playwright's error call log can contain request headers. Never surface it.
        throw new Error('Robinhood credit API transport failed');
      })
      .catch(() => {
        // Playwright network errors can include the request's Authorization header.
        // Do not propagate its call log into a persisted sync error.
        throw new Error('Robinhood credit API transport failed');
      });
    if (response.status === 401 || response.status === 403) {
      throw new RobinhoodAuthenticationRequired();
    }
    if (response.status !== 200) {
      throw new Error(`Robinhood credit API read failed with HTTP ${response.status}`);
    }
    if (
      !['application/json', 'application/graphql-response+json'].includes(
        authenticatedHttpContentType(response),
      )
    ) {
      throw new Error('Robinhood credit API response content type is invalid');
    }
    const body = response.body.toString('utf8');
    const data = parseRobinhoodCreditResponse(body);
    const serverDate = response.headers.date ? new Date(response.headers.date) : null;
    return {
      body,
      data,
      ...(serverDate && Number.isFinite(serverDate.getTime())
        ? { capturedAt: serverDate.toISOString() }
        : {}),
    };
  };
}

export interface RobinhoodCreditAccountIdentity {
  id: string;
  customerId: string;
  name: string;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new Error('Robinhood credit account discovery returned an invalid identity');
  }
  return value;
}

export function discoverRobinhoodCreditAccounts(data: JsonRecord): {
  identityId: string;
  accounts: RobinhoodCreditAccountIdentity[];
} {
  const identity = robinhoodRecord(data.authIdentity);
  const identityId = identifier(identity?.id);
  if (!Array.isArray(identity?.creditCustomers)) {
    throw new Error('Robinhood credit account discovery is unavailable');
  }
  const accounts = identity.creditCustomers.map((value): RobinhoodCreditAccountIdentity => {
    const customer = robinhoodRecord(value);
    return {
      id: identifier(robinhoodRecord(customer?.account)?.id),
      customerId: identifier(customer?.id),
      name: 'Robinhood Credit Card',
    };
  });
  if (accounts.length === 0) throw new Error('No Robinhood credit card account was discovered');
  if (new Set(accounts.map((account) => account.id)).size !== accounts.length) {
    throw new Error('Robinhood credit account discovery returned ambiguous accounts');
  }
  return { identityId, accounts };
}

export function robinhoodTransactionDate(at: unknown, timeZone: string): string {
  if (
    typeof at !== 'number' ||
    !Number.isSafeInteger(at) ||
    at < 946_684_800_000 ||
    at > 4_102_444_800_000
  ) {
    throw new Error('Robinhood transaction timestamp is invalid');
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at));
  const part = (kind: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === kind)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export interface RobinhoodCreditTransactionPage {
  items: JsonRecord[];
  cursor: string | null;
}

export function parseRobinhoodCreditPage(data: JsonRecord): RobinhoodCreditTransactionPage {
  const transactions = robinhoodRecord(
    robinhoodRecord(data.unifiedTransactionSearch)?.transactions,
  );
  if (!transactions || !Array.isArray(transactions.items)) {
    throw new Error('Robinhood credit API response is missing transaction pages');
  }
  const cursor = transactions.cursor;
  if (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > 4096)) {
    throw new Error('Robinhood credit API returned an invalid pagination cursor');
  }
  const items = transactions.items.map((item) => {
    const record = robinhoodRecord(item);
    if (
      !record ||
      !record.id ||
      robinhoodRecord(record.details)?.__typename !== 'CreditTransaction'
    ) {
      throw new Error('Robinhood credit API returned an unexpected transaction account type');
    }
    return record;
  });
  return { items, cursor };
}

export async function fetchRobinhoodCreditTransactionPages(
  query: RobinhoodCreditQuery,
  options: {
    identityId: string;
    customerId: string;
    from: string;
    timeZone: string;
    onPage?: (count: number) => void;
  },
): Promise<string[]> {
  const responses: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < 2500; pageIndex++) {
    const response = await query(
      'UnifiedTransactionListQuery',
      ROBINHOOD_CREDIT_TRANSACTIONS_QUERY,
      {
        q: {
          userInformation: {
            creditCustomerId: options.customerId,
            identityId: options.identityId,
          },
          filters: { values: [], transactionTypes: ['CREDIT'] },
          sortDetails: { field: 'TIME', ascending: false },
          limit: 40,
          ...(cursor ? { cursor } : {}),
        },
      },
    );
    const page = parseRobinhoodCreditPage(response.data);
    responses.push(response.body);
    options.onPage?.(page.items.length);
    const dates = page.items.map((item) => robinhoodTransactionDate(item.at, options.timeZone));
    // The live native API signals the end with an empty page retaining the
    // requested cursor. A short populated page still has more history.
    if (
      page.cursor === null ||
      (page.items.length === 0 && page.cursor === cursor) ||
      dates.some((date) => date < options.from)
    )
      return responses;
    if (seenCursors.has(page.cursor)) {
      throw new Error('Robinhood credit API repeated a pagination cursor');
    }
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }
  throw new Error('Robinhood credit API exceeded the transaction pagination limit');
}
