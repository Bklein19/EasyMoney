import type { SyncEvent } from './types.ts';

type RecoverableSyncJob = {
  runId: string;
  status: 'queued' | 'running' | 'awaiting-confirmation' | 'importing' | 'complete' | 'failed' | 'cancelled';
  message: string;
  completedAt: string | null;
  events: SyncEvent[];
  error: string | null;
};

export function markInterruptedSyncJob(
  job: RecoverableSyncJob,
  timestamp = new Date().toISOString(),
): boolean {
  if (job.status !== 'queued' && job.status !== 'running' && job.status !== 'importing') return false;

  const message = 'EasyMoney closed before the sync completed. Run catch up again.';
  job.status = 'failed';
  job.message = message;
  job.error = message;
  job.completedAt = timestamp;
  job.events.push({
    runId: job.runId,
    timestamp,
    type: 'error',
    message,
  });
  return true;
}
