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

    const webHtml = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
    const desktopHtml = fs.readFileSync(
      path.join(projectRoot, 'desktop', 'index.html'),
      'utf8',
    );
    expect(webHtml).not.toContain('easymoney-desktop');
    expect(desktopHtml).toContain('<body class="easymoney-desktop">');

    const desktopBuild = fs.readFileSync(
      path.join(projectRoot, 'scripts', 'build-desktop-assets.ts'),
      'utf8',
    );
    expect(desktopBuild).toContain("'--desktop'");
  });

  test('uses the native v2 icon pipeline and audits every standard build', () => {
    expect(electrobunConfig.build?.mac?.icons).toBe('assets/icon.iconset');

    const wrapper = fs.readFileSync(
      path.join(projectRoot, 'scripts', 'electrobun.ts'),
      'utf8',
    );
    expect(wrapper).toContain('EASYMONEY_BUN_EXECUTABLE ||= process.execPath');
    expect(wrapper).toContain('EASYMONEY_LEGACY_DB_PATH ||= developmentDatabasePath()');
    expect(wrapper).not.toContain('EASYMONEY_DB_PATH ||= developmentDatabasePath()');
    expect(wrapper).toContain('verify-electrobun-bundle.ts');
  });

  test('keeps generated files and mutable development data out of the rebuild watcher', () => {
    const ignoredPaths = new Set(electrobunConfig.build?.watchIgnore ?? []);
    for (const pathPattern of [
      'dist/**',
      'desktop-dist/**',
      'data/**',
      '.env.local',
      '.git/**',
    ]) {
      expect(ignoredPaths.has(pathPattern)).toBeTrue();
    }
  });
});
