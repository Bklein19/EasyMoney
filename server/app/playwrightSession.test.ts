import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';

import {
  checkAuthenticationForCheckpoint,
  closeBrowserContext,
  decodeInstitutionBrowserProgramResult,
  institutionBrowserLaunchStrategy,
  openInstitutionStartPage,
  persistBrowserAuthentication,
  playwrightAuthStatePath,
  playwrightHasSavedAuthentication,
  playwrightProfilePath,
  playwrightSessionStoragePath,
  restoreBrowserAuthentication,
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
    expect(playwrightSessionStoragePath('/profiles/tiaa-catchup'))
      .toBe('/profiles/tiaa-catchup/.easymoney-session-storage.json');
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

  test('reopens the institution start page after restoring cached authentication', async () => {
    const navigations: Array<{ url: string; options: unknown }> = [];
    const page = {
      url: () => 'https://example.test/login',
      goto: async (url: string, options: unknown) => {
        navigations.push({ url, options });
        return null;
      },
    } as unknown as Page;

    await openInstitutionStartPage(page, 'https://example.test/start', true);

    expect(navigations).toEqual([{
      url: 'https://example.test/start',
      options: { waitUntil: 'domcontentloaded' },
    }]);
  });

  test('preserves an interactive page when there is no cached authentication to restore', async () => {
    let navigated = false;
    const page = {
      url: () => 'https://example.test/login',
      goto: async () => {
        navigated = true;
        return null;
      },
    } as unknown as Page;

    await openInstitutionStartPage(page, 'https://example.test/start', false);

    expect(navigated).toBe(false);
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

  test('allows interactive sign-in browsers for different profiles to run concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'easymoney-playwright-lease-'));
    temporaryDirectories.push(root);
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
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
    }, async () => {
      secondEntered = true;
      return 'wells-fargo';
    });

    expect(await second).toBe('wells-fargo');
    expect(secondEntered).toBe(true);

    releaseFirst.resolve();
    expect(await first).toBe('fidelity');
  });

  test('serializes interactive browsers that share a profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'easymoney-playwright-lease-'));
    temporaryDirectories.push(root);
    const profilePath = join(root, 'fidelity-catchup');
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const secondWaiting = Promise.withResolvers<void>();
    let secondEntered = false;

    const first = withInteractiveBrowserLease({
      profilePath,
      sessionName: 'fidelity-catchup',
      pollIntervalMs: 5,
    }, async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      return 'first';
    });
    await firstEntered.promise;

    const second = withInteractiveBrowserLease({
      profilePath,
      sessionName: 'fidelity-catchup',
      pollIntervalMs: 5,
      onWait: () => secondWaiting.resolve(),
    }, async () => {
      secondEntered = true;
      return 'second';
    });
    await secondWaiting.promise;
    expect(secondEntered).toBe(false);

    releaseFirst.resolve();
    expect(await first).toBe('first');
    expect(await second).toBe('second');
    expect(secondEntered).toBe(true);
  });

  test('immediately reclaims a browser lease whose worker is dead', async () => {
    const root = await mkdtemp(join(tmpdir(), 'easymoney-playwright-lease-'));
    temporaryDirectories.push(root);
    const profilePath = join(root, 'vanguard-catchup');
    const lockPath = join(profilePath, '.interactive-browser.lock');
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      token: 'dead-worker',
      pid: 12345,
      sessionName: 'vanguard-catchup',
      startedAt: new Date().toISOString(),
    }));

    let entered = false;
    const result = await withInteractiveBrowserLease({
      profilePath,
      sessionName: 'vanguard-catchup',
      staleAfterMs: 60_000,
      processIsAlive: () => false,
    }, async () => {
      entered = true;
      return 'recovered';
    });

    expect(result).toBe('recovered');
    expect(entered).toBe(true);
  });

  test('does not reclaim a stale browser lease while its worker is alive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'easymoney-playwright-lease-'));
    temporaryDirectories.push(root);
    const profilePath = join(root, 'vanguard-catchup');
    const lockPath = join(profilePath, '.interactive-browser.lock');
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      token: 'live-worker',
      pid: 12345,
      sessionName: 'vanguard-catchup',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    await expect(withInteractiveBrowserLease({
      profilePath,
      sessionName: 'vanguard-catchup',
      timeoutMs: 20,
      staleAfterMs: 1,
      pollIntervalMs: 5,
      processIsAlive: () => true,
    }, async () => 'overlapped')).rejects.toThrow('Timed out waiting');
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

  test('follows a replacement page when an institution closes its login page', async () => {
    const contextEvents = new EventEmitter();
    const originalEvents = new EventEmitter();
    const replacementEvents = new EventEmitter();
    let originalClosed = false;
    let pages: Page[] = [];
    const originalPage = Object.assign(originalEvents, {
      context: () => context,
      isClosed: () => originalClosed,
      url: () => 'https://login.example.test/',
    }) as unknown as Page;
    const replacementPage = Object.assign(replacementEvents, {
      context: () => context,
      isClosed: () => false,
      url: () => 'https://example.test/accounts',
    }) as unknown as Page;
    const context = Object.assign(contextEvents, {
      pages: () => pages,
    });
    pages = [originalPage];

    const waiting = waitForInteractiveAuthentication(
      originalPage,
      Date.now() + 5_000,
      {
        isAuthenticated: async currentPage => currentPage === replacementPage,
        waitUntilAuthenticated: async () => new Promise<void>(() => {}),
      },
      context as never,
    );
    await Promise.resolve();

    pages = [replacementPage];
    contextEvents.emit('page', replacementPage);
    originalClosed = true;
    originalEvents.emit('close');

    expect(await waiting).toBe(replacementPage);
  });

  test('still rejects when the browser context closes during authentication', async () => {
    const contextEvents = new EventEmitter();
    const pageEvents = new EventEmitter();
    const page = Object.assign(pageEvents, {
      context: () => context,
      isClosed: () => false,
      url: () => 'https://login.example.test/',
    }) as unknown as Page;
    const context = Object.assign(contextEvents, {
      pages: () => [page],
    });

    const waiting = waitForInteractiveAuthentication(
      page,
      Date.now() + 5_000,
      {
        isAuthenticated: async () => false,
        waitUntilAuthenticated: async () => new Promise<void>(() => {}),
      },
      context as never,
    );
    await Promise.resolve();
    contextEvents.emit('close');

    await expect(waiting).rejects.toThrow('browser was closed before authentication completed');
  });

  test('reopens the institution page when its only authentication page closes', async () => {
    const contextEvents = new EventEmitter();
    const originalEvents = new EventEmitter();
    let originalClosed = false;
    let recoveryUrl = '';
    let pages: Page[] = [];
    const originalPage = Object.assign(originalEvents, {
      context: () => context,
      isClosed: () => originalClosed,
      url: () => 'https://login.example.test/',
    }) as unknown as Page;
    const recoveryPage = Object.assign(new EventEmitter(), {
      isClosed: () => false,
      url: () => recoveryUrl,
      goto: async (url: string) => {
        const recovered = new URL(url);
        recovered.pathname = '/accounts';
        recoveryUrl = recovered.toString();
        return null;
      },
    }) as unknown as Page;
    const context = Object.assign(contextEvents, {
      pages: () => pages,
      newPage: async () => {
        pages = [recoveryPage];
        return recoveryPage;
      },
    });
    pages = [originalPage];

    const waiting = waitForInteractiveAuthentication(
      originalPage,
      Date.now() + 5_000,
      {
        authenticationRecoveryUrl: 'https://login.example.test/login',
        isAuthenticated: async currentPage => currentPage.url().endsWith('/accounts'),
        waitUntilAuthenticated: async () => new Promise<void>(() => {}),
      },
      context as never,
    );
    await Promise.resolve();
    originalClosed = true;
    pages = [];
    originalEvents.emit('close');

    expect(await waiting).toBe(recoveryPage);
    expect(recoveryUrl).toBe('https://login.example.test/accounts');
  });

  test('bounds recovery when Playwright cannot reopen a closed authentication page', async () => {
    const contextEvents = new EventEmitter();
    const pageEvents = new EventEmitter();
    let pageClosed = false;
    let pages: Page[] = [];
    const page = Object.assign(pageEvents, {
      context: () => context,
      isClosed: () => pageClosed,
      url: () => 'https://login.example.test/',
    }) as unknown as Page;
    const context = Object.assign(contextEvents, {
      pages: () => pages,
      newPage: async () => new Promise<Page>(() => {}),
    });
    pages = [page];

    const startedAt = performance.now();
    const waiting = waitForInteractiveAuthentication(
      page,
      Date.now() + 20,
      {
        authenticationRecoveryUrl: 'https://login.example.test/login',
        isAuthenticated: async () => false,
        waitUntilAuthenticated: async () => new Promise<void>(() => {}),
      },
      context as never,
    );
    await Promise.resolve();
    pageClosed = true;
    pages = [];
    pageEvents.emit('close');

    await expect(waiting).rejects.toThrow('Browser stopped responding while reopening authentication');
    expect(performance.now() - startedAt).toBeLessThan(250);
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
      bringToFront: async () => events.push('foreground'),
      screencast: {
        showChapter: async (title: string) => events.push(`show:${title}`),
        hideOverlays: async () => events.push('hide'),
      },
      waitForTimeout: async (duration: number) => events.push(`wait:${duration}`),
    } as unknown as Page;

    await showAuthenticationChapter(page, 'Sign in and complete MFA.');

    expect(events).toEqual(['foreground', 'show:Sign in required', 'wait:2000', 'hide']);
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

  test('bounds an authentication checkpoint when the page check never settles', async () => {
    const context = new EventEmitter();
    const page = Object.assign(new EventEmitter(), {
      context: () => context,
      isClosed: () => false,
    }) as unknown as Page;

    const startedAt = performance.now();
    const authenticated = await checkAuthenticationForCheckpoint(
      page,
      async () => new Promise<boolean>(() => {}),
      10,
    );

    expect(authenticated).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(context.listenerCount('close')).toBe(0);
  });

  test('ends an authentication checkpoint as soon as its browser page closes', async () => {
    const context = new EventEmitter();
    const pageEvents = new EventEmitter();
    const page = Object.assign(pageEvents, {
      context: () => context,
      isClosed: () => false,
    }) as unknown as Page;

    const checking = checkAuthenticationForCheckpoint(
      page,
      async () => new Promise<boolean>(() => {}),
      5_000,
    );
    await Promise.resolve();
    pageEvents.emit('close');

    expect(await checking).toBe(false);
    expect(pageEvents.listenerCount('close')).toBe(0);
    expect(context.listenerCount('close')).toBe(0);
  });

  test('persists session storage that Playwright storage state omits', async () => {
    const profilePath = await mkdtemp(join(tmpdir(), 'easymoney-playwright-session-storage-'));
    temporaryDirectories.push(profilePath);
    const authStatePath = playwrightAuthStatePath(profilePath);
    const context = {
      storageState: async ({ path }: { path: string }) => {
        await writeFile(path, JSON.stringify({ cookies: [], origins: [] }));
      },
      pages: () => [{
        isClosed: () => false,
        evaluate: async () => ({
          origin: 'https://accounts.example.test',
          entries: { authenticatedFlow: 'resume-token' },
        }),
      }],
    };

    expect(await persistBrowserAuthentication(context as never, authStatePath)).toBe(true);
    expect(JSON.parse(await readFile(playwrightSessionStoragePath(profilePath), 'utf8'))).toEqual({
      'https://accounts.example.test': { authenticatedFlow: 'resume-token' },
    });
  });

  test('restores session storage before reopening the institution page', async () => {
    const profilePath = await mkdtemp(join(tmpdir(), 'easymoney-playwright-session-restore-'));
    temporaryDirectories.push(profilePath);
    await writeFile(playwrightAuthStatePath(profilePath), JSON.stringify({ cookies: [], origins: [] }));
    const saved = {
      'https://accounts.example.test': { authenticatedFlow: 'resume-token' },
    };
    await writeFile(playwrightSessionStoragePath(profilePath), JSON.stringify(saved));
    let restoredStatePath: string | undefined;
    let restoredSessionStorage: unknown;
    const context = {
      setStorageState: async (path: string) => {
        restoredStatePath = path;
      },
      addInitScript: async (_script: unknown, value: unknown) => {
        restoredSessionStorage = value;
      },
    };

    await restoreBrowserAuthentication(context as never, profilePath);

    expect(restoredStatePath).toBe(playwrightAuthStatePath(profilePath));
    expect(restoredSessionStorage).toEqual(saved);
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

  test('rejects when the browser disconnects without a context close', async () => {
    const browser = Object.assign(new EventEmitter(), {
      isConnected: () => true,
    });
    const context = Object.assign(new EventEmitter(), {
      browser: () => browser,
    });
    const running = runWhileBrowserOpen(
      context as never,
      () => new Promise<never>(() => {}),
    );
    await Promise.resolve();
    browser.emit('disconnected');

    await expect(running).rejects.toThrow('Browser closed before the institution sync completed');
    expect(browser.listenerCount('disconnected')).toBe(0);
    expect(context.listenerCount('close')).toBe(0);
  });
});
