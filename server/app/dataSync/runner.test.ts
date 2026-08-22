import { describe, expect, test } from 'bun:test';
import type { Page } from 'playwright';

import {
  bankOfAmericaCardActivityRequest,
  bankOfAmericaCardActivityJobs,
  bankOfAmericaDepositActivityRequest,
  bankOfAmericaStatementIndexRequests,
  discoverBankOfAmericaAccounts,
  hasBankOfAmericaCreditCardActivity,
  isBankOfAmericaAuthenticatedPage,
  openBankOfAmericaAccount,
  parseBankOfAmericaArgs,
} from './institutions/bankOfAmerica.ts';
import type { VanguardSyncProfile } from './institutions/vanguard.ts';
import {
  goalWindowForCoverage,
  missingMonthlyStatementDates,
  vanguardProfileIdFromFileNames,
} from './planning.ts';
import { selectVanguardProfiles, syncTargetsForProfiles } from './targets.ts';

const vanguardProfiles: VanguardSyncProfile[] = [
  { id: 'current', session: 'vanguard-catchup', accountHolder: 'Example One', accounts: [] },
  { id: 'account-2', session: 'vanguard-account-2-catchup', accountHolder: 'Example Two', accounts: [] },
];

describe('data sync planning', () => {
  test('current sync overlaps the latest imported fact', () => {
    expect(goalWindowForCoverage(
      { kind: 'current', overlapDays: 7 },
      { latestFactDate: '2026-08-01', earliestFactDate: '2020-01-01' },
      '2026-08-16',
    )).toEqual({ startDate: '2026-07-25', endDate: '2026-08-16' });
  });

  test('current sync accepts timestamp-shaped source fact dates', () => {
    expect(goalWindowForCoverage(
      { kind: 'current', overlapDays: 7 },
      { latestFactDate: '2026-08-15T07:00:00.000Z', earliestFactDate: '2020-01-01T08:00:00.000Z' },
      '2026-08-17',
    )).toEqual({ startDate: '2026-08-08', endDate: '2026-08-17' });
  });

  test('backfill ends with overlap after the earliest imported fact', () => {
    expect(goalWindowForCoverage(
      { kind: 'backfill', stopAt: '2018-01-01' },
      { latestFactDate: '2026-08-01', earliestFactDate: '2020-01-01' },
      '2026-08-16',
    )).toEqual({ startDate: '2018-01-01', endDate: '2020-01-08' });
  });

  test('explicit ranges pass through unchanged', () => {
    expect(goalWindowForCoverage(
      { kind: 'range', startDate: '2024-01-01', endDate: '2024-12-31' },
      { latestFactDate: null, earliestFactDate: null },
      '2026-08-16',
    )).toEqual({ startDate: '2024-01-01', endDate: '2024-12-31' });
  });

  test('reports malformed source fact dates explicitly', () => {
    expect(() => goalWindowForCoverage(
      { kind: 'current', overlapDays: 7 },
      { latestFactDate: 'not-a-date', earliestFactDate: null },
      '2026-08-17',
    )).toThrow('Invalid source fact date: not-a-date');
  });

  test('BofA CLI arguments remain available through the shared implementation', () => {
    expect(parseBankOfAmericaArgs([
      '--output-dir', '/tmp/catchup',
      '--through', '2026-08-16',
      '--checking-from', '2026-08-01',
      '--savings-from', '2026-07-01',
      '--card-from', '2026-06-01',
      '--session', 'test-profile',
      '--scope', 'checking',
      '--dry-run',
    ])).toEqual({
      outputDir: '/tmp/catchup',
      through: '2026-08-16',
      checkingFrom: '2026-08-01',
      savingsFrom: '2026-07-01',
      cardFrom: '2026-06-01',
      session: 'test-profile',
      scope: 'checking',
      dryRun: true,
    });
  });

  test('BofA recognizes Accounts Overview even when the URL remains signIn.go', async () => {
    const page = {
      url: () => 'https://secure.bankofamerica.com/myaccounts/signin/signIn.go',
      title: async () => 'Bank of America | Online Banking | Accounts Overview',
      locator: () => ({ count: async () => 0 }),
    } as unknown as Page;

    expect(await isBankOfAmericaAuthenticatedPage(page)).toBe(true);
  });

  test('BofA treats a header-only credit card export as no new activity', () => {
    const header = 'Posted Date,Reference Number,Payee,Address,Amount\r\n';
    expect(hasBankOfAmericaCreditCardActivity(header)).toBe(false);
    expect(hasBankOfAmericaCreditCardActivity(`${header}08/20/2026,1,EXAMPLE SHOP,,\"-12.34\"\r\n`)).toBe(true);
  });

  test('BofA builds account-specific direct credit-card download targets', () => {
    expect(bankOfAmericaCardActivityJobs([
      { label: 'Select a period', value: '' },
      { label: 'Current transactions', value: '/card/current?' },
      { label: 'Statement Period Ending Aug 15, 2026', value: '/card/august?' },
      { label: 'Statement Period Ending Jul 15, 2026', value: '/card/july?' },
      { label: 'Statement Period Ending Jun 15, 2026', value: '/card/june?' },
    ], 'format=excel', '2026-07-01', '2026-08-22', '4321')).toEqual([
      {
        label: 'Current transactions',
        filename: 'bofa-credit-card-4321-current-to-2026-08-22.csv',
        target: '/card/current?format=excel',
      },
      {
        label: 'Statement Period Ending Aug 15, 2026',
        filename: 'bofa-credit-card-4321-period-ending-2026-08-15.csv',
        target: '/card/august?format=excel',
      },
      {
        label: 'Statement Period Ending Jul 15, 2026',
        filename: 'bofa-credit-card-4321-period-ending-2026-07-15.csv',
        target: '/card/july?format=excel',
      },
    ]);
  });

  test('BofA discovers every account link and deduplicates responsive-layout copies', async () => {
    const links = [
      { label: 'Adv Plus Banking \u2022\u2022\u2022\u2022 1111', destination: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=checking-a&target=deposit' },
      { label: 'Advantage Savings - 2222', destination: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=savings-a&target=deposit' },
      { label: 'Money Market - 3333', destination: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=deposit-a&target=deposit' },
      { label: 'Travel Rewards Visa - 4444', destination: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=card-a&target=card' },
      { label: 'Cash Rewards Credit Card - 5555', destination: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=card-b&target=card' },
      { label: 'Adv Plus Banking \u2022\u2022\u2022\u2022 1111', destination: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=checking-a&target=deposit' },
    ];
    const page = {
      url: () => 'https://secure.bankofamerica.com/myaccounts/signin/signIn.go',
      locator: () => ({
        first: () => ({ waitFor: async () => {} }),
        evaluateAll: async () => links,
      }),
    } as unknown as Page;

    const kinds = ['checking', 'savings', 'savings', 'credit-card', 'credit-card'] as const;
    expect(await discoverBankOfAmericaAccounts(page)).toEqual(links.slice(0, 5).map((link, index) => ({
      kind: kinds[index],
      last4: link.label.slice(-4),
      label: link.label,
      destination: link.destination,
    })));
  });

  test('BofA rejects ambiguous account identities instead of mixing their artifacts', async () => {
    const links = [
      { label: 'Travel Rewards Visa - 4444', destination: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=card-a&target=card' },
      { label: 'Cash Rewards Credit Card - 4444', destination: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=card-b&target=card' },
    ];
    const page = {
      url: () => 'https://secure.bankofamerica.com/myaccounts/signin/signIn.go',
      locator: () => ({
        first: () => ({ waitFor: async () => {} }),
        evaluateAll: async () => links,
      }),
    } as unknown as Page;

    await expect(discoverBankOfAmericaAccounts(page)).rejects.toThrow(
      'Multiple Bank of America credit-card accounts end in the same four digits',
    );
  });

  test('BofA constructs authenticated API requests from opaque account links', () => {
    const destination = 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=opaque-token&target=deposit';
    expect(bankOfAmericaDepositActivityRequest(destination, '2026-08-01', '2026-08-22')).toMatchObject({
      url: 'https://secure.bankofamerica.com/ogateway/addapi/v1/download/form/transaction',
      method: 'POST',
      multipart: {
        'payload.accountToken': 'opaque-token',
        'payload.txnSearchCriteria.startDate': '08/01/2026',
        'payload.txnSearchCriteria.endDate': '08/22/2026',
      },
    });
    expect(bankOfAmericaStatementIndexRequests(destination, '2025-12-01', '2026-08-22')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ adx: 'opaque-token', year: '2025' }) }),
      expect.objectContaining({ data: expect.objectContaining({ adx: 'opaque-token', year: '2026' }) }),
    ]);
    expect(bankOfAmericaCardActivityRequest(
      '/myaccounts/details/card/download-transactions.go?adx=opaque-card',
      'https://secure.bankofamerica.com/myaccounts/details/card/account-details/',
    )).toMatchObject({
      method: 'GET',
      url: 'https://secure.bankofamerica.com/myaccounts/details/card/download-transactions.go?adx=opaque-card',
    });
  });

  test('BofA opens a captured account destination without returning through sign-in', async () => {
    const navigations: Array<{ destination: string; options: unknown }> = [];
    const page = {
      goto: async (destination: string, options: unknown) => {
        navigations.push({ destination, options });
      },
    } as unknown as Page;

    await openBankOfAmericaAccount(
      page,
      'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?kind=card',
    );

    expect(navigations).toEqual([{
      destination: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?kind=card',
      options: { waitUntil: 'domcontentloaded', timeout: 30_000 },
    }]);
  });

  test('Vanguard current sync plans only missing completed statement months', () => {
    expect(missingMonthlyStatementDates(
      '2026-05-25',
      '2026-08-16',
      ['2026-05-31', '2026-07-31'],
    )).toEqual(['2026-06-30']);
  });

  test('Vanguard login profiles are recovered from committed artifact provenance', () => {
    expect(vanguardProfileIdFromFileNames(['2026-07-31-Brokerage---account-2.pdf'])).toBe('account-2');
    expect(vanguardProfileIdFromFileNames(['vanguard-roth-ira-current-2026-05-25-to-2026-08-13-activity.csv'])).toBe('current');
    expect(vanguardProfileIdFromFileNames(['vanguard-brokerage-2026-05-25-to-2026-08-13-activity.csv'])).toBe('current');
    expect(vanguardProfileIdFromFileNames(['2026-07-31-Trad-IRA---person-derived-label.pdf'])).toBeNull();
  });

  test('sync targets identify each Vanguard login by account holder', () => {
    expect(syncTargetsForProfiles(true, vanguardProfiles)).toEqual([
      { id: 'bank-of-america', institutionId: 'bank-of-america', label: 'BofA' },
      { id: 'vanguard:current', institutionId: 'vanguard', connectionId: 'current', label: 'Vanguard (Example One)' },
      { id: 'vanguard:account-2', institutionId: 'vanguard', connectionId: 'account-2', label: 'Vanguard (Example Two)' },
    ]);
  });

  test('a connection-specific Vanguard sync selects only that login profile', () => {
    expect(selectVanguardProfiles(vanguardProfiles, 'account-2')).toEqual([vanguardProfiles[1]]);
    expect(selectVanguardProfiles(vanguardProfiles)).toEqual(vanguardProfiles);
    expect(selectVanguardProfiles(vanguardProfiles, 'missing')).toEqual([]);
  });
});
