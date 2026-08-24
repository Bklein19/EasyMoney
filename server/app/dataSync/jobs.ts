import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { runSerializedSyncDatabaseWork } from './databaseQueue.ts';
import { createSyncExecutionPlan } from './executionPlan.ts';
import { markInterruptedSyncJob } from './jobState.ts';
import { syncApplicationDataRoot } from './paths.ts';
import {
  commitSyncReview,
  discardSyncPreviewIds,
  discardSyncReview,
} from './review.ts';
import { stageSyncArtifactManifest } from './staging.ts';
import {
  commandForSyncWorker,
  sendSyncExecutionPlan,
  syncChildProcessOptions,
} from './subprocess.ts';
import type {
  SyncAccountMappingDecision,
  SyncArtifactManifest,
  SyncEvent,
  SyncExecutionPlan,
  SyncGoal,
  SyncInstitutionId,
  SyncRunResult,
  SyncRunReview,
} from './types.ts';
import {
  parseSyncWorkerLine,
  validateSyncArtifactManifestForPlan,
} from './workerProtocol.ts';
import { stageCompletedSyncWorker } from './workerCompletion.ts';

export type SyncJobStatus = 'running' | 'awaiting-confirmation' | 'importing' | 'complete' | 'failed' | 'cancelled';

export interface SyncJob {
  runId: string;
  institutionId: SyncInstitutionId;
  goal: SyncGoal;
  connectionId?: string;
  status: SyncJobStatus;
  message: string;
  startedAt: string;
  completedAt: string | null;
  events: SyncEvent[];
  review: SyncRunReview | null;
  result: SyncRunResult | null;
  error: string | null;
}

type ManagedSyncJob = SyncJob & {
  process: ReturnType<typeof Bun.spawn> | null;
  persistence: Promise<void>;
  manifest: SyncArtifactManifest | null;
  protocolError: string | null;
  cancelRequested: boolean;
  reviewAction: 'confirm' | 'discard' | null;
};

const jobs = new Map<string, ManagedSyncJob>();
const childEventTypes = new Set<SyncEvent['type']>([
  'phase',
  'action',
  'artifact',
  'warning',
  'error',
]);

function publicJob(job: ManagedSyncJob): SyncJob {
  const {
    process: _process,
    persistence: _persistence,
    manifest: _manifest,
    protocolError: _protocolError,
    cancelRequested: _cancelRequested,
    reviewAction: _reviewAction,
    ...result
  } = job;
  return result;
}

function runFilePath(runId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Invalid sync run id');
  return resolve(syncApplicationDataRoot(), runId, 'run.json');
}

function persistJob(job: ManagedSyncJob) {
  job.persistence = job.persistence.catch(() => {}).then(async () => {
    const path = runFilePath(job.runId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(publicJob(job), null, 2)}\n`);
    if (process.platform !== 'win32') await chmod(path, 0o600);
  });
  return job.persistence;
}

async function managedJob(runId: string): Promise<ManagedSyncJob | null> {
  const current = jobs.get(runId);
  if (current) return current;
  try {
    const saved = JSON.parse(await readFile(runFilePath(runId), 'utf8')) as Partial<SyncJob>;
    const loadedWhileReading = jobs.get(runId);
    if (loadedWhileReading) return loadedWhileReading;
    if (saved.runId !== runId || !saved.institutionId || !saved.goal || !saved.status) return null;
    const job: ManagedSyncJob = {
      runId,
      institutionId: saved.institutionId,
      connectionId: saved.connectionId,
      goal: saved.goal,
      status: saved.status,
      message: saved.message || '',
      startedAt: saved.startedAt || new Date().toISOString(),
      completedAt: saved.completedAt || null,
      events: saved.events || [],
      review: saved.review || null,
      result: saved.result || null,
      error: saved.error || null,
      process: null,
      persistence: Promise.resolve(),
      manifest: null,
      protocolError: null,
      cancelRequested: false,
      reviewAction: null,
    };
    jobs.set(runId, job);
    if (markInterruptedSyncJob(job)) await persistJob(job);
    return job;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function appendEvent(job: ManagedSyncJob, event: SyncEvent) {
  job.events.push(event);
  if (job.events.length > 200) job.events.splice(0, job.events.length - 200);
  job.message = event.message;
  if (event.type === 'review') {
    const review = event.data?.review as SyncRunReview | undefined;
    if (review) job.review = review;
    job.status = 'awaiting-confirmation';
    job.completedAt = null;
  } else if (event.type === 'complete') {
    job.status = 'complete';
    job.result = (event.data?.result as SyncRunResult | undefined) || job.result;
    job.error = null;
    job.completedAt = event.timestamp;
  } else if (event.type === 'error') {
    job.status = 'failed';
    job.error = event.message;
    job.completedAt = event.timestamp;
  }
  void persistJob(job);
}

function reportForJob(job: ManagedSyncJob) {
  return (event: Omit<SyncEvent, 'runId' | 'timestamp'>) => appendEvent(job, {
    ...event,
    runId: job.runId,
    timestamp: new Date().toISOString(),
  });
}

function failJob(job: ManagedSyncJob, message: string): void {
  if (job.status === 'cancelled') return;
  appendEvent(job, {
    runId: job.runId,
    timestamp: new Date().toISOString(),
    type: 'error',
    message,
  });
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) onLine(line);
  }
  if (pending.trim()) onLine(pending);
}

function acceptWorkerMessage(job: ManagedSyncJob, plan: SyncExecutionPlan, line: string): void {
  try {
    const message = parseSyncWorkerLine(line);
    if (!message) {
      appendEvent(job, {
        runId: job.runId,
        timestamp: new Date().toISOString(),
        type: 'warning',
        message: line,
      });
      return;
    }
    if (message.kind === 'event') {
      if (message.event.runId !== plan.runId) {
        throw new Error('Sync worker event run id does not match its execution plan');
      }
      if (!childEventTypes.has(message.event.type)) {
        throw new Error('Sync worker attempted a parent-owned job transition');
      }
      appendEvent(job, message.event);
      return;
    }

    validateSyncArtifactManifestForPlan(message.manifest, plan);
    if (job.manifest) throw new Error('Sync worker emitted more than one artifact manifest');
    job.manifest = message.manifest;
  } catch (error) {
    job.protocolError ??= error instanceof Error ? error.message : String(error);
  }
}

async function finishWorker(
  job: ManagedSyncJob,
  plan: SyncExecutionPlan,
  exitCode: number,
): Promise<void> {
  if (job.status !== 'running' || job.cancelRequested) return;

  try {
    const staged = await stageCompletedSyncWorker({
      exitCode,
      cancelled: job.cancelRequested,
      protocolError: job.protocolError,
      manifest: job.manifest,
    }, async manifest => {
      job.message = 'Downloads complete; preparing review';
      await persistJob(job);
      return runSerializedSyncDatabaseWork(async () => {
        if (job.status !== 'running' || job.cancelRequested) return null;
        const result = await stageSyncArtifactManifest(
          manifest,
          plan.outputDir,
          event => {
            if (job.status === 'running' && !job.cancelRequested) reportForJob(job)(event);
          },
          () => job.status === 'running' && !job.cancelRequested,
        );
        if (job.status !== 'running' || job.cancelRequested) {
          discardSyncPreviewIds(result.createdImportFileIds);
          return null;
        }
        appendEvent(job, {
          runId: job.runId,
          timestamp: new Date().toISOString(),
          type: 'review',
          message: 'Downloads are ready to review',
          data: { review: result.review },
        });
        return result;
      });
    });
    if (!staged) return;
  } catch (error) {
    if (job.cancelRequested) return;
    failJob(job, error instanceof Error ? error.message : String(error));
  }
}

export function startSyncJob(input: {
  institutionId: SyncJob['institutionId'];
  connectionId?: string;
  goal: SyncGoal;
}): SyncJob {
  const active = [...jobs.values()].find(job =>
    job.institutionId === input.institutionId &&
    job.connectionId === input.connectionId &&
    ['running', 'awaiting-confirmation', 'importing'].includes(job.status)
  );
  if (active) return publicJob(active);

  const runId = `sync-${input.institutionId}-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const executionPlan = createSyncExecutionPlan({ runId, ...input });
  const job: ManagedSyncJob = {
    runId,
    institutionId: input.institutionId,
    connectionId: input.connectionId,
    goal: input.goal,
    status: 'running',
    message: 'Starting sync',
    startedAt,
    completedAt: null,
    events: [],
    review: null,
    result: null,
    error: null,
    process: null,
    persistence: Promise.resolve(),
    manifest: null,
    protocolError: null,
    cancelRequested: false,
    reviewAction: null,
  };
  jobs.set(runId, job);
  void persistJob(job);

  try {
    const child = Bun.spawn(commandForSyncWorker(), syncChildProcessOptions());
    job.process = child;
    sendSyncExecutionPlan(child, executionPlan);

    const stdout = readLines(child.stdout, line => acceptWorkerMessage(job, executionPlan, line));
    const stderr = readLines(child.stderr, line => {
      appendEvent(job, {
        runId,
        timestamp: new Date().toISOString(),
        type: 'warning',
        message: line,
      });
    });
    void child.exited.then(async exitCode => {
      await Promise.allSettled([stdout, stderr]);
      job.process = null;
      await finishWorker(job, executionPlan, exitCode);
    });
  } catch (error) {
    job.process?.kill();
    job.process = null;
    failJob(job, error instanceof Error ? error.message : String(error));
  }

  return publicJob(job);
}

export async function getSyncJob(runId: string): Promise<SyncJob | null> {
  const job = await managedJob(runId);
  return job ? publicJob(job) : null;
}

export async function cancelSyncJob(runId: string): Promise<SyncJob> {
  const job = await managedJob(runId);
  if (!job) throw new Error('Sync job not found');
  if (job.status === 'running') {
    job.cancelRequested = true;
    job.process?.kill();
    job.status = 'cancelled';
    job.message = 'Sync cancelled';
    job.completedAt = new Date().toISOString();
    await persistJob(job);
  }
  return publicJob(job);
}

export async function confirmSyncJob(
  runId: string,
  accountMappings?: SyncAccountMappingDecision[] | null,
): Promise<SyncJob> {
  const job = await managedJob(runId);
  if (!job) throw new Error('Sync job not found');
  if (job.status === 'complete') return publicJob(job);
  if (job.status !== 'awaiting-confirmation' || !job.review || job.reviewAction) {
    throw new Error('Sync job is not awaiting confirmation');
  }

  job.reviewAction = 'confirm';
  job.status = 'importing';
  job.message = 'Importing confirmed data';
  job.error = null;
  const report = reportForJob(job);

  try {
    await persistJob(job);
    const result = await runSerializedSyncDatabaseWork(() =>
      commitSyncReview(job.review!, report, accountMappings)
    );
    job.reviewAction = null;
    appendEvent(job, {
      runId,
      timestamp: new Date().toISOString(),
      type: 'complete',
      message: 'Import complete',
      data: { result },
    });
    await persistJob(job);
    return publicJob(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    job.reviewAction = null;
    job.status = 'awaiting-confirmation';
    job.error = message;
    appendEvent(job, {
      runId,
      timestamp: new Date().toISOString(),
      type: 'warning',
      message: `Import failed: ${message}`,
    });
    await persistJob(job);
    throw error;
  }
}

export async function discardSyncJob(runId: string): Promise<SyncJob> {
  const job = await managedJob(runId);
  if (!job) throw new Error('Sync job not found');
  if (job.status !== 'awaiting-confirmation' || !job.review || job.reviewAction) {
    throw new Error('Sync job is not awaiting confirmation');
  }

  job.reviewAction = 'discard';
  job.message = 'Discarding downloaded data';
  job.error = null;
  try {
    await persistJob(job);
    await runSerializedSyncDatabaseWork(() => discardSyncReview(job.review!));
    const timestamp = new Date().toISOString();
    job.reviewAction = null;
    job.status = 'cancelled';
    job.message = 'Downloaded data discarded';
    job.completedAt = timestamp;
    job.events.push({
      runId,
      timestamp,
      type: 'action',
      message: job.message,
    });
    await persistJob(job);
    return publicJob(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    job.reviewAction = null;
    job.status = 'awaiting-confirmation';
    job.error = message;
    appendEvent(job, {
      runId,
      timestamp: new Date().toISOString(),
      type: 'warning',
      message: `Discard failed: ${message}`,
    });
    await persistJob(job);
    throw error;
  }
}
