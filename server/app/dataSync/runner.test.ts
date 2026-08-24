import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SyncConnector } from './connector.ts';
import { runSyncExecutionPlan } from './runner.ts';
import {
  SYNC_WORKER_PROTOCOL_VERSION,
  type SyncExecutionPlan,
} from './types.ts';

function plan(runId: string, outputDir: string): SyncExecutionPlan {
  return {
    protocolVersion: SYNC_WORKER_PROTOCOL_VERSION,
    runId,
    institutionId: 'bank-of-america',
    today: '2026-08-24',
    accounts: [{
      id: 1,
      name: 'Synthetic Checking 1234',
      institution: 'Bank of America',
      type: 'checking',
      latestFactDate: null,
      earliestFactDate: null,
      latestBalanceDate: null,
      earliestBalanceDate: null,
      balanceDates: [],
      sourceAccountName: null,
      sourceAccountNames: [],
      accountAliases: [],
      accountHolder: null,
      artifactFileNames: [],
    }],
    goal: { kind: 'current', overlapDays: 7 },
    outputDir,
  };
}

test('two DB-free connector downloads can overlap and emit independent manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'easymoney-overlapping-workers-'));
  let started = 0;
  let releaseDownloads!: () => void;
  let bothStarted!: () => void;
  const released = new Promise<void>(resolve => { releaseDownloads = resolve; });
  const runningTogether = new Promise<void>(resolve => { bothStarted = resolve; });
  const connector: SyncConnector<'bank-of-america'> = {
    id: 'bank-of-america',
    label: 'Synthetic Bank of America',
    matchesAccount: () => true,
    listTargets: () => [{ label: 'Synthetic BofA' }],
    async run(context) {
      started += 1;
      if (started === 2) bothStarted();
      await released;
      const fileName = 'bofa-checking-1234-synthetic.csv';
      await writeFile(join(context.outputDir, fileName), context.outputDir);
      return [{ fileName, accountId: 1 }];
    },
  };
  const resolveConnector = () => connector;

  try {
    const first = runSyncExecutionPlan(plan('sync-first', join(root, 'first')), () => {}, resolveConnector);
    const second = runSyncExecutionPlan(plan('sync-second', join(root, 'second')), () => {}, resolveConnector);
    await runningTogether;
    expect(started).toBe(2);
    releaseDownloads();
    const manifests = await Promise.all([first, second]);
    expect(manifests.map(manifest => manifest.runId)).toEqual(['sync-first', 'sync-second']);
    expect(manifests.every(manifest => manifest.artifacts[0]?.sha256.length === 64)).toBe(true);
  } finally {
    releaseDownloads();
    await rm(root, { recursive: true, force: true });
  }
});

test('a connector cannot manifest an artifact routed outside its account plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'easymoney-worker-route-'));
  const connector: SyncConnector<'bank-of-america'> = {
    id: 'bank-of-america',
    label: 'Synthetic Bank of America',
    matchesAccount: () => true,
    listTargets: () => [],
    async run(context) {
      await writeFile(join(context.outputDir, 'artifact.csv'), 'synthetic');
      return [{ fileName: 'artifact.csv', accountId: 99 }];
    },
  };

  try {
    await expect(runSyncExecutionPlan(
      plan('sync-invalid-route', root),
      () => {},
      () => connector,
    )).rejects.toThrow('outside its execution plan');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a connector cannot manifest a multi-account route outside its account plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'easymoney-worker-multi-route-'));
  const connector: SyncConnector<'bank-of-america'> = {
    id: 'bank-of-america',
    label: 'Synthetic Bank of America',
    matchesAccount: () => true,
    listTargets: () => [],
    async run(context) {
      await writeFile(join(context.outputDir, 'artifact.csv'), 'synthetic');
      return [{
        fileName: 'artifact.csv',
        accountRoutes: [
          { remoteAccountId: 'remote:new' },
          { remoteAccountId: 'remote:routed', accountId: 99 },
        ],
      }];
    },
  };

  try {
    await expect(runSyncExecutionPlan(
      plan('sync-invalid-multi-route', root),
      () => {},
      () => connector,
    )).rejects.toThrow('outside its execution plan');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
