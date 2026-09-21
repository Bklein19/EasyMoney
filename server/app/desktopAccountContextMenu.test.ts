import { expect, test } from 'bun:test';
import { accountContextMenu, accountIdFromMenuEvent } from '../../desktop/accountContextMenu';

test('native edit action preserves the clicked account identity', () => {
  const menu = accountContextMenu({ accountId: 42, name: 'Checking', institution: 'Bank', owner: 'Annie' });
  expect(menu).toEqual([
    { label: 'Checking', enabled: false },
    { label: 'Bank · Annie', enabled: false },
    { type: 'divider' },
    { label: 'Edit…', action: 'edit-account', data: { accountId: 42 } },
  ]);
  expect(accountIdFromMenuEvent({ data: menu[3] })).toBe(42);
  expect(accountIdFromMenuEvent({ data: menu[0] })).toBeNull();
});

test('unrelated and malformed native events cannot navigate to an account', () => {
  for (const event of [null, {}, { data: { action: 'other', data: { accountId: 42 } } },
    { data: { action: 'edit-account', data: { accountId: '42' } } },
    { data: { action: 'edit-account', data: { accountId: -1 } } }]) {
    expect(accountIdFromMenuEvent(event)).toBeNull();
  }
  expect(() => accountContextMenu({ accountId: -1, name: 'Invalid' })).toThrow();
});

test('missing metadata does not leave an empty native menu row', () => {
  expect(accountContextMenu({ accountId: 1, name: 'Savings' })).toHaveLength(3);
});
