import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';

import {
  assertVanguardArtifactAccount,
  isVanguardAuthenticatedPage,
  isVanguardAuthenticatedPath,
  mapVanguardRemoteAccounts,
  parseVanguardRemoteAccount,
  runVanguardProfilesConcurrently,
  validateVanguardArtifact,
  vanguardAuthenticationAction,
  vanguardAccountLast4FromText,
  vanguardApiRequestFromForm,
  vanguardCsvAccountLast4s,
  vanguardThroughDate,
  type VanguardSyncAccount,
} from './vanguard.ts';

test('Vanguard authentication requires a signed-in portfolio route', () => {
  expect(isVanguardAuthenticatedPath('/en/investor/portfolio/dashboard/')).toBe(true);
  expect(isVanguardAuthenticatedPath('/en/investor/portfolio/transactions/history')).toBe(true);
  expect(isVanguardAuthenticatedPath('/my-account/log-on')).toBe(false);
  expect(isVanguardAuthenticatedPath('/')).toBe(false);
});

test('Vanguard authentication recognizes the signed-in download center', async () => {
  const page = {
    url: () => 'https://personal1.vanguard.com/ofu-open-fin-exchange-webapp/ofx-welcome',
    locator: () => ({ count: async () => 0 }),
    getByRole: () => ({ count: async () => 1 }),
  } as unknown as Page;

  expect(await isVanguardAuthenticatedPage(page)).toBe(true);
});

test('Vanguard authentication copy identifies the intended account holder', () => {
  expect(vanguardAuthenticationAction({ accountHolder: 'Example One' })).toBe(
    'Sign in to Vanguard for Example One and complete MFA. EasyMoney will continue automatically.',
  );
  expect(() => vanguardAuthenticationAction({ accountHolder: '   ' })).toThrow(
    'require an account holder',
  );
});

test('Vanguard caps UTC-tomorrow downloads to the local calendar date', () => {
  const lateEvening = new Date(2026, 7, 18, 23, 30);

  expect(vanguardThroughDate('2026-08-19', lateEvening)).toBe('2026-08-18');
  expect(vanguardThroughDate('2026-07-01', lateEvening)).toBe('2026-07-01');
});

test('Vanguard artifacts must match the planned account before import', () => {
  const csv = [
    'Account Number,Investment Name,Symbol,Shares,Share Price,Total Value,',
    '00001111,EXAMPLE FUND,VTI,1,100,100,',
    '',
    'Account Number,Trade Date,Settlement Date,Transaction Type,Transaction Description,Investment Name,Symbol,Shares,Share Price,Principal Amount,Commissions and Fees,Net Amount,Accrued Interest,Account Type,',
    '00001111,2026-07-16,2026-07-16,Funds Received,Electronic Bank Transfer,CASH,,0,0,400.00,0,400.00,0,CASH,',
  ].join('\n');

  expect(vanguardCsvAccountLast4s(csv)).toEqual(['1111']);
  expect(() => assertVanguardArtifactAccount('1111', ['1111'])).not.toThrow();
  expect(() => assertVanguardArtifactAccount('2222', ['1111'])).toThrow('does not match');
  expect(() => assertVanguardArtifactAccount('1111', ['1111', '2222'])).toThrow('does not match');
});

test('Vanguard discovers account identity without relying on row position or a fixed count', () => {
  expect(parseVanguardRemoteAccount('Roth IRA brokerage account ending in 2222', 4)).toEqual({
    accountKind: 'roth-ira',
    accountLast4: '2222',
    controlIndex: 4,
  });
  expect(parseVanguardRemoteAccount('Individual brokerage account XXXX1111', 1)).toEqual({
    accountKind: 'brokerage',
    accountLast4: '1111',
    controlIndex: 1,
  });
  expect(vanguardAccountLast4FromText(
    'Individual brokerage account XXXX1111 statement date 07/31/2026',
  )).toBe('1111');
});

test('Vanguard starts independent cached profiles concurrently', async () => {
  const profiles = [
    { id: 'first', session: 'vanguard-first', accountHolder: 'Example One', accounts: [] },
    { id: 'second', session: 'vanguard-second', accountHolder: 'Example Two', accounts: [] },
  ];
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const running = runVanguardProfilesConcurrently(profiles, profile => new Promise<string>(resolve => {
    started.push(profile.id);
    releases.set(profile.id, () => resolve(profile.id));
  }));

  await Promise.resolve();
  expect(started).toEqual(['first', 'second']);
  releases.get('first')!();
  releases.get('second')!();
  expect(await running).toEqual(['first', 'second']);
});

test('Vanguard maps every remote account to exactly one local route in remote order', () => {
  const planned: VanguardSyncAccount[] = [
    {
      accountId: 10,
      accountKind: 'brokerage',
      accountLast4: '1111',
      startDate: '2026-01-01',
      statementDates: [],
    },
    {
      accountId: 20,
      accountKind: 'roth-ira',
      accountLast4: '2222',
      startDate: '2026-02-01',
      statementDates: [],
    },
    {
      accountId: 30,
      accountKind: 'traditional-ira',
      accountLast4: '3333',
      startDate: '2026-03-01',
      statementDates: [],
    },
  ];
  const remote = [
    parseVanguardRemoteAccount('Traditional IRA account XXXX3333', 0),
    parseVanguardRemoteAccount('Individual brokerage account XXXX1111', 1),
    parseVanguardRemoteAccount('Roth IRA account XXXX2222', 2),
  ];

  expect(mapVanguardRemoteAccounts(remote, planned).map(account => account.planned.accountId)).toEqual([30, 10, 20]);
});

test('Vanguard rejects missing and ambiguous account routes instead of guessing', () => {
  const planned: VanguardSyncAccount[] = [{
    accountId: 10,
    accountKind: 'brokerage',
    accountLast4: '1111',
    startDate: '2026-01-01',
    statementDates: [],
  }];

  expect(() => mapVanguardRemoteAccounts([
    parseVanguardRemoteAccount('Individual brokerage account XXXX2222', 0),
  ], planned)).toThrow('no unambiguous local account route');
  expect(() => mapVanguardRemoteAccounts([
    parseVanguardRemoteAccount('Individual brokerage account XXXX1111', 0),
    parseVanguardRemoteAccount('Individual brokerage account ending in 1111', 1),
  ], planned)).toThrow('ambiguous remote account identities');
});

test('Vanguard converts authenticated form metadata into a constrained direct request', () => {
  const request = vanguardApiRequestFromForm({
    action: '/transactions/download',
    method: 'post',
    fields: [
      ['account', 'first'],
      ['account', 'second'],
      ['format', 'csv'],
    ],
  }, 'https://transactions.web.vanguard.com/activity');

  expect(request).toEqual({
    url: 'https://transactions.web.vanguard.com/transactions/download',
    method: 'POST',
    body: 'account=first&account=second&format=csv',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  expect(() => vanguardApiRequestFromForm({
    action: 'https://example.com/transactions/download',
    method: 'post',
    fields: [],
  }, 'https://transactions.web.vanguard.com/activity')).toThrow('allowed institution hosts');
  expect(() => vanguardApiRequestFromForm({
    action: 'https://login.vanguard.com/download',
    method: 'post',
    fields: [],
  }, 'https://transactions.web.vanguard.com/activity')).toThrow('allowed institution hosts');
});

test('Vanguard validates activity signature, account identity, and the matching EasyMoney parser', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vanguard-validator-'));
  const path = join(directory, 'vanguard-example-brokerage-2026-01-01-to-2026-08-01-activity.csv');
  const csv = [
    'Account Number,Investment Name,Symbol,Shares,Share Price,Total Value,',
    '00001111,EXAMPLE FUND,VTI,1,100,100,',
    '',
    'Account Number,Trade Date,Settlement Date,Transaction Type,Transaction Description,Investment Name,Symbol,Shares,Share Price,Principal Amount,Commissions and Fees,Net Amount,Accrued Interest,Account Type,',
    '00001111,2026-07-16,2026-07-16,Funds Received,Electronic Bank Transfer,CASH,,0,0,400.00,0,400.00,0,CASH,',
  ].join('\n');
  try {
    await writeFile(path, csv);
    await expect(validateVanguardArtifact(path, 'csv', '1111')).resolves.toBeUndefined();
    await expect(validateVanguardArtifact(path, 'csv', '2222')).rejects.toThrow('does not match');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Vanguard institution code uses direct requests and no fixed browser sleeps', async () => {
  const source = await Bun.file(new URL('./vanguard.ts', import.meta.url)).text();

  expect(source).toContain('page.context().request');
  expect(source).not.toContain('waitForTimeout');
  expect(source).not.toContain("waitForEvent('download'");
});
