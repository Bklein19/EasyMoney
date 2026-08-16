import { describe, expect, test } from 'bun:test';
import type { Page } from 'playwright';

import {
  playwrightAuthStatePath,
  playwrightProfilePath,
  waitForInteractiveAuthentication,
} from '../../.codex/skills/update-finance-data/scripts/playwrightSession.ts';

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

  test('keeps auth state inside the private institution profile', () => {
    expect(playwrightAuthStatePath('/profiles/tiaa-catchup'))
      .toBe('/profiles/tiaa-catchup/.easymoney-auth-state.json');
  });

  test('waits on the existing login page instead of refreshing it', async () => {
    let url = 'https://auth.tiaa.org/login';
    let waits = 0;
    const page = {
      isClosed: () => false,
      url: () => url,
      locator: () => ({ count: async () => url.includes('/login') ? 1 : 0 }),
      waitForTimeout: async () => {
        waits += 1;
        if (waits === 2) url = 'https://my.tiaa.org/private/participant/home';
        await Bun.sleep(500);
      },
    } as unknown as Page;

    await waitForInteractiveAuthentication(page, Date.now() + 5_000);
    expect(waits).toBeGreaterThanOrEqual(4);
    expect(url).toContain('/private/participant/home');
  });
});
