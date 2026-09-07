import { expect, test } from 'bun:test';
import { resolveAutoGrouping } from './analyticsGrouping.ts';

test('automatic analytics grouping reaches daily detail for short ranges', () => {
  expect(resolveAutoGrouping(7).keyFormat).toBe('yyyy-MM-dd');
  expect(resolveAutoGrouping(31).keyFormat).toBe('yyyy-MM-dd');
  expect(resolveAutoGrouping(32).keyFormat).toBe('week');
  expect(resolveAutoGrouping(60).keyFormat).toBe('week');
  expect(resolveAutoGrouping(61).keyFormat).toBe('yyyy-MM');
  expect(resolveAutoGrouping(401).keyFormat).toBe('yyyy');
});
