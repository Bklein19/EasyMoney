import { expect, test } from 'bun:test';
import { paletteGroup } from './PalettePage';

test('palette separates semantic, accent and scoped chart tokens', () => {
  expect(paletteGroup('--color-danger')).toBe('Status');
  expect(paletteGroup('--accent-blue')).toBe('Accents');
  expect(paletteGroup('--series-gains')).toBe('Report charts');
  expect(paletteGroup('--account-series-0')).toBe('Report charts');
  expect(paletteGroup('--shadow-sm')).toBe('Shadows');
});
