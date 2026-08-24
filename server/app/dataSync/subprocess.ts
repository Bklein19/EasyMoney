import { resolve } from 'node:path';

import type { SyncExecutionPlan } from './types.ts';
import { serializeSyncExecutionPlan } from './workerProtocol.ts';

const repositoryRoot = resolve(import.meta.dir, '../../..');

export function commandForSyncWorker(env: NodeJS.ProcessEnv = process.env): string[] {
  const isDesktop = env.EASYMONEY_DESKTOP === '1';
  const syncScript = isDesktop
    ? resolve(import.meta.dir, 'sync.js')
    : resolve(repositoryRoot, 'scripts/sync.ts');
  return [process.execPath, syncScript];
}

export function syncChildProcessOptions(env: NodeJS.ProcessEnv = process.env) {
  const childEnv = { ...env };
  delete childEnv.EASYMONEY_DB_PATH;
  return {
    cwd: env.EASYMONEY_DESKTOP === '1' ? import.meta.dir : repositoryRoot,
    env: childEnv,
    stdin: 'pipe' as const,
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
  };
}

export function sendSyncExecutionPlan(
  child: Pick<ReturnType<typeof Bun.spawn>, 'stdin'>,
  plan: SyncExecutionPlan,
): void {
  if (!child.stdin || typeof child.stdin === 'number') {
    throw new Error('Sync worker stdin is not writable');
  }
  child.stdin.write(serializeSyncExecutionPlan(plan));
  child.stdin.end();
}
