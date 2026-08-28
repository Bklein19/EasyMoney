import { describe, expect, test } from 'bun:test';

import type {
  SyncAccountCoverage,
  SyncConnectorRunContext,
} from '../connector.ts';
import type { SyncEvent } from '../protocol.ts';
import type { BankOfAmericaSyncConfig } from './bankOfAmerica.ts';
import {
  bankOfAmericaConnector,
  createBankOfAmericaConnector,
} from './bankOfAmericaConnector.ts';

function account(overrides: Partial<SyncAccountCoverage> = {}): SyncAccountCoverage {
  return {
    id: 1,
    name: 'Checking 1111',
    institution: 'Bank of America',
    type: 'checking',
    latestFactDate: '2026-08-01',
    earliestFactDate: '2020-01-01',
    latestBalanceDate: null,
    earliestBalanceDate: null,
    balanceDates: [],
    sourceAccountName: null,
    sourceAccountNames: [],
    accountAliases: [],
    accountHolder: null,
    artifactFileNames: [],
    ...overrides,
  };
}

function runContext(
  accounts: SyncAccountCoverage[],
  report: SyncConnectorRunContext['report'] = () => {},
): SyncConnectorRunContext {
  return {
    today: '2026-08-20',
    accounts,
    goal: { kind: 'current', overlapDays: 7 },
    outputDir: '/tmp/easymoney-bofa-connector-test',
    report,
  };
}

describe('Bank of America connector', () => {
  test('discovers one institution target only when matching accounts exist', () => {
    const bofa = account();
    const other = account({
      id: 2,
      institution: 'Other Bank',
      name: 'Other checking 2222',
    });

    expect(bankOfAmericaConnector.matchesAccount(bofa)).toBe(true);
    expect(bankOfAmericaConnector.matchesAccount(other)).toBe(false);
    expect(bankOfAmericaConnector.listTargets({ today: '2026-08-20', accounts: [bofa, other] }))
      .toEqual([{ label: 'BofA' }]);
    expect(bankOfAmericaConnector.listTargets({ today: '2026-08-20', accounts: [other] }))
      .toEqual([]);
  });

  test('warns and omits accounts whose local identity is missing or ambiguous', async () => {
    let capturedConfig: BankOfAmericaSyncConfig | undefined;
    const events: Array<Omit<SyncEvent, 'runId' | 'timestamp'>> = [];
    const connector = createBankOfAmericaConnector(async config => {
      capturedConfig = config;
      return { saved: [], skipped: [], artifacts: [] };
    });

    await connector.run(runContext([
      account({ id: 1, name: 'Checking without a number' }),
      account({
        id: 2,
        name: 'Savings 2222',
        type: 'savings',
        accountAliases: ['Savings 3333'],
      }),
    ], event => events.push(event)));

    expect(capturedConfig?.accounts).toEqual([]);
    expect(events.filter(event => event.type === 'warning')).toEqual([
      expect.objectContaining({ data: { accountId: 1 } }),
      expect.objectContaining({ data: { accountId: 2 } }),
    ]);
  });

  test('prefers the confirmed account last four over ambiguous display labels', async () => {
    let capturedConfig: BankOfAmericaSyncConfig | undefined;
    const connector = createBankOfAmericaConnector(async config => {
      capturedConfig = config;
      return { saved: [], skipped: [], artifacts: [] };
    });

    await connector.run(runContext([account({
      name: 'Checking 1111',
      accountAliases: ['Checking 2222'],
      last4: '3333',
    })]));

    expect(capturedConfig?.accounts).toEqual([
      { kind: 'checking', last4: '3333', from: '2026-07-25', through: '2026-08-20' },
    ]);
  });

  test('rejects duplicate local kind and last-four identities before downloading', async () => {
    let called = false;
    const connector = createBankOfAmericaConnector(async () => {
      called = true;
      return { saved: [], skipped: [], artifacts: [] };
    });

    await expect(connector.run(runContext([
      account({ id: 1, name: 'First Visa 4444', type: 'credit' }),
      account({ id: 2, name: 'Second Card 4444', type: 'credit' }),
    ]))).rejects.toThrow('Multiple local Bank of America credit-card accounts end in 4444.');
    expect(called).toBe(false);
  });

  test('plans account-specific current windows and the low-level fallback window', async () => {
    let capturedConfig: BankOfAmericaSyncConfig | undefined;
    const connector = createBankOfAmericaConnector(async (config, onProgress) => {
      capturedConfig = config;
      onProgress?.('Downloading checking activity');
      return { saved: [], skipped: [], artifacts: [] };
    });
    const events: Array<Omit<SyncEvent, 'runId' | 'timestamp'>> = [];

    await connector.run(runContext([
      account({ id: 1, name: 'Checking 1111', latestFactDate: '2026-08-01' }),
      account({
        id: 2,
        name: 'Travel Rewards Visa 2222',
        type: 'credit',
        latestFactDate: '2026-07-15',
      }),
    ], event => events.push(event)));

    expect(capturedConfig).toEqual({
      outputDir: '/tmp/easymoney-bofa-connector-test',
      through: '2026-08-20',
      checkingThrough: '2026-08-20',
      savingsThrough: '2026-08-20',
      cardThrough: '2026-08-20',
      checkingFrom: '2025-08-20',
      savingsFrom: '2025-08-20',
      cardFrom: '2025-08-20',
      accounts: [
        { kind: 'checking', last4: '1111', from: '2026-07-25', through: '2026-08-20' },
        { kind: 'credit-card', last4: '2222', from: '2026-07-08', through: '2026-08-20' },
      ],
      session: 'bank-of-america',
      scope: null,
      dryRun: false,
    });
    expect(events).toContainEqual({ type: 'action', message: 'Downloading checking activity' });
  });

  test('routes downloaded artifacts to local accounts by kind and last four', async () => {
    const connector = createBankOfAmericaConnector(async () => ({
      saved: [
        'bofa-checking-1111-2026-08-01-to-2026-08-20.csv',
        'bofa-credit-card-2222-current-to-2026-08-20.csv',
      ],
      skipped: [],
      artifacts: [],
    }));

    await expect(connector.run(runContext([
      account({ id: 10, name: 'Checking 1111' }),
      account({ id: 20, name: 'Travel Rewards Visa 2222', type: 'credit' }),
    ]))).resolves.toEqual([
      { fileName: 'bofa-checking-1111-2026-08-01-to-2026-08-20.csv', accountId: 10 },
      { fileName: 'bofa-credit-card-2222-current-to-2026-08-20.csv', accountId: 20 },
    ]);
  });

  test('rejects artifacts that cannot route to one local account', async () => {
    const connector = createBankOfAmericaConnector(async () => ({
      saved: ['bofa-savings-1111-2026-08-01-to-2026-08-20.csv'],
      skipped: [],
      artifacts: [],
    }));

    await expect(connector.run(runContext([
      account({ id: 10, name: 'Checking 1111' }),
      account({ id: 20, name: 'Travel Rewards Visa 1111', type: 'credit' }),
    ]))).rejects.toThrow(
      'Expected one local Bank of America savings account ending in 1111, found 0.',
    );
  });
});
