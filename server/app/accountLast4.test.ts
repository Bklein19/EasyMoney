import { expect, test } from 'bun:test';

import {
  accountLast4FromLabel,
  accountLast4FromRemoteIdentity,
  normalizeAccountLast4,
  sourceAccountLast4,
} from './accountLast4.ts';

test('account last four validation preserves leading zero and rejects other shapes', () => {
  expect(normalizeAccountLast4(' 0123 ')).toBe('0123');
  expect(normalizeAccountLast4('')).toBeNull();
  expect(() => normalizeAccountLast4('123')).toThrow('exactly four digits');
  expect(() => normalizeAccountLast4('12A4')).toThrow('exactly four digits');
  expect(() => normalizeAccountLast4('12345')).toThrow('exactly four digits');
});

test('account last four extraction only accepts explicit labels and structured remote identities', () => {
  expect(accountLast4FromLabel('Brokerage account ending in 0123')).toBe('0123');
  expect(accountLast4FromLabel('Retirement plan 98765')).toBe('8765');
  expect(accountLast4FromLabel('Investment account 123456')).toBe('3456');
  expect(accountLast4FromLabel('Retirement plan 2026')).toBeNull();
  expect(accountLast4FromLabel('Investment account 2026')).toBeNull();
  expect(accountLast4FromLabel('Activity for 2026')).toBeNull();
  expect(accountLast4FromRemoteIdentity('provider:savings:0123')).toBe('0123');
  expect(accountLast4FromRemoteIdentity('provider:Z00001234')).toBe('1234');
  expect(accountLast4FromRemoteIdentity('provider:key-abcd1234')).toBeNull();
});

test('source account last four rejects conflicting name and remote identity evidence', () => {
  expect(sourceAccountLast4({
    sourceAccountName: 'Savings ending in 0123',
    sourceAccountKey: 'provider:savings:0123',
  })).toBe('0123');
  expect(sourceAccountLast4({
    sourceAccountName: 'Savings ending in 0123',
    sourceAccountKey: 'provider:savings:4567',
  })).toBeNull();
});
