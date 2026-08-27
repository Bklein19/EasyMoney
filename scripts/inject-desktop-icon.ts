import fs from 'node:fs';
import path from 'node:path';
import { desktopBunVersion } from './runtimeVersions.ts';

if (process.env.ELECTROBUN_OS === 'macos') {
  const wrapperBundle = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
  const buildDirectory = process.env.ELECTROBUN_BUILD_DIR;
  const appName = process.env.ELECTROBUN_APP_NAME;
  const bundle = wrapperBundle || (buildDirectory && appName
    ? path.join(buildDirectory, `${appName}.app`)
    : null);

  if (!bundle) throw new Error('Electrobun did not provide a macOS bundle path');

  const source = path.resolve(import.meta.dir, '..', 'assets', 'AppIcon.icns');
  const destination = path.join(bundle, 'Contents', 'Resources', 'AppIcon.icns');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);

  // The post-wrap bundle is the small self-extracting launcher. The Bun
  // runtime lives in the inner application bundle checked during post-build.
  if (!wrapperBundle) {
    const runtime = path.join(bundle, 'Contents', 'MacOS', 'bun');
    const version = Bun.spawnSync([runtime, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (version.exitCode !== 0) {
      throw new Error(`Bundled Bun version check failed: ${version.stderr.toString().trim()}`);
    }

    const bundledBunVersion = version.stdout.toString().trim();
    if (bundledBunVersion !== desktopBunVersion) {
      throw new Error(
        `Bundled Bun version ${bundledBunVersion} does not match configured ${desktopBunVersion}`,
      );
    }
  }
}
