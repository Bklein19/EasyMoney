import { expect, test } from 'bun:test';
import { paletteGroup } from './PalettePage';

test('palette separates semantic, accent and scoped chart tokens', () => {
  expect(paletteGroup('--color-danger')).toBe('Status');
  expect(paletteGroup('--color-accent')).toBe('Interaction');
  expect(paletteGroup('--series-gains')).toBe('Data visualization');
  expect(paletteGroup('--account-series-0')).toBe('Data visualization');
  expect(paletteGroup('--shadow-sm')).toBe('Shadows');
});
