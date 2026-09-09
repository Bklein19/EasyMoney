import { describe, expect, test } from 'bun:test';
import type { Page } from 'playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bankOfAmericaCardActivityRequest,
  bankOfAmericaCardActivityJobs,
  bankOfAmericaDepositActivityRequest,
  bankOfAmericaStatementIndexRequests,
  bankOfAmericaAccountsFromLinks,
  buildBankOfAmericaBrowserProgram,
  executeBankOfAmericaRequest,
  hasBankOfAmericaCreditCardActivity,
  isBankOfAmericaAuthenticatedPage,
  parseBankOfAmericaArgs,
  validateBankOfAmericaArtifact,
} from './bankOfAmerica.ts';
import { parseBankOfAmericaAccountLinks, parseBankOfAmericaCardMetadata } from './bankOfAmericaHtml.ts';

describe('Bank of America institution integration', () => {
  test('parses CLI arguments', () => {
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

  test('recognizes Accounts Overview even when the URL remains signIn.go', async () => {
    const page = {
      url: () => 'https://secure.bankofamerica.com/myaccounts/signin/signIn.go',
      title: async () => 'Bank of America | Online Banking | Accounts Overview',
      locator: () => ({ count: async () => 0 }),
    } as unknown as Page;

    expect(await isBankOfAmericaAuthenticatedPage(page)).toBe(true);
  });

  test('asks the session runner for login before attempting HTTP discovery when authentication expired', async () => {
    const program = new Function(`return (${buildBankOfAmericaBrowserProgram(parseBankOfAmericaArgs([]), [], null)});`)();
    let discoveries = 0;
    const page = {
      url: () => 'https://secure.bankofamerica.com/myaccounts/signin/signIn.go',
      title: async () => 'Bank of America | Sign In',
      locator: () => ({ count: async () => 1 }),
    } as unknown as Page;
    const result = JSON.parse(await program(page, () => {}, {
      isAuthenticated: isBankOfAmericaAuthenticatedPage,
      discoverAccounts: async () => { discoveries++; throw new Error('Discovery must wait for authentication'); },
    }));
    expect(result.status).toBe('login-required');
    expect(discoveries).toBe(0);
  });

  test('executes HTTP discovery after the authenticated overview is established', async () => {
    const program = new Function(`return (${buildBankOfAmericaBrowserProgram(parseBankOfAmericaArgs([]), [], null)});`)();
    let discoveries = 0;
    const page = {
      url: () => 'https://secure.bankofamerica.com/myaccounts/signin/signIn.go',
      title: async () => 'Bank of America | Accounts Overview',
      locator: () => ({ count: async () => 0 }),
    } as unknown as Page;
    const result = JSON.parse(await program(page, () => {}, {
      isAuthenticated: isBankOfAmericaAuthenticatedPage,
      discoverAccounts: async () => { discoveries++; throw new Error('Synthetic discovery stop'); },
    }));
    expect(result.status).toBe('error');
    expect(result.message).toBe('Synthetic discovery stop');
    expect(discoveries).toBe(1);
  });

  test('treats a header-only credit card export as no new activity', () => {
    const header = 'Posted Date,Reference Number,Payee,Address,Amount\r\n';
    expect(hasBankOfAmericaCreditCardActivity(header)).toBe(false);
    expect(hasBankOfAmericaCreditCardActivity(`${header}08/20/2026,1,EXAMPLE SHOP,,\"-12.34\"\r\n`)).toBe(true);
  });

  test('builds account-specific direct credit-card download targets', () => {
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

  test('discovers every account link and deduplicates responsive-layout copies', async () => {
    const links = [
      { label: 'Adv Plus Banking \u2022\u2022\u2022\u2022 1111', destination: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=checking-a&target=deposit' },
      { label: 'Advantage Savings - 2222', destination: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=savings-a&target=deposit' },
      { label: 'Money Market - 3333', destination: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=deposit-a&target=deposit' },
      { label: 'Travel Rewards Visa - 4444', destination: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=card-a&target=card' },
      { label: 'Cash Rewards Credit Card - 5555', destination: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=card-b&target=card' },
      { label: 'Adv Plus Banking \u2022\u2022\u2022\u2022 1111', destination: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=checking-a&target=deposit' },
    ];
    const kinds = ['checking', 'savings', 'savings', 'credit-card', 'credit-card'] as const;
    expect(bankOfAmericaAccountsFromLinks(links)).toEqual(links.slice(0, 5).map((link, index) => ({
      kind: kinds[index],
      last4: link.label.slice(-4),
      label: link.label,
      destination: link.destination,
    })));
  });

  test('rejects ambiguous account identities instead of mixing their artifacts', async () => {
    const links = [
      { label: 'Travel Rewards Visa - 4444', destination: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=card-a&target=card' },
      { label: 'Cash Rewards Credit Card - 4444', destination: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=card-b&target=card' },
    ];
    expect(() => bankOfAmericaAccountsFromLinks(links)).toThrow(
      'Multiple Bank of America credit-card accounts end in the same four digits',
    );
  });

  test('constructs authenticated API requests from opaque account links', () => {
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

  test('reads nested labels and encoded account links from server HTML', () => {
    const links = parseBankOfAmericaAccountLinks('<a href="/myaccounts/brain/redirect.go?adx=synthetic&amp;target=card"><span>Visa</span> &#8226;&#8226;&#8226;&#8226; 4444</a>', 'https://secure.bankofamerica.com/');
    expect(bankOfAmericaAccountsFromLinks(links)).toMatchObject([{ kind: 'credit-card', last4: '4444', destination: 'https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=synthetic&target=card' }]);
  });

  test('reads dynamic export parameters from server HTML without DOM selection', () => {
    const metadata = parseBankOfAmericaCardMetadata('<select id="select_transaction"><option value="">Choose</option><option value="/myaccounts/details/card/download-transactions.go?adx=synthetic&amp;period=current&amp;">Current transactions</option></select><select id="select_filetype"><option value="format=excel">Microsoft Excel Format</option></select>');
    expect(metadata.periods[1]!.value).toBe('/myaccounts/details/card/download-transactions.go?adx=synthetic&period=current&');
    expect(metadata.excelFileTypeValue).toBe('format=excel');
    expect(() => parseBankOfAmericaCardMetadata('<html>Sign in</html>')).toThrow('download format');
  });

  test('sends deposit multipart through the authenticated HTTP context', async () => {
    let fields: FormData | undefined;
    const page = {
      url: () => 'https://secure.bankofamerica.com/accounts',
      request: { fetch: async (url: string, options: { headers: Record<string, string>; data: Buffer }) => {
        fields = await new Response(new Uint8Array(options.data), { headers: options.headers }).formData();
        return {
          status: () => 200, statusText: () => 'OK', url: () => url,
          headersArray: () => [{ name: 'content-type', value: 'text/csv' }],
          body: async () => Buffer.from('synthetic csv'), dispose: async () => {},
        };
      } },
    } as unknown as Page;
    const request = bankOfAmericaDepositActivityRequest('https://secure.bankofamerica.com/myaccounts/brain/redirect.go?adx=synthetic', '2026-08-01', '2026-08-22');
    const result = await executeBankOfAmericaRequest(page, request);
    expect(Object.fromEntries(fields!)).toEqual(request.multipart!);
    expect(result.body.toString()).toBe('synthetic csv');
  });

  test('parser-validates credit exports and rejects silent row loss', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bofa-validation-'));
    const path = join(directory, 'bofa-credit-card-1234-current-to-2026-08-22.csv');
    const header = 'Posted Date,Reference Number,Payee,Address,Amount\n';
    try {
      await writeFile(path, `${header}08/20/2026,synthetic,EXAMPLE SHOP,,-1.00\n`);
      expect(await validateBankOfAmericaArtifact(path)).toMatchObject({ transactionCount: 1, balanceCount: 0 });
      await writeFile(path, `${header}not-a-date,synthetic,EXAMPLE SHOP,,-1.00\n`);
      await expect(validateBankOfAmericaArtifact(path)).rejects.toThrow('every transaction row');
      await writeFile(path, header);
      expect(await validateBankOfAmericaArtifact(path)).toMatchObject({ transactionCount: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
