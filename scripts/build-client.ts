import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const rootDir = path.resolve(import.meta.dir, '..');
const distDir = path.join(rootDir, 'dist');
const args = process.argv.slice(2);
const isProduction = process.env.NODE_ENV === 'production' || args.includes('--production');
const entrypoint = args.includes('--desktop') ? './desktop/index.html' : './index.html';

await fs.rm(distDir, { recursive: true, force: true });

const buildArgs = [
  'build',
  entrypoint,
  '--outdir',
  './dist',
  '--target',
  'browser',
  '--react-compiler',
];

if (isProduction) buildArgs.push('--production');
if (args.includes('--watch')) buildArgs.push('--watch');

const child = spawn('bun', buildArgs, {
  cwd: rootDir,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
