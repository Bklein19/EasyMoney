import { describe, expect, test } from 'bun:test';
import { resolveImportParser } from './index.ts';
import { parseRobinhoodCreditApi, robinhoodCreditApiParser } from './robinhoodCreditApi.ts';

function transaction(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `unified-${id}`,
    at: Date.parse('2026-10-02T02:00:00Z'),
    amountMicro: 12_340_000,
    description: 'Example Store',
    visibility: 'VISIBLE',
    details: {
      __typename: 'CreditTransaction',
      id,
      flow: 'OUTBOUND',
      transactionStatus: 'POSTED',
      transactionType: 'PURCHASE',
      visibility: 'VISIBLE',
      merchantDetails: { merchantName: 'Example Store', rawMerchantName: 'EXAMPLE STORE CA' },
    },
    ...overrides,
  };
}

function page(items: unknown[], cursor: string | null = null) {
  return JSON.stringify({
    data: { unifiedTransactionSearch: { transactions: { items, cursor } } },
  });
}

function envelope() {
  const identity = {
    id: 'identity-a',
    creditCustomers: [{ id: 'customer-a', account: { id: 'account-a' } }],
  };
  return {
    format: 'easymoney-robinhood-credit-v1',
    capturedAt: '2026-10-02T02:00:00Z',
    request: { from: '2026-10-01', to: '2026-10-31', timeZone: 'America/Los_Angeles' },
    account: { id: 'account-a', customerId: 'customer-a', name: 'Robinhood Credit Card' },
    identityResponse: JSON.stringify({ data: { authIdentity: identity } }),
    accountResponse: JSON.stringify({
      data: {
        authIdentity: {
          ...identity,
          creditCustomers: [
            {
              id: 'customer-a',
              account: { id: 'account-a', balances: { currentMicro: 125_500_000 } },
            },
          ],
        },
      },
    }),
    transactionResponses: [page([transaction('purchase-a')])],
  };
}

function parse(value: unknown) {
  return parseRobinhoodCreditApi({
    fileName: 'test.json',
    text: JSON.stringify(value),
    headers: [],
    rows: [],
  });
}

describe('Robinhood credit API original-response parsing', () => {
  test('parses dollar micro-units, local dates, liabilities, and cross-source identity', () => {
    const result = parse(envelope());
    expect(result.transactions[0]).toMatchObject({
      sourceRowIndex: 0,
      date: '2026-10-01',
      amountCents: -1234,
      description: 'EXAMPLE STORE CA',
      remoteAccountId: 'robinhood:credit:account-a',
      sourceRole: 'activity',
      raw: {
        moneyId: 'robinhood-credit:purchase-a',
        crossSourceIdentity: 'robinhood-credit:examplestoreca',
      },
    });
    expect(result.transactions[0]?.raw).not.toHaveProperty('category');
    expect(result.balances[0]).toMatchObject({ date: '2026-10-01', balanceCents: -12550 });
    expect(result).toMatchObject({ coveredFrom: '2026-10-01', coveredTo: '2026-10-31' });
  });

  test('preserves two real identical purchases and removes only repeated native identities', () => {
    const value = envelope();
    value.transactionResponses = [
      page([transaction('purchase-a'), transaction('purchase-b')], 'next'),
      page([transaction('purchase-a')]),
    ];
    const result = parse(value);
    expect(result.transactions.map((row) => row?.amountCents ?? null)).toEqual([
      -1234,
      -1234,
      null,
    ]);
    expect(result.transactions[1]?.raw?.moneyId).toBe('robinhood-credit:purchase-b');
    expect(result.transactions[1]?.sourceRowIndex).toBe(1);
  });

  test('rejects conflicting repeated identities instead of dropping activity', () => {
    const value = envelope();
    value.transactionResponses.push(page([transaction('purchase-a', { amountMicro: 20_000_000 })]));
    expect(() => parse(value)).toThrow('conflicting versions');
  });

  test('imports posted payments and refunds with the opposite sign', () => {
    const value = envelope();
    value.transactionResponses = [
      page(
        ['PAYMENT', 'REFUND'].map((type, index) => {
          const row = transaction(`inbound-${index}`);
          row.details.flow = 'INBOUND';
          row.details.transactionType = type;
          return row;
        }),
      ),
    ];
    expect(parse(value).transactions.map((row) => row?.amountCents)).toEqual([1234, 1234]);
  });

  test('excludes pending, reversed, hidden, zero, and out-of-range rows', () => {
    const value = envelope();
    const pending = transaction('pending');
    pending.details.transactionStatus = 'PENDING';
    const reversed = transaction('reversed');
    reversed.details.transactionStatus = 'REVERSED';
    const hidden = transaction('hidden');
    hidden.details.visibility = 'HIDDEN_AUTO';
    value.transactionResponses = [
      page([
        pending,
        reversed,
        hidden,
        transaction('hidden-unified', { visibility: 'HIDDEN_AUTO' }),
        transaction('zero', { amountMicro: 0 }),
        transaction('outside', { at: Date.parse('2026-09-01T12:00:00Z') }),
      ]),
    ];
    expect(parse(value).transactions).toEqual([null, null, null, null, null, null]);
  });

  test('accepts empty transaction history with a verified current balance', () => {
    const value = envelope();
    value.transactionResponses = [page([])];
    expect(parse(value).transactions).toEqual([]);
    expect(parse(value).balances[0]?.balanceCents).toBe(-12550);
  });

  test('preserves overpayments as positive net-worth balances', () => {
    const value = envelope();
    const response = JSON.parse(value.accountResponse);
    response.data.authIdentity.creditCustomers[0].account.balances.currentMicro = -5_000_000;
    value.accountResponse = JSON.stringify(response);
    expect(parse(value).balances[0]?.balanceCents).toBe(500);
  });

  test('allows activity-only artifacts without inventing a balance', () => {
    const value: Record<string, unknown> = envelope();
    delete value.accountResponse;
    expect(parse(value).balances).toEqual([]);
  });

  test('rejects API errors even when partial data exists', () => {
    for (const field of ['identityResponse', 'accountResponse', 'transactionResponses'] as const) {
      const value = envelope();
      const response = JSON.stringify({
        errors: [{ message: 'private server detail' }],
        data: { authIdentity: {} },
      });
      if (field === 'transactionResponses') value[field] = [response];
      else value[field] = response;
      expect(() => parse(value)).toThrow('contains an API error');
    }
  });

  test('rejects foreign account data and banking transactions', () => {
    const value = envelope();
    value.account.id = 'another-account';
    expect(() => parse(value)).toThrow('discovered account');
    const bank = envelope();
    const row = transaction('bank');
    row.details.__typename = 'BankTransaction';
    bank.transactionResponses = [page([row])];
    expect(() => parse(bank)).toThrow('non-credit transaction');
    const balance = envelope();
    const response = JSON.parse(balance.accountResponse);
    response.data.authIdentity.creditCustomers[0].account.id = 'another-account';
    balance.accountResponse = JSON.stringify(response);
    expect(() => parse(balance)).toThrow('mismatched balance account');
  });

  test('rejects wrong date units, invalid zones, coverage dates, signs, and fractional cents', () => {
    const seconds = envelope();
    seconds.transactionResponses = [page([transaction('seconds', { at: 1_790_900_000 })])];
    expect(() => parse(seconds)).toThrow('timestamp');
    const zone = envelope();
    zone.request.timeZone = 'invalid/timezone';
    expect(() => parse(zone)).toThrow('time zone');
    const date = envelope();
    date.request.from = '2026-02-30';
    expect(() => parse(date)).toThrow('coverage date');
    const range = envelope();
    range.request.from = '2026-11-01';
    expect(() => parse(range)).toThrow('reversed coverage');
    for (const amount of [-12_340_000, 12_340_001, Number.MAX_SAFE_INTEGER + 1]) {
      const value = envelope();
      value.transactionResponses = [page([transaction('amount', { amountMicro: amount })])];
      expect(() => parse(value)).toThrow();
    }
  });

  test('requires both the connector filename and envelope marker, including truncated samples', () => {
    const file = {
      fileName: 'robinhood-credit-account-a-activity-2026-10-01-to-2026-10-31.json',
      headers: [],
      sample: JSON.stringify(envelope()),
    };
    expect(resolveImportParser(file)?.id).toBe('robinhood-credit-card-api-json');
    expect(robinhoodCreditApiParser.matches({ ...file, sample: file.sample.slice(0, 200) })).toBe(
      true,
    );
    expect(robinhoodCreditApiParser.matches({ ...file, fileName: 'unrelated.json' })).toBe(false);
    expect(robinhoodCreditApiParser.matches({ ...file, sample: '{"format":"other"}' })).toBe(false);
  });
});
