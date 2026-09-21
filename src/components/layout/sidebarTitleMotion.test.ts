import { expect, test } from 'bun:test';
import { sidebarTitleMotion } from './sidebarTitleMotion';

test('sidebar title moves and shrinks continuously into the control strip', () => {
  expect(sidebarTitleMotion(0)).toEqual({ x: 52, y: 58, scale: 15 / 13, docked: false });
  expect(sidebarTitleMotion(26)).toEqual({ x: 69, y: 35.5, scale: 14 / 13, docked: false });
  expect(sidebarTitleMotion(52)).toEqual({ x: 86, y: 13, scale: 1, docked: true });
});

test('overscroll cannot move the title beyond either endpoint', () => {
  expect(sidebarTitleMotion(-20)).toEqual(sidebarTitleMotion(0));
  expect(sidebarTitleMotion(1000)).toEqual(sidebarTitleMotion(52));
});
