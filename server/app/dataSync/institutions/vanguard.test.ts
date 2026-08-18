import { expect, test } from 'bun:test';

import {
  assertVanguardArtifactAccount,
  isVanguardAuthenticatedPath,
  vanguardCsvAccountLast4s,
} from './vanguard.ts';

test('Vanguard authentication requires a signed-in portfolio route', () => {
  expect(isVanguardAuthenticatedPath('/en/investor/portfolio/dashboard/')).toBe(true);
  expect(isVanguardAuthenticatedPath('/en/investor/portfolio/transactions/history')).toBe(true);
  expect(isVanguardAuthenticatedPath('/my-account/log-on')).toBe(false);
  expect(isVanguardAuthenticatedPath('/')).toBe(false);
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
