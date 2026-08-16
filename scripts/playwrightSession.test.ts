import { describe, expect, test } from 'bun:test';

import { playwrightProfilePath } from '../.codex/skills/update-finance-data/scripts/playwrightSession.ts';

describe('Playwright session helper', () => {
  test('uses stable platform-specific persistent profile locations', () => {
    expect(playwrightProfilePath('tiaa-catchup', {
      home: '/Users/example',
      platform: 'darwin',
      env: {},
    })).toBe('/Users/example/Library/Application Support/EasyMoney/playwright-profiles/tiaa-catchup');
    expect(playwrightProfilePath('tiaa-catchup', {
      home: 'C:\\Users\\example',
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' },
    })).toBe('C:\\Users\\example\\AppData\\Local\\EasyMoney\\playwright-profiles\\tiaa-catchup');
    expect(playwrightProfilePath('tiaa-catchup', {
      home: '/home/example',
      platform: 'linux',
      env: { XDG_STATE_HOME: '/state' },
    })).toBe('/state/easymoney/playwright-profiles/tiaa-catchup');
  });
});
