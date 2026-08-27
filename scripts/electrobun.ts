import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dir, '..');
const bootstrap = path.join(projectRoot, 'node_modules', 'electrobun', 'bin', 'electrobun.cjs');
const args = process.argv.slice(2);
const environment = { ...process.env };
environment.EASYMONEY_BUN_EXECUTABLE ||= process.execPath;

function databaseFromMainWorktree() {
  const result = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], {
    cwd: projectRoot,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (result.exitCode !== 0) return null;

  const records = result.stdout.toString().trim().split(/\n\n+/);
  const main = records.find(record => record.includes('\nbranch refs/heads/main'));
  const root = main?.split('\n').find(line => line.startsWith('worktree '))?.slice('worktree '.length);
  return root ? path.join(root, 'data', 'easymoney.sqlite') : null;
}

function developmentDatabasePath() {
  const candidates = [
    path.join(projectRoot, 'data', 'easymoney.sqlite'),
    databaseFromMainWorktree(),
  ].filter((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate)));

  return candidates.sort((left, right) => fs.statSync(right).size - fs.statSync(left).size)[0]
    ?? path.join(projectRoot, 'data', 'easymoney.sqlite');
}

if (args[0] === 'dev' || args[0] === 'run') {
  environment.EASYMONEY_DB_PATH ||= developmentDatabasePath();
  environment.EASYMONEY_ENV_PATH ||= path.join(projectRoot, '.env.local');
}

const child = Bun.spawn([process.execPath, bootstrap, ...args], {
  cwd: projectRoot,
  env: environment,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));

const exitCode = await child.exited;

if (exitCode === 0 && args[0] === 'build') {
  const environmentArgument = args.find(argument => argument.startsWith('--env=')) ?? '--env=stable';
  const verifier = Bun.spawn([
    process.execPath,
    path.join(projectRoot, 'scripts', 'verify-electrobun-bundle.ts'),
    environmentArgument,
  ], {
    cwd: projectRoot,
    env: environment,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exit(await verifier.exited);
}

process.exit(exitCode);
