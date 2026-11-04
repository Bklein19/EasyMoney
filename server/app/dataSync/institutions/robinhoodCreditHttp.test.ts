import { describe, expect, test } from 'bun:test';
import type { Page } from 'playwright';

import {
  discoverRobinhoodCreditAccounts,
  createRobinhoodCreditQuery,
  fetchRobinhoodCreditTransactionPages,
  parseRobinhoodCreditResponse,
  robinhoodTransactionDate,
  type RobinhoodCreditQuery,
} from './robinhoodCreditHttp.ts';

function response(items: unknown[], cursor: string | null) {
  const data = { unifiedTransactionSearch: { transactions: { items, cursor } } };
  return { body: JSON.stringify({ data }), data };
}

const item = (id: string, at = Date.UTC(2026, 9, 30)) => ({
  id,
  at,
  details: { __typename: 'CreditTransaction' },
});

const options = {
  identityId: 'synthetic-identity',
  customerId: 'synthetic-customer',
  from: '2026-10-01',
  timeZone: 'America/Los_Angeles',
};

describe('Robinhood native credit read protocol', () => {
  test('rejects an HTML login body even if it has status 200 and JSON-looking text', async () => {
    const query = createRobinhoodCreditQuery({} as Page, 'synthetic-secret', async () => ({
      requestUrl: 'https://api.robinhood.com/creditcard/graphql',
      finalUrl: 'https://api.robinhood.com/creditcard/graphql',
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/html' },
      body: Buffer.from('{"data":{"authIdentity":{}}}'),
      redirects: [],
    }));
    await expect(query('SyntheticQuery', 'query SyntheticQuery{authIdentity{id}}')).rejects.toThrow(
      'content type',
    );
  });
  test('does not propagate transport call logs containing bearer credentials', async () => {
    const query = createRobinhoodCreditQuery({} as Page, 'synthetic-secret', async () => {
      throw new Error('request failed: Authorization: Bearer synthetic-secret');
    });
    await expect(query('SyntheticQuery', 'query SyntheticQuery{authIdentity{id}}')).rejects.toThrow(
      /^Robinhood credit API transport failed$/,
    );
  });
  test('uses the current native userInformation request and follows a short page cursor', async () => {
    const requests: unknown[] = [];
    const first = response([item('one')], 'next-page');
    const last = response([item('two')], null);
    const query: RobinhoodCreditQuery = async (_name, _query, variables) => {
      requests.push(variables);
      return requests.length === 1 ? first : last;
    };
    const result = await fetchRobinhoodCreditTransactionPages(query, options);
    expect(result).toEqual([first.body, last.body]);
    expect(requests).toEqual([
      {
        q: {
          userInformation: { identityId: options.identityId, creditCustomerId: options.customerId },
          filters: { values: [], transactionTypes: ['CREDIT'] },
          sortDetails: { field: 'TIME', ascending: false },
          limit: 40,
        },
      },
      {
        q: {
          userInformation: { identityId: options.identityId, creditCustomerId: options.customerId },
          filters: { values: [], transactionTypes: ['CREDIT'] },
          sortDetails: { field: 'TIME', ascending: false },
          limit: 40,
          cursor: 'next-page',
        },
      },
    ]);
  });

  test('continues through an empty hidden page with a cursor', async () => {
    let requests = 0;
    const query: RobinhoodCreditQuery = async () =>
      ++requests === 1 ? response([], 'next-page') : response([item('one')], null);
    expect(await fetchRobinhoodCreditTransactionPages(query, options)).toHaveLength(2);
  });

  test('recognizes the native empty-page unchanged-cursor exhaustion sentinel', async () => {
    let requests = 0;
    const query: RobinhoodCreditQuery = async () =>
      ++requests === 1 ? response([item('one')], 'last-cursor') : response([], 'last-cursor');
    expect(await fetchRobinhoodCreditTransactionPages(query, options)).toHaveLength(2);
    expect(requests).toBe(2);
  });

  test('stops after retrieving the first page preceding the requested date', async () => {
    let requests = 0;
    const query: RobinhoodCreditQuery = async () => {
      requests++;
      return response([item('old', Date.UTC(2026, 8, 1))], 'still-more-history');
    };
    expect(await fetchRobinhoodCreditTransactionPages(query, options)).toHaveLength(1);
    expect(requests).toBe(1);
  });

  test('rejects cursor cycles instead of silently truncating the download', async () => {
    const query: RobinhoodCreditQuery = async () => response([item('one')], 'same-cursor');
    await expect(fetchRobinhoodCreditTransactionPages(query, options)).rejects.toThrow('repeated');
  });

  test('rejects banking rows in a card-only response', async () => {
    const query: RobinhoodCreditQuery = async () =>
      response(
        [{ id: 'bank', at: Date.UTC(2026, 9, 30), details: { __typename: 'BankTransaction' } }],
        null,
      );
    await expect(fetchRobinhoodCreditTransactionPages(query, options)).rejects.toThrow(
      'account type',
    );
  });

  test('keeps dates in the captured browser timezone and rejects seconds', () => {
    expect(robinhoodTransactionDate(Date.UTC(2026, 10, 1, 2), 'America/Los_Angeles')).toBe(
      '2026-10-31',
    );
    expect(() => robinhoodTransactionDate(1_793_489_400, 'UTC')).toThrow('timestamp');
  });

  test('does not copy API error details containing sensitive variables into errors', () => {
    expect(() =>
      parseRobinhoodCreditResponse(
        JSON.stringify({
          errors: [{ message: 'secret-variable-value' }],
        }),
      ),
    ).toThrow('Robinhood credit API rejected the read request');
    expect(() =>
      parseRobinhoodCreditResponse(
        JSON.stringify({
          data: { authIdentity: {} },
          errors: 'not-an-array',
        }),
      ),
    ).toThrow('rejected');
  });

  test('requires discovered account identity and rejects ambiguous shared account IDs', () => {
    expect(
      discoverRobinhoodCreditAccounts({
        authIdentity: {
          id: 'identity',
          creditCustomers: [{ id: 'customer', account: { id: 'account' } }],
        },
      }),
    ).toEqual({
      identityId: 'identity',
      accounts: [{ id: 'account', customerId: 'customer', name: 'Robinhood Credit Card' }],
    });
    expect(() =>
      discoverRobinhoodCreditAccounts({
        authIdentity: {
          id: 'identity',
          creditCustomers: [
            { id: 'one', account: { id: 'same' } },
            { id: 'two', account: { id: 'same' } },
          ],
        },
      }),
    ).toThrow('ambiguous');
  });
});
