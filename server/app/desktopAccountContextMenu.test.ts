import { expect, test } from 'bun:test';
import { accountContextMenu, accountIdFromMenuEvent } from '../../desktop/accountContextMenu';

test('native edit action preserves the clicked account identity', () => {
  const menu = accountContextMenu(42);
  expect(menu).toEqual([{ label: 'Edit account…', action: 'edit-account', data: { accountId: 42 } }]);
  expect(accountIdFromMenuEvent({ data: menu[0] })).toBe(42);
});

test('unrelated and malformed native events cannot navigate to an account', () => {
  for (const event of [null, {}, { data: { action: 'other', data: { accountId: 42 } } },
    { data: { action: 'edit-account', data: { accountId: '42' } } },
    { data: { action: 'edit-account', data: { accountId: -1 } } }]) {
    expect(accountIdFromMenuEvent(event)).toBeNull();
  }
  expect(() => accountContextMenu(-1)).toThrow();
});
