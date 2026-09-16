import { expect, test } from 'bun:test';
import { needsImportUpdateReview, recategorizationNotice } from './parserRefreshNotice';

test('successful maintenance and background work stay quiet regardless of history', () => {
  expect(needsImportUpdateReview(undefined)).toBe(false);
  expect(needsImportUpdateReview({ running: false, issues: [] })).toBe(false);
  expect(needsImportUpdateReview({ running: true, issues: ['old issue'] })).toBe(false);
});

test('paused updates and failures remain visible', () => {
  expect(needsImportUpdateReview({ running: false, issues: ['review required'] })).toBe(true);
  expect(needsImportUpdateReview({ running: false, issues: [], error: 'failure' })).toBe(true);
});

test('recategorization notice counts preserved choices, not history or inferred new transactions', () => {
  expect(recategorizationNotice([])).toEqual({ revision: 0, count: 0 });
  expect(recategorizationNotice([
    { id: 1, ledgerTransactionId: 'old', disposition: 'recategorization-needed' },
    { id: 2, ledgerTransactionId: 'old', disposition: 'recategorization-needed' },
    { id: 3, ledgerTransactionId: 'other', disposition: 'retained-history' },
  ])).toEqual({ revision: 2, count: 1 });
});
