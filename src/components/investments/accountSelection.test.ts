import { expect, test } from 'bun:test';
import { selectAccountIds } from './accountSelection';

const order = [3, 1, 4, 2]; // Display order, not numeric account order.
const click = { shift: false, additive: false };
const command = { shift: false, additive: true };
const shift = { shift: true, additive: false };

test('plain click selects only the clicked account even when already selected', () => {
  expect([...selectAccountIds(order, new Set(order), 3, 1, click)]).toEqual([1]);
});

test('command click adds and removes without mutating the previous selection', () => {
  const original = new Set([3]);
  expect([...selectAccountIds(order, original, 3, 1, command)]).toEqual([3, 1]);
  expect([...selectAccountIds(order, original, 3, 3, command)]).toEqual([]);
  expect([...original]).toEqual([3]);
});

test('shift selects an inclusive display-order range in either direction', () => {
  expect([...selectAccountIds(order, new Set([2]), 1, 2, shift)]).toEqual([1, 4, 2]);
  expect([...selectAccountIds(order, new Set([2]), 2, 1, shift)]).toEqual([1, 4, 2]);
  expect([...selectAccountIds(order, new Set(order), 1, 4, shift)]).toEqual([1, 4]);
});

test('command shift adds a range to the existing selection', () => {
  expect([...selectAccountIds(order, new Set([3]), 4, 2, { shift: true, additive: true })]).toEqual([3, 4, 2]);
});

test('missing or collapsed anchor falls back to selecting the clicked row', () => {
  expect([...selectAccountIds(order, new Set([3]), null, 1, shift)]).toEqual([1]);
  expect([...selectAccountIds([4, 2], new Set([3]), 3, 2, shift)]).toEqual([2]);
});
