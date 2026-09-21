import { expect, test } from 'bun:test';
import { readSidebarPreferences, moveSidebarPath, SIDEBAR_PATHS, DEFAULT_PRIMARY_PATHS } from './sidebarPreferences';

test('sidebar defaults and corrupt saved settings remain usable', () => {
  expect(readSidebarPreferences(null).visible).toEqual(DEFAULT_PRIMARY_PATHS);
  expect(readSidebarPreferences('oops').order).toEqual(SIDEBAR_PATHS);
});
test('sidebar preserves custom order and all-overflow choice while recovering missing routes', () => {
  const result = readSidebarPreferences(JSON.stringify({ order: ['/import', '/import', '/missing'], visible: [] }));
  expect(result.order[0]).toBe('/import');
  expect(new Set(result.order)).toEqual(new Set(SIDEBAR_PATHS));
  expect(result.visible).toEqual([]);
});
test('sidebar reordering works in both directions without losing pages', () => {
  expect(moveSidebarPath(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
  expect(moveSidebarPath(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  expect(moveSidebarPath(['a', 'b'], 'missing', 'a')).toEqual(['a', 'b']);
});
