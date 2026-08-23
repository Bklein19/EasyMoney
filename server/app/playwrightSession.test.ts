import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';

import {
  closeBrowserContext,
  decodeInstitutionBrowserProgramResult,
  institutionBrowserLaunchStrategy,
  persistBrowserAuthentication,
  playwrightAuthStatePath,
  playwrightHasSavedAuthentication,
  playwrightProfilePath,
  runWhileBrowserOpen,
  showAuthenticationChapter,
  showSyncCompletionChapter,
  waitForInteractiveAuthentication,
  withInteractiveBrowserLease,
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

  test('serializes interactive sign-in browsers across institution profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'easymoney-playwright-lease-'));
    temporaryDirectories.push(root);
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const secondWaiting = Promise.withResolvers<void>();
    let secondEntered = false;

    const first = withInteractiveBrowserLease({
      profilePath: join(root, 'fidelity-catchup'),
      sessionName: 'fidelity-catchup',
      pollIntervalMs: 5,
    }, async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      return 'fidelity';
    });
    await firstEntered.promise;

    const second = withInteractiveBrowserLease({
      profilePath: join(root, 'wells-fargo-catchup'),
      sessionName: 'wells-fargo-catchup',
      pollIntervalMs: 5,
      onWait: () => secondWaiting.resolve(),
    }, async () => {
      secondEntered = true;
      return 'wells-fargo';
    });
    await secondWaiting.promise;
    expect(secondEntered).toBe(false);

    releaseFirst.resolve();
    expect(await first).toBe('fidelity');
    expect(await second).toBe('wells-fargo');
    expect(secondEntered).toBe(true);
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
    const authenticationChanged = Promise.withResolvers<void>();
    const page = {
      isClosed: () => false,
      url: () => url,
      locator: () => ({ count: async () => url.includes('/login') ? 1 : 0 }),
      waitForFunction: async () => authenticationChanged.promise,
    } as unknown as Page;

    const waiting = waitForInteractiveAuthentication(page, Date.now() + 5_000);
    let completed = false;
    void waiting.then(() => { completed = true; }, () => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    url = 'https://my.tiaa.org/private/participant/home';
    authenticationChanged.resolve();
    await waiting;

    expect(url).toContain('/private/participant/home');
  });

  test('supports institution authentication on a URL that still looks like a login page', async () => {
    let title = 'Bank of America | Online Banking | Sign In';
    const authenticationChanged = Promise.withResolvers<void>();
    const page = {
      isClosed: () => false,
      url: () => 'https://secure.bankofamerica.com/myaccounts/signin/signIn.go',
      title: async () => title,
      locator: () => ({ count: async () => 0 }),
    } as unknown as Page;

    const waiting = waitForInteractiveAuthentication(
      page,
      Date.now() + 5_000,
      {
        isAuthenticated: async currentPage => (await currentPage.title()).includes('Accounts Overview'),
        waitUntilAuthenticated: async () => authenticationChanged.promise,
      },
    );
    let completed = false;
    void waiting.then(() => { completed = true; }, () => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    title = 'Bank of America | Online Banking | Accounts Overview';
    authenticationChanged.resolve();
    await waiting;

    expect(title).toContain('Accounts Overview');
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

  test('does not hang when Chrome closes without settling context cleanup', async () => {
    const context = {
      close: () => new Promise<void>(() => {}),
    };

    const startedAt = performance.now();
    const closed = await closeBrowserContext(context, 10);

    expect(closed).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test('does not hang saving authentication after Chrome exits', async () => {
    const context = {
      storageState: () => new Promise<never>(() => {}),
    };

    const startedAt = performance.now();
    const persisted = await persistBrowserAuthentication(
      context as never,
      '/tmp/easymoney-auth-state-that-should-not-be-written.json',
      10,
    );

    expect(persisted).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test('rejects the active institution step when Chrome exits', async () => {
    let closeListener: (() => void) | undefined;
    const context = {
      once: (event: string, listener: () => void) => {
        expect(event).toBe('close');
        closeListener = listener;
      },
      off: (event: string, listener: () => void) => {
        expect(event).toBe('close');
        if (closeListener === listener) closeListener = undefined;
      },
    };

    const running = runWhileBrowserOpen(
      context as never,
      () => new Promise<never>(() => {}),
    );
    closeListener?.();

    await expect(running).rejects.toThrow('Browser closed before the institution sync completed');
    expect(closeListener).toBeUndefined();
  });
});
