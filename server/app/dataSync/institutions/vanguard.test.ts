import { expect, test } from 'bun:test';
import type { Page } from 'playwright';

import {
  assertVanguardArtifactAccount,
  isVanguardAuthenticatedPage,
  isVanguardAuthenticatedPath,
  vanguardCsvAccountLast4s,
  vanguardThroughDate,
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
