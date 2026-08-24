#!/usr/bin/env bun

import { loadLocalEnv } from '../server/app/localEnv.ts';
import { runSyncExecutionPlan } from '../server/app/dataSync/runner.ts';
import {
  SYNC_WORKER_PROTOCOL_VERSION,
  type SyncEvent,
  type SyncExecutionPlan,
  type SyncWorkerMessage,
} from '../server/app/dataSync/types.ts';
import {
  parseSyncExecutionPlan,
  serializeSyncWorkerLine,
} from '../server/app/dataSync/workerProtocol.ts';

loadLocalEnv();
delete process.env.EASYMONEY_DB_PATH;

function writeMessage(message: SyncWorkerMessage): void {
  console.log(serializeSyncWorkerLine(message));
}

function emitForPlan(plan: SyncExecutionPlan, event: Omit<SyncEvent, 'runId' | 'timestamp'>): void {
  writeMessage({
    protocolVersion: SYNC_WORKER_PROTOCOL_VERSION,
    kind: 'event',
    event: { ...event, runId: plan.runId, timestamp: new Date().toISOString() },
  });
}

let exitCode = 0;
let executionPlan: SyncExecutionPlan | null = null;
try {
  executionPlan = parseSyncExecutionPlan(await Bun.stdin.text());
  const manifest = await runSyncExecutionPlan(
    executionPlan,
    event => emitForPlan(executionPlan!, event),
  );
  writeMessage({
    protocolVersion: SYNC_WORKER_PROTOCOL_VERSION,
    kind: 'manifest',
    manifest,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (executionPlan) emitForPlan(executionPlan, { type: 'error', message });
  else console.error(message);
  exitCode = 1;
}

await new Promise<void>((resolveFlush, rejectFlush) => {
  process.stdout.write('', error => error ? rejectFlush(error) : resolveFlush());
});
process.exit(exitCode);
