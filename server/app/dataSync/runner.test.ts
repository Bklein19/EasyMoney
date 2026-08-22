import { describe, expect, test } from 'bun:test';
import type { Page } from 'playwright';

import {
  bankOfAmericaAccountRequirements,
  collectBankOfAmericaAccountDestinations,
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

  test('BofA captures every required account destination before leaving the overview', async () => {
    const links = [
      { label: 'Adv Plus Banking - 0000', href: '/myaccounts/brain/redirect.go?kind=checking' },
      { label: 'Advantage Savings - 0000', href: '/myaccounts/brain/redirect.go?kind=savings' },
      { label: 'Credit Card - 0000', href: '/myaccounts/brain/redirect.go?kind=card' },
    ];
    const waitedFor: string[] = [];
    const page = {
      url: () => 'https://secure.bankofamerica.com/myaccounts/signin/signIn.go',
      locator: () => ({
        filter: ({ hasText }: { hasText: RegExp }) => ({
          first: () => {
            const match = links.find(link => hasText.test(link.label));
            return {
              waitFor: async () => {
                if (!match) throw new Error('missing');
                waitedFor.push(match.label);
              },
              getAttribute: async () => match?.href ?? null,
            };
          },
        }),
      }),
    } as unknown as Page;

    expect(await collectBankOfAmericaAccountDestinations(
      page,
      bankOfAmericaAccountRequirements(null),
    )).toEqual({
      checking: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?kind=checking',
      savings: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?kind=savings',
      'credit-card': 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?kind=card',
    });
    expect(waitedFor).toHaveLength(3);
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
