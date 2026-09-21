import { expect, test } from 'bun:test';
import { insideMenuCorridor } from './useMenuAim';

test('diagonal travel into a right submenu stays in its safe triangle', () => {
  const panel = { left: 200, right: 400, top: 100, bottom: 400 };
  expect(insideMenuCorridor({ x: 150, y: 175 }, { x: 100, y: 250 }, panel)).toBe(true);
  expect(insideMenuCorridor({ x: 150, y: 325 }, { x: 100, y: 250 }, panel)).toBe(true);
  expect(insideMenuCorridor({ x: 90, y: 250 }, { x: 100, y: 250 }, panel)).toBe(false);
  expect(insideMenuCorridor({ x: 150, y: 80 }, { x: 100, y: 250 }, panel)).toBe(false);
});
test('safe triangle works for left-opening menus and rejects degenerate geometry', () => {
  const panel = { left: 10, right: 200, top: 100, bottom: 400 };
  expect(insideMenuCorridor({ x: 250, y: 175 }, { x: 300, y: 250 }, panel)).toBe(true);
  expect(insideMenuCorridor({ x: 310, y: 250 }, { x: 300, y: 250 }, panel)).toBe(false);
  expect(insideMenuCorridor({ x: 200, y: 250 }, { x: 200, y: 250 }, panel)).toBe(false);
});
