import { describe, expect, test } from 'bun:test';

import { syncApplicationDataRoot } from './paths.ts';

describe('sync application data paths', () => {
  test('uses Application Support on macOS', () => {
    expect(syncApplicationDataRoot({
      home: '/Users/example',
      platform: 'darwin',
      env: {},
    })).toBe('/Users/example/Library/Application Support/EasyMoney/sync-runs');
  });

  test('uses LOCALAPPDATA on Windows', () => {
    expect(syncApplicationDataRoot({
      home: 'C:\\Users\\example',
      platform: 'win32',
      env: { LOCALAPPDATA: 'D:\\Profiles\\example\\AppData\\Local' },
    })).toBe('D:\\Profiles\\example\\AppData\\Local\\EasyMoney\\sync-runs');
  });

  test('uses XDG_STATE_HOME on Linux', () => {
    expect(syncApplicationDataRoot({
      home: '/home/example',
      platform: 'linux',
      env: { XDG_STATE_HOME: '/state/example' },
    })).toBe('/state/example/easymoney/sync-runs');
  });

  test('falls back to each platform home directory convention', () => {
    expect(syncApplicationDataRoot({
      home: 'C:\\Users\\example',
      platform: 'win32',
      env: {},
    })).toBe('C:\\Users\\example\\AppData\\Local\\EasyMoney\\sync-runs');
    expect(syncApplicationDataRoot({
      home: '/home/example',
      platform: 'linux',
      env: {},
    })).toBe('/home/example/.local/state/easymoney/sync-runs');
  });
});
