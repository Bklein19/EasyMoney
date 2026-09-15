import { expect, test } from 'bun:test';
import { expandReportSelection, visibleReportAccounts } from './reportAccountSelection';

const accounts = [{ id: 1, status: 'active' }, { id: 2, status: 'closed' }, { id: 3, status: 'archived' }];
test('picker hides archived but keeps closed accounts', () => {
  expect(visibleReportAccounts(accounts).map(account => account.id)).toEqual([1, 2]);
});
test('all keeps archived history; specific and empty selections do not expand', () => {
  expect([...expandReportSelection(accounts, new Set([1, 2]))]).toEqual([1, 2, 3]);
  expect([...expandReportSelection(accounts, new Set([1]))]).toEqual([1]);
  expect([...expandReportSelection(accounts, new Set())]).toEqual([]);
});
