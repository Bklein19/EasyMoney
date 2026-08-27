import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import electrobunConfig from '../../electrobun.config.ts';
import packageJson from '../../package.json';

const projectRoot = path.resolve(import.meta.dir, '../..');

describe('Electrobun 2 packaging contract', () => {
  test('selects Bun without Carrot or Cottontail application runtimes', () => {
    expect(packageJson.devDependencies.electrobun).toBe('2.0.1');
    expect(electrobunConfig.build?.mainProcess).toBe('bun');
    expect('cottontail' in electrobunConfig.build).toBeFalse();
    expect('carrot' in electrobunConfig.build).toBeFalse();
  });

  test('builds the React view externally with the real Bun React Compiler', () => {
    expect('views' in electrobunConfig.build).toBeFalse();
    expect(electrobunConfig.build?.copy?.dist).toBe('views/mainview');
    expect(electrobunConfig.scripts?.preBuild).toBe('scripts/build-desktop-assets.ts');

    const clientBuild = fs.readFileSync(
      path.join(projectRoot, 'scripts', 'build-client.ts'),
      'utf8',
    );
    expect(clientBuild).toContain("'--react-compiler'");
  });

  test('uses the native v2 icon pipeline and audits every standard build', () => {
    expect(electrobunConfig.build?.mac?.icons).toBe('assets/icon.iconset');

    const wrapper = fs.readFileSync(
      path.join(projectRoot, 'scripts', 'electrobun.ts'),
      'utf8',
    );
    expect(wrapper).toContain('EASYMONEY_BUN_EXECUTABLE ||= process.execPath');
    expect(wrapper).toContain('verify-electrobun-bundle.ts');
  });
});
