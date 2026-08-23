import { expect, test } from 'bun:test';

import { reportSyncStep } from './observability.ts';
import type { SyncReporter } from './types.ts';

test('sync step observability reports elapsed time around successful work', async () => {
  const events: Parameters<SyncReporter>[0][] = [];
  const times = [100, 246];

  const result = await reportSyncStep(
    event => events.push(event),
    {
      step: 'download-statements',
      message: 'Downloading statements',
      details: { accountCount: 3 },
    },
    async () => 'done',
    () => times.shift()!,
  );

  expect(result).toBe('done');
  expect(events).toEqual([
    {
      type: 'action',
      message: 'Downloading statements',
      data: {
        accountCount: 3,
        step: 'download-statements',
        status: 'started',
      },
    },
    {
      type: 'action',
      message: 'Downloading statements complete',
      data: {
        accountCount: 3,
        step: 'download-statements',
        status: 'completed',
        durationMs: 146,
      },
    },
  ]);
});

test('sync step observability records failed duration and preserves the error', async () => {
  const events: Parameters<SyncReporter>[0][] = [];
  const times = [10, 35];
  const failure = new Error('remote request failed');

  await expect(reportSyncStep(
    event => events.push(event),
    { step: 'download-activity', message: 'Downloading activity' },
    async () => { throw failure; },
    () => times.shift()!,
  )).rejects.toBe(failure);

  expect(events.at(-1)).toEqual({
    type: 'action',
    message: 'Downloading activity failed',
    data: {
      step: 'download-activity',
      status: 'failed',
      durationMs: 25,
    },
  });
});
