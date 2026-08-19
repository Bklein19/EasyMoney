import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { syncApplicationDataRoot } from './runner.ts';
import type { SyncEvent, SyncGoal, SyncInstitutionId } from './types.ts';

export type SyncJobStatus = 'running' | 'complete' | 'failed' | 'cancelled';

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
}

type ManagedSyncJob = SyncJob & { process: ReturnType<typeof Bun.spawn> | null };

const jobs = new Map<string, ManagedSyncJob>();
const repositoryRoot = resolve(import.meta.dir, '../../..');

function publicJob(job: ManagedSyncJob): SyncJob {
  const { process: _process, ...result } = job;
  return result;
}

async function persistJob(job: ManagedSyncJob) {
  const directory = resolve(syncApplicationDataRoot(), job.runId);
  const path = resolve(directory, 'run.json');
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify(publicJob(job), null, 2)}\n`);
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

function appendEvent(job: ManagedSyncJob, event: SyncEvent) {
  job.events.push(event);
  if (job.events.length > 200) job.events.splice(0, job.events.length - 200);
  job.message = event.message;
  if (event.type === 'complete') {
    job.status = 'complete';
    job.completedAt = event.timestamp;
  } else if (event.type === 'error') {
    job.status = 'failed';
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
  const command = [process.execPath, resolve(repositoryRoot, 'scripts/sync.ts'), '--institution', institutionId, '--run-id', runId, '--goal', goal.kind];
  if (connectionId) command.push('--connection', connectionId);
  if (goal.kind === 'current') command.push('--overlap-days', String(goal.overlapDays));
  if (goal.kind === 'backfill' && goal.stopAt) command.push('--stop-at', goal.stopAt);
  if (goal.kind === 'range') command.push('--from', goal.startDate, '--to', goal.endDate);
  return command;
}

export function startSyncJob(input: { institutionId: SyncJob['institutionId']; connectionId?: string; goal: SyncGoal }): SyncJob {
  const active = [...jobs.values()].find(job =>
    job.institutionId === input.institutionId && job.connectionId === input.connectionId && job.status === 'running'
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
    process: null,
  };
  jobs.set(runId, job);
  void persistJob(job);

  const child = Bun.spawn(commandFor(runId, input.institutionId, input.goal, input.connectionId), {
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  job.process = child;

  void readLines(child.stdout, line => {
    try {
      appendEvent(job, JSON.parse(line) as SyncEvent);
    } catch {
      appendEvent(job, { runId, timestamp: new Date().toISOString(), type: 'warning', message: line });
    }
  });
  void readLines(child.stderr, line => {
    appendEvent(job, { runId, timestamp: new Date().toISOString(), type: 'warning', message: line });
  });
  void child.exited.then(exitCode => {
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

export function getSyncJob(runId: string): SyncJob | null {
  const job = jobs.get(runId);
  return job ? publicJob(job) : null;
}

export function cancelSyncJob(runId: string): SyncJob {
  const job = jobs.get(runId);
  if (!job) throw new Error('Sync job not found');
  if (job.status === 'running') {
    job.process?.kill();
    job.process = null;
    job.status = 'cancelled';
    job.message = 'Sync cancelled';
    job.completedAt = new Date().toISOString();
    void persistJob(job);
  }
  return publicJob(job);
}
