import { describe, expect, test } from 'bun:test';

import { markInterruptedSyncJob } from './jobState.ts';
import { commandForSyncWorker, syncChildProcessOptions } from './subprocess.ts';
import type { SyncEvent } from './types.ts';

describe('sync child process options', () => {
  test('passes runtime paths without exposing the EasyMoney database', () => {
    const options = syncChildProcessOptions({
      EASYMONEY_DESKTOP: '1',
      EASYMONEY_DB_PATH: '/application-support/easymoney.sqlite',
      EASYMONEY_ENV_PATH: '/application-support/.env.local',
      EASYMONEY_SYNC_ROOT: '/application-support/sync-runs',
    });

    expect(options.env).toMatchObject({
      EASYMONEY_DESKTOP: '1',
      EASYMONEY_ENV_PATH: '/application-support/.env.local',
      EASYMONEY_SYNC_ROOT: '/application-support/sync-runs',
    });
    expect(options.env.EASYMONEY_DB_PATH).toBeUndefined();
    expect(options.stdin).toBe('pipe');
  });

  test('keeps the complete runtime execution plan out of process arguments', () => {
    const command = commandForSyncWorker();
    expect(command).toHaveLength(2);
    expect(command[0]).toBe(process.execPath);
    expect(command[1]).toEndWith('scripts/sync.ts');
  });
});

describe('persisted sync job recovery', () => {
  test('fails an orphaned running job instead of leaving the app spinning', () => {
    const job = {
      runId: 'sync-bank-of-america-stale',
      institutionId: 'bank-of-america' as const,
      goal: { kind: 'current' as const, overlapDays: 7 },
      status: 'running' as const,
      message: 'Downloading Bank of America credit-card activity',
      startedAt: '2026-08-21T14:44:24.577Z',
      completedAt: null,
      events: [] as SyncEvent[],
      review: null,
      result: null,
      error: null,
    };

    expect(markInterruptedSyncJob(job, '2026-08-21T14:50:00.000Z')).toBe(true);
    expect(job).toMatchObject({
      status: 'failed',
      message: 'EasyMoney closed before the sync completed. Run catch up again.',
      error: 'EasyMoney closed before the sync completed. Run catch up again.',
      completedAt: '2026-08-21T14:50:00.000Z',
    });
    expect(job.events).toEqual([expect.objectContaining({
      type: 'error',
      message: 'EasyMoney closed before the sync completed. Run catch up again.',
    })]);
  });
});
