import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  SYNC_WORKER_PROTOCOL_VERSION,
  type SyncExecutionPlan,
} from './types.ts';
import {
  parseSyncExecutionPlan,
  parseSyncWorkerLine,
  parseSyncWorkerMessage,
  serializeSyncExecutionPlan,
  serializeSyncWorkerLine,
} from './workerProtocol.ts';

function executionPlan(outputDir = '/runtime/sync/artifacts'): SyncExecutionPlan {
  return {
    protocolVersion: SYNC_WORKER_PROTOCOL_VERSION,
    runId: 'sync-vanguard-test',
    institutionId: 'vanguard',
    today: '2026-08-24',
    accounts: [{
      id: 42,
      name: 'Synthetic Brokerage 1234',
      institution: 'Vanguard',
      type: 'investment',
      latestFactDate: '2026-08-01',
      earliestFactDate: '2025-01-01',
      latestBalanceDate: '2026-07-31',
      earliestBalanceDate: '2025-01-31',
      balanceDates: ['2026-07-31'],
      sourceAccountName: 'Synthetic brokerage ending in 1234',
      sourceAccountNames: [],
      accountAliases: [],
      accountHolder: 'Synthetic Holder',
      artifactFileNames: ['vanguard-current-brokerage-2026-08-01-to-2026-08-24-activity-1234.csv'],
    }],
    connectionId: 'current',
    goal: { kind: 'current', overlapDays: 7 },
    outputDir,
  };
}

test('runtime execution plans round-trip through the strict stdin protocol', () => {
  const plan = executionPlan();
  expect(parseSyncExecutionPlan(serializeSyncExecutionPlan(plan))).toEqual(plan);
  expect(() => parseSyncExecutionPlan(JSON.stringify({
    ...plan,
    institutionId: 'unsupported-bank',
  }))).toThrow('unsupported institution connector');
});

test('worker manifests reject path-shaped artifacts before parent staging', () => {
  expect(() => parseSyncWorkerMessage(JSON.stringify({
    protocolVersion: SYNC_WORKER_PROTOCOL_VERSION,
    kind: 'manifest',
    manifest: {
      protocolVersion: SYNC_WORKER_PROTOCOL_VERSION,
      runId: 'sync-vanguard-test',
      institutionId: 'vanguard',
      artifacts: [{
        fileName: '../outside.csv',
        accountId: 42,
        sizeBytes: 1,
        sha256: 'a'.repeat(64),
      }],
    },
  }))).toThrow('Artifact file name must not contain a path');
});

test('typed worker output is distinguishable from browser diagnostics on stdout', () => {
  const message = {
    protocolVersion: SYNC_WORKER_PROTOCOL_VERSION,
    kind: 'manifest' as const,
    manifest: {
      protocolVersion: SYNC_WORKER_PROTOCOL_VERSION,
      runId: 'sync-vanguard-test',
      institutionId: 'vanguard' as const,
      artifacts: [],
    },
  };
  expect(parseSyncWorkerLine('Authentication required in synthetic session.')).toBeNull();
  expect(parseSyncWorkerLine(serializeSyncWorkerLine(message))).toEqual(message);
});

test('loading the child entrypoint cannot initialize a database from its environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easymoney-worker-no-db-'));
  const databasePath = join(directory, 'must-not-exist.sqlite');
  const missingEnvPath = join(directory, 'missing.env');
  const repositoryRoot = resolve(import.meta.dir, '../../..');
  const child = Bun.spawn([process.execPath, resolve(repositoryRoot, 'scripts/sync.ts')], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      EASYMONEY_DB_PATH: databasePath,
      EASYMONEY_ENV_PATH: missingEnvPath,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  try {
    if (!child.stdin || typeof child.stdin === 'number') throw new Error('Test child stdin is unavailable');
    child.stdin.write('{}');
    child.stdin.end();
    expect(await child.exited).not.toBe(0);
    expect(await stat(databasePath).then(() => true).catch(() => false)).toBe(false);
  } finally {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the real child entrypoint accepts a typed plan on stdin and emits framed progress', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easymoney-worker-protocol-'));
  const databasePath = join(directory, 'must-not-exist.sqlite');
  const repositoryRoot = resolve(import.meta.dir, '../../..');
  const plan: SyncExecutionPlan = {
    ...executionPlan(join(directory, 'artifacts')),
    runId: 'sync-vanguard-empty',
    accounts: [],
  };
  const child = Bun.spawn([process.execPath, resolve(repositoryRoot, 'scripts/sync.ts')], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      EASYMONEY_DB_PATH: databasePath,
      EASYMONEY_ENV_PATH: join(directory, 'missing.env'),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();

  try {
    if (!child.stdin || typeof child.stdin === 'number') throw new Error('Test child stdin is unavailable');
    child.stdin.write(serializeSyncExecutionPlan(plan));
    child.stdin.end();
    expect(await child.exited).toBe(1);
    const messages = (await stdout).trim().split('\n').filter(Boolean).map(parseSyncWorkerLine);
    expect(messages).toContainEqual(expect.objectContaining({
      kind: 'event',
      event: expect.objectContaining({
        runId: plan.runId,
        type: 'error',
        message: 'Vanguard connection is unavailable: current',
      }),
    }));
    expect(await stderr).toBe('');
    expect(await stat(databasePath).then(() => true).catch(() => false)).toBe(false);
  } finally {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
