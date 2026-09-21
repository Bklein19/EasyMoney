import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { CHART_SERIES_COLORS } from './chartColors';

const root = path.resolve(import.meta.dir, '..');
const files = [...new Bun.Glob('**/*.{css,ts,tsx,js,jsx}').scanSync({ cwd: root })].filter(file => !file.includes('.test.'));
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const definitions = new Set(files.flatMap(file => [...source(file).matchAll(/['"]?(--[\w-]+)['"]?\s*:/g)].map(match => match[1])));

test('component colors use tokens instead of hardcoded hex or RGB', () => {
  const violations = files.filter(file => file.startsWith('components/')).filter(file => /#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i.test(source(file)));
  expect(violations).toEqual([]);
});

test('static token references resolve to a declared token', () => {
  const missing = files.flatMap(file => [...source(file).matchAll(/var\((--[\w-]+)\s*[,)]/g)].filter(match => !definitions.has(match[1]!)).map(match => `${file}: ${match[1]}`));
  expect(missing).toEqual([]);
  for (const color of CHART_SERIES_COLORS) expect(definitions.has(color.slice(4, -1))).toBe(true);
});

test('data series have independent light values and no UI-status dependencies', () => {
  const css = source('styles/chartColors.css');
  const light = css.split('@media (prefers-color-scheme: light)')[1]!;
  for (const name of ['--data-income', '--data-expense', '--data-investment', ...CHART_SERIES_COLORS.map(color => color.slice(4, -1))]) {
    expect(light).toContain(`${name}:`);
  }
  expect(css).not.toMatch(/var\(--color-(warning|success|danger)/);
});
