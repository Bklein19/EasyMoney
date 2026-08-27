import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electrobunConfig from '../electrobun.config.ts';
import packageJson from '../package.json';

type BuildManifest = {
  mainProcess?: string;
  electrobunVersion?: string;
  runtimeVersions?: Record<string, string>;
};

const projectRoot = path.resolve(import.meta.dir, '..');
if (process.platform !== 'darwin') {
  console.log('Skipping the macOS Electrobun app bundle audit on this platform');
  process.exit(0);
}
const requestedEnvironment = process.argv
  .slice(2)
  .find(argument => argument.startsWith('--env='))
  ?.slice('--env='.length) || 'stable';
const buildDirectory = path.join(
  projectRoot,
  'build',
  `${requestedEnvironment}-macos-${process.arch}`,
);
const forbiddenRuntimeName = /(^|[-_.])(hutch(?:-engine)?|cottontail)(?:[-_.]|$)/i;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? [entryPath, ...walk(entryPath)] : [entryPath];
  });
}

assert(fs.existsSync(buildDirectory), `Missing Electrobun build directory: ${buildDirectory}`);
const outerBundleNames = fs.readdirSync(buildDirectory)
  .filter(fileName => fileName.endsWith('.app'));
assert(
  outerBundleNames.length === 1,
  `Expected one Electrobun app bundle, found ${outerBundleNames.length}`,
);
const outerBundle = path.join(buildDirectory, outerBundleNames[0]!);
const outerResources = path.join(outerBundle, 'Contents', 'Resources');
const payloadArchives = fs.readdirSync(outerResources)
  .filter(fileName => fileName.endsWith('.tar.zst'));
assert(payloadArchives.length <= 1, `Expected at most one packaged app payload, found ${payloadArchives.length}`);

const extractionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'easymoney-bundle-audit-'));
try {
  let innerBundle = outerBundle;
  if (payloadArchives.length === 1) {
    const extractResult = Bun.spawnSync([
      'tar',
      '--extract',
      '--zstd',
      '--file',
      path.join(outerResources, payloadArchives[0]!),
      '--directory',
      extractionDirectory,
    ], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert(
      extractResult.exitCode === 0,
      `Could not extract packaged app payload: ${extractResult.stderr.toString().trim()}`,
    );
    const innerBundleNames = fs.readdirSync(extractionDirectory)
      .filter(fileName => fileName.endsWith('.app'));
    assert(
      innerBundleNames.length === 1,
      `Expected one app in the packaged payload, found ${innerBundleNames.length}`,
    );
    innerBundle = path.join(extractionDirectory, innerBundleNames[0]!);
  }
  const packagedPaths = [
    ...walk(outerBundle).map(filePath => `wrapper/${path.relative(outerBundle, filePath)}`),
    ...(innerBundle === outerBundle
      ? []
      : walk(innerBundle).map(filePath => `payload/${path.relative(innerBundle, filePath)}`)),
  ];
  const forbiddenFiles = packagedPaths.filter(relativePath => forbiddenRuntimeName.test(relativePath));
  assert(
    forbiddenFiles.length === 0,
    `Forbidden Hutch or Cottontail runtime files were packaged: ${forbiddenFiles.join(', ')}`,
  );

  const resources = path.join(innerBundle, 'Contents', 'Resources');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(resources, 'build.json'), 'utf8'),
  ) as BuildManifest;
  const expectedElectrobunVersion = packageJson.devDependencies.electrobun;
  const expectedBunVersion = packageJson.packageManager.replace(/^bun@/, '');

  assert(manifest.mainProcess === 'bun', 'Packaged main process is not Bun');
  assert(
    manifest.electrobunVersion === expectedElectrobunVersion,
    `Expected Electrobun ${expectedElectrobunVersion}, found ${manifest.electrobunVersion ?? 'unknown'}`,
  );
  const runtimeNames = Object.keys(manifest.runtimeVersions ?? {}).sort();
  assert(
    runtimeNames.length === 1 && runtimeNames[0] === 'bun',
    `Unexpected packaged runtimes: ${JSON.stringify(manifest.runtimeVersions)}`,
  );
  assert(
    manifest.runtimeVersions?.bun === expectedBunVersion,
    `Expected Bun runtime ${expectedBunVersion}, found ${manifest.runtimeVersions?.bun ?? 'unknown'}`,
  );

  const packagedBun = path.join(innerBundle, 'Contents', 'MacOS', 'bun');
  assert(fs.existsSync(packagedBun), 'Packaged Bun executable is missing');
  const versionResult = Bun.spawnSync([packagedBun, '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assert(versionResult.exitCode === 0, 'Packaged Bun executable did not run');
  const actualBunVersion = versionResult.stdout.toString().trim();
  assert(
    actualBunVersion === expectedBunVersion,
    `Expected packaged Bun ${expectedBunVersion}, found ${actualBunVersion}`,
  );

  for (const requiredPath of [
    path.join(resources, 'app', 'bun', 'index.js'),
    path.join(resources, 'app', 'bun', 'sync.js'),
    path.join(resources, 'app', 'views', 'mainview', 'index.html'),
  ]) {
    assert(fs.existsSync(requiredPath), `Missing packaged application file: ${requiredPath}`);
  }

  console.log(
    `Verified Electrobun ${expectedElectrobunVersion}: Bun ${actualBunVersion} main process; no Hutch or Cottontail runtime files`,
  );
} finally {
  fs.rmSync(extractionDirectory, { recursive: true, force: true });
}
