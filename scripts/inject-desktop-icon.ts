import fs from 'node:fs';
import path from 'node:path';

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
}
