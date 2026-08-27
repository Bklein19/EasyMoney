import { describe, expect, test } from 'bun:test';
import packageJson from '../../package.json';
import config from '../../electrobun.config.ts';
import { desktopBunVersion } from '../../scripts/runtimeVersions.ts';

describe('Electrobun runtime', () => {
  test('pins the packaged Bun runtime to the repository Bun version', () => {
    expect(packageJson.packageManager).toBe(`bun@${desktopBunVersion}`);
    expect(config.build.bunVersion).toBe(desktopBunVersion);
  });
});
