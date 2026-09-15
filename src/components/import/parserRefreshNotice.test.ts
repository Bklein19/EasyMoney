import { expect, test } from 'bun:test';
import { needsImportUpdateReview } from './parserRefreshNotice';

test('successful maintenance and background work stay quiet regardless of history', () => {
  expect(needsImportUpdateReview(undefined)).toBe(false);
  expect(needsImportUpdateReview({ running: false, issues: [] })).toBe(false);
  expect(needsImportUpdateReview({ running: true, issues: ['old issue'] })).toBe(false);
});

test('paused updates and failures remain visible', () => {
  expect(needsImportUpdateReview({ running: false, issues: ['review required'] })).toBe(true);
  expect(needsImportUpdateReview({ running: false, issues: [], error: 'failure' })).toBe(true);
});
