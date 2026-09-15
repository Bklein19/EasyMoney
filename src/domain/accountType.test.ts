import { expect, test } from 'bun:test';
import { ACCOUNT_TYPES, isBalanceAccount, normalizeAccountType } from './accountType';

test('legacy card spellings normalize to one liability type', () => {
  for (const type of ['credit', 'credit-card', 'credit_card', ' CREDIT ']) {
    expect(normalizeAccountType(type)).toBe('credit');
    expect(isBalanceAccount(normalizeAccountType(type))).toBe(true);
  }
});
test('all canonical types roundtrip and unknown types never become investments', () => {
  for (const type of ACCOUNT_TYPES) expect(normalizeAccountType(type)).toBe(type);
  expect(() => normalizeAccountType('cretid')).toThrow();
  expect(() => normalizeAccountType(null)).toThrow();
  expect(() => isBalanceAccount('other')).toThrow();
  expect(isBalanceAccount('investment')).toBe(false);
});
