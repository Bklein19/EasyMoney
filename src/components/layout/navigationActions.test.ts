import { expect, test } from 'bun:test';
import { installNavigationActions, navigationDelta } from './navigationActions';

const key = (value: string, modifiers = {}) => ({ key: value, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...modifiers });

test('browser, Command-bracket and Alt-arrow actions map to history traversal', () => {
  expect(navigationDelta(key('BrowserBack'))).toBe(-1);
  expect(navigationDelta(key('BrowserForward'))).toBe(1);
  expect(navigationDelta(key('[', { metaKey: true }))).toBe(-1);
  expect(navigationDelta(key(']', { metaKey: true }))).toBe(1);
  expect(navigationDelta(key('ArrowLeft', { altKey: true }))).toBe(-1);
  expect(navigationDelta(key('ArrowRight', { altKey: true }))).toBe(1);
  expect(navigationDelta(key('ArrowLeft'))).toBeNull();
  expect(navigationDelta(key('Backspace'))).toBeNull();
  expect(navigationDelta(key('[', { metaKey: true, shiftKey: true }))).toBeNull();
});

test('mouse back/forward traverses once, ignores normal clicks and cleans up listeners', () => {
  const target = new EventTarget();
  const moves: number[] = [];
  const remove = installNavigationActions(target as unknown as Window, delta => moves.push(delta));
  const click = (type: string, button: number) => {
    const event = Object.assign(new Event(type, { cancelable: true }), { button });
    target.dispatchEvent(event);
    return event;
  };
  expect(click('mouseup', 3).defaultPrevented).toBe(true);
  expect(click('auxclick', 3).defaultPrevented).toBe(true);
  click('mouseup', 4);
  click('mouseup', 0);
  click('mouseup', 1);
  click('mouseup', 2);
  expect(moves).toEqual([-1, 1]);
  remove();
  click('mouseup', 3);
  expect(moves).toEqual([-1, 1]);
});
