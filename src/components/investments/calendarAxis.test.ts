import { expect, test } from 'bun:test';
import { calendarTicks } from './calendarAxis';

const months = (startYear: number, years: number) => Array.from({ length: years * 12 }, (_, index) =>
  `${startYear + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`);

test('long charts anchor on January years instead of arbitrary month intervals', () => {
  const ticks = calendarTicks(['2018-12', ...months(2019, 8).slice(0, -2)], 1100);
  expect(ticks.map(tick => tick.value)).toEqual(Array.from({ length: 8 }, (_, i) => `${2019 + i}-01`));
  expect(ticks.map(tick => tick.label)).toEqual(Array.from({ length: 8 }, (_, i) => String(2019 + i)));
});

test('narrow plots thin years, not calendar alignment', () => {
  const ticks = calendarTicks(months(2019, 8), 380);
  expect(ticks.length).toBeLessThanOrEqual(3);
  expect(ticks.every(tick => tick.value.endsWith('-01'))).toBe(true);
});

test('short plots show quiet months with a prominent year at January', () => {
  const ticks = calendarTicks(['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03'], 900);
  expect(ticks.find(tick => tick.value === '2026-01')).toEqual({ value: '2026-01', label: 'Jan', year: '2026' });
  expect(ticks.find(tick => tick.value === '2025-11')).toEqual({ value: '2025-11', label: 'Nov' });
});

test('quarters and years retain calendar hierarchy', () => {
  expect(calendarTicks(['2025 Q3', '2025 Q4', '2026 Q1', '2026 Q2'], 900)).toContainEqual({ value: '2026 Q1', label: 'Q1', year: '2026' });
  expect(calendarTicks(['2024', '2025', '2026'], 900).map(tick => tick.label)).toEqual(['2024', '2025', '2026']);
});

test('partial and empty ranges remain usable, without fabricating missing points', () => {
  expect(calendarTicks([], 900)).toEqual([]);
  expect(calendarTicks(['2026-05'], 900)).toEqual([{ value: '2026-05', label: 'May', year: '2026' }]);
  expect(calendarTicks(['2024-09', '2025-03', '2026-02', '2027-04'], 900).every(tick => !tick.value.endsWith('-01'))).toBe(true);
});
