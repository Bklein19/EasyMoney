import { describe, expect, test } from 'bun:test';

import { syncChildProcessOptions } from './subprocess.ts';

describe('sync child process options', () => {
  test('passes runtime-assigned Electrobun paths to the sync worker', () => {
    const options = syncChildProcessOptions({
      EASYMONEY_DESKTOP: '1',
      EASYMONEY_DB_PATH: '/application-support/easymoney.sqlite',
      EASYMONEY_ENV_PATH: '/application-support/.env.local',
      EASYMONEY_SYNC_ROOT: '/application-support/sync-runs',
    });

    expect(options.env).toMatchObject({
      EASYMONEY_DESKTOP: '1',
      EASYMONEY_DB_PATH: '/application-support/easymoney.sqlite',
      EASYMONEY_ENV_PATH: '/application-support/.env.local',
      EASYMONEY_SYNC_ROOT: '/application-support/sync-runs',
    });
  });
});
