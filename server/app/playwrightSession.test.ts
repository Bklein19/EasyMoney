import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';

import {
  decodeInstitutionBrowserProgramResult,
  institutionBrowserLaunchStrategy,
  playwrightAuthStatePath,
  playwrightHasSavedAuthentication,
  playwrightProfilePath,
  showAuthenticationChapter,
  showSyncCompletionChapter,
  waitForInteractiveAuthentication,
} from './dataSync/browserSession.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

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

  test('detects saved authentication independently from the browser profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'easymoney-playwright-session-'));
    temporaryDirectories.push(root);
    const profilePath = join(root, 'vanguard-catchup');
    await mkdir(profilePath, { recursive: true });

    expect(await playwrightHasSavedAuthentication('vanguard-catchup', profilePath)).toBe(false);
    await writeFile(playwrightAuthStatePath(profilePath), '{}');
    expect(await playwrightHasSavedAuthentication('vanguard-catchup', profilePath)).toBe(true);
  });

  test('uses saved authentication headlessly with a headed login fallback', () => {
    expect(institutionBrowserLaunchStrategy({ hasSavedAuthentication: true })).toEqual({
      initialHeadless: true,
      allowHeadedAuthenticationFallback: true,
    });
    expect(institutionBrowserLaunchStrategy({ hasSavedAuthentication: false })).toEqual({
      initialHeadless: false,
      allowHeadedAuthenticationFallback: false,
    });
  });

  test('honors explicit browser visibility choices', () => {
    expect(institutionBrowserLaunchStrategy({
      hasSavedAuthentication: true,
      requestedHeadless: false,
    })).toEqual({
      initialHeadless: false,
      allowHeadedAuthenticationFallback: false,
    });
    expect(institutionBrowserLaunchStrategy({
      hasSavedAuthentication: false,
      requestedHeadless: true,
    })).toEqual({
      initialHeadless: true,
      allowHeadedAuthenticationFallback: false,
    });
    expect(institutionBrowserLaunchStrategy({
      hasSavedAuthentication: true,
      persistAuthentication: false,
    })).toEqual({
      initialHeadless: false,
      allowHeadedAuthenticationFallback: false,
    });
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

  test('supports institution authentication on a URL that still looks like a login page', async () => {
    let waits = 0;
    const page = {
      isClosed: () => false,
      url: () => 'https://secure.bankofamerica.com/myaccounts/signin/signIn.go',
      title: async () => 'Bank of America | Online Banking | Accounts Overview',
      locator: () => ({ count: async () => 0 }),
      waitForTimeout: async () => {
        waits += 1;
        await Bun.sleep(500);
      },
    } as unknown as Page;

    await waitForInteractiveAuthentication(
      page,
      Date.now() + 5_000,
      async currentPage => (await currentPage.title()).includes('Accounts Overview'),
    );

    expect(waits).toBeGreaterThanOrEqual(3);
  });

  test('decodes the typed institution browser status contract', () => {
    expect(decodeInstitutionBrowserProgramResult(JSON.stringify({
      status: 'complete',
      saved: ['activity.csv'],
    }))).toEqual({ status: 'complete', saved: ['activity.csv'] });
    expect(() => decodeInstitutionBrowserProgramResult('{"status":"unknown"}')).toThrow('unknown status');
  });

  test('shows the shared two-second completion chapter', async () => {
    const chapters: Array<{ title: string; options: unknown }> = [];
    const page = {
      screencast: {
        showChapter: async (title: string, options: unknown) => chapters.push({ title, options }),
      },
    } as unknown as Page;

    await showSyncCompletionChapter(page, { completionDescription: 'Downloads are complete.' });

    expect(chapters).toEqual([{
      title: 'Done',
      options: { description: 'Downloads are complete.', duration: 2_000 },
    }]);
  });

  test('clears the shared authentication chapter before credential entry', async () => {
    const events: string[] = [];
    const page = {
      screencast: {
        showChapter: async (title: string) => events.push(`show:${title}`),
        hideOverlays: async () => events.push('hide'),
      },
      waitForTimeout: async (duration: number) => events.push(`wait:${duration}`),
    } as unknown as Page;

    await showAuthenticationChapter(page, 'Sign in and complete MFA.');

    expect(events).toEqual(['show:Sign in required', 'wait:2000', 'hide']);
  });
});
