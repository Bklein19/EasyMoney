import { expect, test } from 'bun:test';
import { calendarDate } from './calendarDate';

test('calendar dates preserve the printed day, reject rollover and do not depend on time zones', () => {
  for (const value of ['2026-01-05', '1/5/2026', '01/05/2026']) expect(calendarDate(value)).toBe('2026-01-05');
  expect(calendarDate('2/29/2024')).toBe('2024-02-29');
  for (const value of ['2026-02-29', '2/30/2024', '2026-13-01', '0/1/2026', '1/0/2026', '2026-01-01T23:00:00-08:00']) expect(calendarDate(value)).toBeNull();
  expect(calendarDate('1/5/26')).toBeNull();
  expect(calendarDate('1/5/26', true)).toBe('2026-01-05');
});
