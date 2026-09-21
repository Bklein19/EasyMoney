import { expect, test } from 'bun:test';
import { initializePalette, readPalette } from './palette';

test('existing and unknown preferences retain the default palette', () => {
  for (const value of [null, '', 'default', 'dark', 'unknown']) expect(readPalette(value)).toBe('default');
  expect(readPalette('banknote')).toBe('banknote');
});

test('startup restores the palette without overriding system appearance', () => {
  const dataset: Record<string, string> = {};
  const target = { localStorage: { getItem: () => 'banknote' }, document: { documentElement: { dataset } } };
  initializePalette(target as unknown as Window);
  expect(dataset).toEqual({ palette: 'banknote' });
});

test('startup works when browser storage is unavailable', () => {
  const dataset: Record<string, string> = {};
  const target = { get localStorage() { throw new Error('Unavailable'); }, document: { documentElement: { dataset } } };
  initializePalette(target as unknown as Window);
  expect(dataset.palette).toBe('default');
});

test('Banknote text and primary actions meet normal-text contrast in both appearances', async () => {
  const css = await Bun.file(`${import.meta.dir}/banknote.css`).text();
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
  };
  for (const mode of css.split('@media')) {
    const token = (name: string) => mode.match(new RegExp(`${name}:\\s*(#[a-fA-F0-9]{6})`))![1]!;
    for (const [fg, bg] of [['--text-primary', '--bg-base'], ['--text-secondary', '--bg-base'], ['--text-muted', '--bg-base'], ['--action-primary-text', '--action-primary']]) {
      const a = luminance(token(fg!)), b = luminance(token(bg!));
      expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toBeGreaterThanOrEqual(4.5);
    }
  }
});
