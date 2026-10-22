import { expect, test } from 'bun:test';
import { packagedBunVersion } from '../../scripts/packaged-bun-version';
import packageJson from '../../package.json';

test('packaged runtime comes from Electrobun metadata, not the development Bun version', () => {
  expect(packageJson.packageManager).toBe('bun@1.4.3');
  expect(packagedBunVersion({ bun: '1.4.0' })).toBe('1.4.0');
  expect(packagedBunVersion({ bun: '1.4.3' })).toBe('1.4.3');
});

test('runtime audit rejects missing, invalid, and additional runtimes', () => {
  const cases: Array<Record<string, string> | undefined> = [undefined, {}, { node: '26.3.0' }, { bun: '1.4.0', cottontail: '1.0.0' }, { bun: '' }, { bun: 'latest' }];
  for (const runtimes of cases) {
    expect(() => packagedBunVersion(runtimes)).toThrow();
  }
});
