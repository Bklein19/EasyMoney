import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '../../..');

export function syncChildProcessOptions(env: NodeJS.ProcessEnv = process.env) {
  return {
    cwd: env.EASYMONEY_DESKTOP === '1' ? import.meta.dir : repositoryRoot,
    env: { ...env },
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
  };
}
