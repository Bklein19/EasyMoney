import { expect, test } from 'bun:test';

import { isVanguardAuthenticatedPath } from './vanguard.ts';

test('Vanguard authentication requires a signed-in portfolio route', () => {
  expect(isVanguardAuthenticatedPath('/en/investor/portfolio/dashboard/')).toBe(true);
  expect(isVanguardAuthenticatedPath('/en/investor/portfolio/transactions/history')).toBe(true);
  expect(isVanguardAuthenticatedPath('/my-account/log-on')).toBe(false);
  expect(isVanguardAuthenticatedPath('/')).toBe(false);
});
