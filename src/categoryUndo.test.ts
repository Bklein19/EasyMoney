import { expect, test } from 'bun:test';
import { nativeUndo, registerCategoryUndo } from './categoryUndo';

function host() {
  const target = new EventTarget();
  let textUndos = 0;
  const document = {
    activeElement: { closest: () => false },
    execCommand: () => textUndos++,
  };
  return {
    target: Object.assign(target, { document }) as unknown as Window,
    document,
    textUndos: () => textUndos,
  };
}

function key(target: Window, fields: Partial<KeyboardEvent> = {}) {
  const event = Object.assign(new Event('keydown', { cancelable: true }), {
    key: 'z',
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    ...fields,
  });
  target.dispatchEvent(event);
  return event;
}

test('Command-Z and Control-Z restore category changes and unregister cleanly', async () => {
  const { target } = host();
  let restores = 0;
  const remove = registerCategoryUndo(target, {
    id: 1,
    pending: false,
    restore: async () => {
      restores++;
    },
  });
  expect(key(target).defaultPrevented).toBe(true);
  await Promise.resolve();
  expect(key(target, { metaKey: false, ctrlKey: true }).defaultPrevented).toBe(true);
  expect(restores).toBe(2);
  remove();
  expect(key(target).defaultPrevented).toBe(false);
  expect(restores).toBe(2);
});

test('native menu routes category Undo but preserves focused text undo and its fallback', async () => {
  const { target, document, textUndos } = host();
  Object.assign(target, { __electrobunWebviewId: 1 });
  let restores = 0;
  const remove = registerCategoryUndo(target, {
    id: 1,
    pending: false,
    restore: async () => {
      restores++;
    },
  });
  // Do not run twice if the native accelerator also produces a DOM keydown.
  expect(key(target).defaultPrevented).toBe(false);
  nativeUndo(target);
  expect(restores).toBe(1);
  expect(textUndos()).toBe(0);
  await Promise.resolve();
  document.activeElement.closest = () => true;
  nativeUndo(target);
  expect(restores).toBe(1);
  expect(textUndos()).toBe(1);
  remove();
  nativeUndo(target);
  expect(textUndos()).toBe(2);
});

test('only the newest available operation handles Undo, and pending/repeated commands cannot race it', async () => {
  const { target } = host();
  const restored: number[] = [];
  const old = registerCategoryUndo(target, {
    id: 1,
    pending: false,
    restore: async () => {
      restored.push(1);
    },
  });
  const recent = registerCategoryUndo(target, {
    id: 2,
    pending: false,
    restore: async () => {
      restored.push(2);
    },
  });
  key(target);
  key(target);
  expect(restored).toEqual([2]);
  await Promise.resolve();
  recent();
  const pending = registerCategoryUndo(target, {
    id: 3,
    pending: true,
    restore: async () => {
      restored.push(3);
    },
  });
  key(target);
  expect(restored).toEqual([2]);
  pending();
  old();
});

test('text fields, redo, plain Z, composition, repeated and already-handled keys are left alone', () => {
  const { target, document } = host();
  let restores = 0;
  const remove = registerCategoryUndo(target, {
    id: 1,
    pending: false,
    restore: async () => {
      restores++;
    },
  });
  for (const fields of [
    { shiftKey: true },
    { altKey: true },
    { metaKey: false },
    { isComposing: true },
    { repeat: true },
    { key: 'x' },
  ])
    expect(key(target, fields).defaultPrevented).toBe(false);
  const consumed = Object.assign(new Event('keydown', { cancelable: true }), {
    key: 'z',
    metaKey: true,
  });
  consumed.preventDefault();
  target.dispatchEvent(consumed);
  document.activeElement.closest = () => true;
  expect(key(target).defaultPrevented).toBe(false);
  expect(restores).toBe(0);
  remove();
});
