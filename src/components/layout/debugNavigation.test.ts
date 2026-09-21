import { expect, test } from 'bun:test';
import { debugShortcut, visibleNavigationPath } from './debugNavigation';

test('debug pages stay hidden even if pinned until explicitly enabled', () => {
  expect(visibleNavigationPath('/debug/palette', false)).toBe(false);
  expect(visibleNavigationPath('/debug/palette', true)).toBe(true);
  expect(visibleNavigationPath('/accounts', false)).toBe(true);
});
test('Command D and Control D toggle once without capturing other chords', () => {
  const event = { key: 'd', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false };
  expect(debugShortcut(event)).toBe(false);
  expect(debugShortcut({ ...event, metaKey: true })).toBe(true);
  expect(debugShortcut({ ...event, ctrlKey: true })).toBe(true);
  expect(debugShortcut({ ...event, metaKey: true, repeat: true })).toBe(false);
  expect(debugShortcut({ ...event, metaKey: true, shiftKey: true })).toBe(false);
});
