import { expect, test } from 'bun:test';

import { SYNC_WORKER_PROTOCOL_VERSION, type SyncArtifactManifest } from './types.ts';
import { stageCompletedSyncWorker } from './workerCompletion.ts';

const manifest: SyncArtifactManifest = {
  protocolVersion: SYNC_WORKER_PROTOCOL_VERSION,
  runId: 'sync-bank-of-america-test',
  institutionId: 'bank-of-america',
  artifacts: [],
};

test('failed and cancelled workers never stage artifact manifests', async () => {
  let stages = 0;
  const stage = () => {
    stages += 1;
    return 'staged';
  };

  await expect(stageCompletedSyncWorker({
    exitCode: 1,
    cancelled: false,
    protocolError: null,
    manifest,
  }, stage)).rejects.toThrow('Sync process exited with code 1');
  await expect(stageCompletedSyncWorker({
    exitCode: 0,
    cancelled: true,
    protocolError: null,
    manifest,
  }, stage)).resolves.toBeNull();
  await expect(stageCompletedSyncWorker({
    exitCode: 0,
    cancelled: false,
    protocolError: 'malformed output',
    manifest,
  }, stage)).rejects.toThrow('Sync worker protocol failed');
  await expect(stageCompletedSyncWorker({
    exitCode: 0,
    cancelled: false,
    protocolError: null,
    manifest: null,
  }, stage)).rejects.toThrow('without an artifact manifest');
  expect(stages).toBe(0);
});

test('only a clean worker completion stages its typed manifest', async () => {
  await expect(stageCompletedSyncWorker({
    exitCode: 0,
    cancelled: false,
    protocolError: null,
    manifest,
  }, received => received.runId)).resolves.toBe(manifest.runId);
});
