import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { commitSyncReview, discardSyncReview } from './review.ts';
import { markInterruptedSyncJob } from './jobState.ts';
import { syncApplicationDataRoot } from './paths.ts';
import { syncChildProcessOptions } from './subprocess.ts';
import type { SyncEvent, SyncGoal, SyncInstitutionId, SyncRunResult, SyncRunReview } from './types.ts';

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
};

const jobs = new Map<string, ManagedSyncJob>();
const repositoryRoot = resolve(import.meta.dir, '../../..');

function publicJob(job: ManagedSyncJob): SyncJob {
  const { process: _process, persistence: _persistence, ...result } = job;
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

function commandFor(runId: string, institutionId: SyncJob['institutionId'], goal: SyncGoal, connectionId?: string) {
  const isDesktop = process.env.EASYMONEY_DESKTOP === '1';
  const syncScript = isDesktop
    ? resolve(import.meta.dir, 'sync.js')
    : resolve(repositoryRoot, 'scripts/sync.ts');
  const command = [process.execPath, syncScript, '--institution', institutionId, '--run-id', runId, '--goal', goal.kind];
  if (connectionId) command.push('--connection', connectionId);
  if (goal.kind === 'current') command.push('--overlap-days', String(goal.overlapDays));
  if (goal.kind === 'backfill' && goal.stopAt) command.push('--stop-at', goal.stopAt);
  if (goal.kind === 'range') command.push('--from', goal.startDate, '--to', goal.endDate);
  return command;
}

export function startSyncJob(input: { institutionId: SyncJob['institutionId']; connectionId?: string; goal: SyncGoal }): SyncJob {
  const active = [...jobs.values()].find(job =>
    job.institutionId === input.institutionId &&
    job.connectionId === input.connectionId &&
    ['running', 'awaiting-confirmation', 'importing'].includes(job.status)
  );
  if (active) return publicJob(active);

  const runId = `sync-${input.institutionId}-${Date.now()}`;
  const startedAt = new Date().toISOString();
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
  };
  jobs.set(runId, job);
  void persistJob(job);

  const child = Bun.spawn(
    commandFor(runId, input.institutionId, input.goal, input.connectionId),
    syncChildProcessOptions(),
  );
  job.process = child;

  const stdout = readLines(child.stdout, line => {
    try {
      appendEvent(job, JSON.parse(line) as SyncEvent);
    } catch {
      appendEvent(job, { runId, timestamp: new Date().toISOString(), type: 'warning', message: line });
    }
  });
  const stderr = readLines(child.stderr, line => {
    appendEvent(job, { runId, timestamp: new Date().toISOString(), type: 'warning', message: line });
  });
  void child.exited.then(async exitCode => {
    await Promise.allSettled([stdout, stderr]);
    job.process = null;
    if (job.status === 'running') {
      const timestamp = new Date().toISOString();
      appendEvent(job, {
        runId,
        timestamp,
        type: exitCode === 0 ? 'complete' : 'error',
        message: exitCode === 0 ? 'Sync complete' : `Sync process exited with code ${exitCode}`,
      });
    }
  });

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
    job.process?.kill();
    job.process = null;
    job.status = 'cancelled';
    job.message = 'Sync cancelled';
    job.completedAt = new Date().toISOString();
    await persistJob(job);
  }
  return publicJob(job);
}

export async function confirmSyncJob(runId: string): Promise<SyncJob> {
  const job = await managedJob(runId);
  if (!job) throw new Error('Sync job not found');
  if (job.status === 'complete') return publicJob(job);
  if (job.status !== 'awaiting-confirmation' || !job.review) {
    throw new Error('Sync job is not awaiting confirmation');
  }

  job.status = 'importing';
  job.message = 'Importing confirmed data';
  job.error = null;
  await persistJob(job);
  const report = (event: Omit<SyncEvent, 'runId' | 'timestamp'>) => appendEvent(job, {
    ...event,
    runId,
    timestamp: new Date().toISOString(),
  });

  try {
    const result = await commitSyncReview(job.review, report);
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
  if (job.status !== 'awaiting-confirmation' || !job.review) {
    throw new Error('Sync job is not awaiting confirmation');
  }

  discardSyncReview(job.review);
  const timestamp = new Date().toISOString();
  job.status = 'cancelled';
  job.message = 'Downloaded data discarded';
  job.completedAt = timestamp;
  job.error = null;
  job.events.push({
    runId,
    timestamp,
    type: 'action',
    message: job.message,
  });
  await persistJob(job);
  return publicJob(job);
}
