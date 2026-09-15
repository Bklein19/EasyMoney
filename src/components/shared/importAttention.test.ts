import { expect, test } from 'bun:test';
import { importAttentionMessage } from './importAttention';

test('quiet while loading or healthy; failed checks are not reported as healthy', () => {
  expect(importAttentionMessage(undefined)).toBeNull();
  expect(importAttentionMessage([])).toBeNull();
  expect(importAttentionMessage([{ status: 'current', balanceStatus: 'current' }])).toBeNull();
  expect(importAttentionMessage(undefined, true)).toContain('Unable to check');
});

test('counts each open account once and excludes closed accounts', () => {
  expect(importAttentionMessage([
    { status: 'stale', balanceStatus: 'stale' },
    { status: 'closed', balanceStatus: 'closed' },
  ])).toStartWith('1 account due');
  expect(importAttentionMessage([
    { status: 'current', balanceStatus: 'no-data' },
    { status: 'due', balanceStatus: 'current' },
  ])).toStartWith('2 accounts due');
});
