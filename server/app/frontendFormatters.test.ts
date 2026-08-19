import { expect, test } from 'bun:test';

import { formatDate } from '../../src/utils/formatters.ts';

test('date-only financial facts display as calendar dates rather than UTC instants', () => {
  expect(formatDate('2026-08-15', 'medium')).toBe('Aug 15, 2026');
  expect(formatDate('2026-08-15', 'iso')).toBe('2026-08-15');
});
