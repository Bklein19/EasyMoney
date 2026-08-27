import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const bunExecutable = process.env.EASYMONEY_BUN_EXECUTABLE || 'bun';
const isProduction = process.env.ELECTROBUN_BUILD_ENV !== 'dev';

async function runBunScript(script: string, args: string[] = []) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bunExecutable, [script, ...args], {
      cwd: root,
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${script} was terminated by ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${script} exited with status ${code ?? 'unknown'}`));
        return;
      }
      resolve();
    });
  });
}

await runBunScript('scripts/build-client.ts', [
  '--desktop',
  ...(isProduction ? ['--production'] : []),
]);
await runBunScript('scripts/build-desktop-sync.ts');
