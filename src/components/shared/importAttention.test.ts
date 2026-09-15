import { expect, test } from 'bun:test';
import { importAttentionMessage } from './importAttention';

test('quiet while loading or healthy; failed checks are not reported as healthy', () => {
  expect(importAttentionMessage(undefined)).toBeNull();
  expect(importAttentionMessage([])).toBeNull();
  expect(importAttentionMessage([{ closed: false, transactionCoverage: 'declared', balanceStatus: 'current' }])).toBeNull();
  expect(importAttentionMessage(undefined, true)).toContain('Unable to check');
});

test('counts each open account once and excludes closed accounts', () => {
  expect(importAttentionMessage([
    { closed: false, transactionCoverage: 'unverified', balanceStatus: 'stale' },
    { closed: true, transactionCoverage: 'unverified', balanceStatus: 'missing' },
  ])).toStartWith('1 account with');
  expect(importAttentionMessage([
    { closed: false, transactionCoverage: 'declared', balanceStatus: 'missing' },
    { closed: false, transactionCoverage: 'unverified', balanceStatus: 'current' },
  ])).toStartWith('2 accounts with');
});
