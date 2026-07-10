import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPlaidLinkToken,
  exchangePlaidPublicToken,
  getPlaidConfigurationStatus,
  listPlaidConnections,
  previewPlaidConnection,
  type PlaidClientLike,
} from './plaid.ts';

let temporaryDirectory = '';
const originalEnvironment = { ...process.env };

beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'easymoney-plaid-'));
  process.env.PLAID_ITEMS_PATH = path.join(temporaryDirectory, 'items.json');
  process.env.PLAID_ENV = 'sandbox';
  process.env.PLAID_CLIENT_ID = 'test-client';
  process.env.PLAID_SANDBOX_SECRET = 'test-secret';
  delete process.env.PLAID_PRODUCTION_SECRET;
  delete process.env.PLAID_SECRET;
  delete process.env.PLAID_REDIRECT_URI;
});

afterEach(() => {
  process.env = { ...originalEnvironment };
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

function fakeClient(overrides: Partial<PlaidClientLike> = {}) {
  const client: PlaidClientLike = {
    linkTokenCreate: async () => ({ data: { link_token: 'link-token', expiration: '2026-07-10T00:00:00Z' } }),
    itemPublicTokenExchange: async () => ({ data: { item_id: 'item-1', access_token: 'access-secret' } }),
    accountsGet: async () => ({
      data: {
        accounts: [{
          account_id: 'account-1',
          name: 'Checking',
          official_name: 'Checking account',
          mask: '1234',
          type: 'depository',
          subtype: 'checking',
          balances: { available: 900, current: 1000, limit: null, iso_currency_code: 'USD' },
        }],
      },
    }),
    transactionsSync: async () => ({
      data: {
        added: [{
          transaction_id: 'transaction-1',
          account_id: 'account-1',
          date: '2026-07-01',
          name: 'Coffee',
          merchant_name: 'Coffee Shop',
          amount: 5,
          pending: false,
          iso_currency_code: 'USD',
        }],
        modified: [],
        removed: [],
        has_more: false,
        transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
      },
    }),
    investmentsHoldingsGet: async () => ({ data: { holdings: [], securities: [] } }),
    investmentsTransactionsGet: async () => ({ data: { investment_transactions: [], total_investment_transactions: 0 } }),
    statementsList: async () => ({ data: { accounts: [] } }),
    statementsDownload: async () => ({ data: new Uint8Array() }),
    itemRemove: async () => ({ data: {} }),
    ...overrides,
  };
  return client;
}

test('reports environment-specific Plaid configuration without exposing secrets', () => {
  expect(getPlaidConfigurationStatus()).toEqual({
    configured: true,
    environment: 'sandbox',
    missingVariables: [],
    redirectUriConfigured: false,
  });

  process.env.PLAID_ENV = 'production';
  expect(getPlaidConfigurationStatus()).toEqual({
    configured: false,
    environment: 'production',
    missingVariables: ['PLAID_PRODUCTION_SECRET'],
    redirectUriConfigured: false,
  });
});

test('bank Link requests transactions and statements without requiring investment support', async () => {
  const capturedRequests: Record<string, unknown>[] = [];
  const client = fakeClient({
    linkTokenCreate: async request => {
      capturedRequests.push(request);
      return { data: { link_token: 'link-token', expiration: '2026-07-10T00:00:00Z' } };
    },
  });

  const result = await createPlaidLinkToken('bank', client);
  const capturedRequest = capturedRequests[0]!;

  expect(result.linkToken).toBe('link-token');
  expect(capturedRequest.products).toEqual(['transactions']);
  expect(capturedRequest.required_if_supported_products).toEqual(['statements']);
  expect(capturedRequest).not.toHaveProperty('optional_products');
  expect(capturedRequest.transactions).toEqual({ days_requested: 730 });
});

test('sanitizes Plaid SDK errors before they leave the service boundary', async () => {
  const client = fakeClient({
    linkTokenCreate: async () => {
      const error = new Error('Request failed with secret-bearing configuration') as Error & { response?: unknown };
      error.response = { data: { error_code: 'INVALID_API_KEYS', error_message: 'invalid client_id or secret' } };
      throw error;
    },
  });

  expect(createPlaidLinkToken('bank', client)).rejects.toThrow('invalid client_id or secret (INVALID_API_KEYS)');
});

test('persists exchanged Items locally but never returns their access token', async () => {
  const connection = await exchangePlaidPublicToken({
    publicToken: 'public-token',
    kind: 'bank',
    institutionId: 'ins-1',
    institutionName: 'Test Bank',
  }, fakeClient());

  expect(connection).not.toHaveProperty('accessToken');
  expect(listPlaidConnections()).toEqual([connection]);
  const storedText = fs.readFileSync(process.env.PLAID_ITEMS_PATH!, 'utf8');
  expect(storedText).toContain('access-secret');
  expect(fs.statSync(process.env.PLAID_ITEMS_PATH!).mode & 0o777).toBe(0o600);
});

test('previews account and transaction data while isolating unavailable Statements', async () => {
  const client = fakeClient({
    statementsList: async () => {
      const error = new Error('request failed') as Error & { response?: unknown };
      error.response = { data: { error_code: 'PRODUCT_NOT_READY', error_message: 'Statements are not ready' } };
      throw error;
    },
  });
  await exchangePlaidPublicToken({
    publicToken: 'public-token',
    kind: 'bank',
    institutionName: 'Test Bank',
  }, client);

  const preview = await previewPlaidConnection('item-1', client);

  expect(preview.accounts[0]).toMatchObject({ name: 'Checking', mask: '1234' });
  expect(preview.transactions.status).toBe('available');
  expect(preview.transactions.data?.added[0]).toMatchObject({ merchantName: 'Coffee Shop', amount: 5 });
  expect(preview.statements).toEqual({
    status: 'unavailable',
    data: null,
    error: 'Statements are not ready (PRODUCT_NOT_READY)',
  });
});
