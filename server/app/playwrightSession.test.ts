import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';

import {
  checkAuthenticationForCheckpoint,
  closeBrowserContext,
  decodeInstitutionBrowserProgramResult,
  institutionBrowserLaunchStrategy,
  institutionStartPage,
  launchPersistentContextWithDeadline,
  normalizeHeadlessUserAgent,
  openInstitutionStartPage,
  persistBrowserAuthentication,
  playwrightAuthStatePath,
  playwrightHasSavedAuthentication,
  playwrightProfilePath,
  playwrightSessionStoragePath,
  restoreBrowserAuthentication,
  requiresFreshInstitutionPage,
  runInstitutionBrowserProgram,
  runWithNormalizedHeadlessUserAgent,
  runWhileBrowserOpen,
  showAuthenticationChapter,
  showSyncCompletionChapter,
  waitForInteractiveAuthentication,
  withInteractiveBrowserLease,
  withPlaywrightPage,
  withTransientBrowserProfile,
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

  test('creates a fresh fallback page before closing restored pages', async () => {
    const events: string[] = [];
    const restoredPage = {
      isClosed: () => false,
      close: async () => {
        events.push('close-restored');
      },
    } as unknown as Page;
    const freshPage = { isClosed: () => false } as unknown as Page;
    const context = {
      pages: () => [restoredPage],
      newPage: async () => {
        events.push('create-fresh');
        return freshPage;
      },
    } as unknown as Pick<BrowserContext, 'newPage' | 'pages'>;

    expect(await institutionStartPage(context, true)).toBe(freshPage);
    expect(events).toEqual(['create-fresh', 'close-restored']);
  });

  test('continues with the fresh page when a restored page never finishes closing', async () => {
    const restoredPage = {
      isClosed: () => false,
      close: () => new Promise<void>(() => {}),
    } as unknown as Page;
    const freshPage = { isClosed: () => false } as unknown as Page;
    const context = {
      pages: () => [restoredPage],
      newPage: async () => freshPage,
    } as unknown as Pick<BrowserContext, 'newPage' | 'pages'>;

    const startedAt = performance.now();
    expect(await institutionStartPage(context, true, 10, 10)).toBe(freshPage);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test('normalizes only the HeadlessChrome user-agent token', () => {
    expect(normalizeHeadlessUserAgent(
      'Mozilla/5.0 AppleWebKit/537.36 HeadlessChrome/151.0.0.0 Safari/537.36',
    )).toBe('Mozilla/5.0 AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36');
    expect(normalizeHeadlessUserAgent(
      'Mozilla/5.0 AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
    )).toBe('Mozilla/5.0 AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36');
  });

  test('keeps the normalized user agent attached before navigation and through the operation', async () => {
    const events: string[] = [];
    const session = {
      send: async (method: string, params: { userAgent: string }) => {
        events.push(`${method}:${params.userAgent.includes('HeadlessChrome/') ? 'headless' : 'normal'}`);
      },
      detach: async () => {
        events.push('detach');
      },
    };
    const page = {
      evaluate: async () => {
        events.push('evaluate-user-agent');
        return 'Mozilla/5.0 HeadlessChrome/151.0.0.0 Safari/537.36';
      },
    } as unknown as Page;
    const context = {
      newCDPSession: async () => {
        events.push('open-session');
        return session;
      },
    } as unknown as BrowserContext;

    await expect(runWithNormalizedHeadlessUserAgent(page, context, true, async () => {
      events.push('navigate-start-url');
      events.push('run-institution');
      return 'complete';
    })).resolves.toBe('complete');
    expect(events).toEqual([
      'evaluate-user-agent',
      'open-session',
      'Network.setUserAgentOverride:normal',
      'navigate-start-url',
      'run-institution',
      'detach',
    ]);
  });

  test('releases the normalized user-agent session when the institution operation fails', async () => {
    const events: string[] = [];
    const page = {
      evaluate: async () => 'Mozilla/5.0 HeadlessChrome/151.0.0.0 Safari/537.36',
    } as unknown as Page;
    const context = {
      newCDPSession: async () => ({
        send: async () => events.push('override'),
        detach: async () => events.push('detach'),
      }),
    } as unknown as BrowserContext;

    await expect(runWithNormalizedHeadlessUserAgent(page, context, true, async () => {
      events.push('operation');
      throw new Error('observed failure');
    })).rejects.toThrow('observed failure');
    expect(events).toEqual(['override', 'operation', 'detach']);
  });

  test('leaves headed and already-normal browser identities alone', async () => {
    const events: string[] = [];
    const headedPage = {
      evaluate: async () => {
        throw new Error('headed sessions must not read browser identity');
      },
    } as unknown as Page;
    const normalPage = {
      evaluate: async () => 'Mozilla/5.0 Chrome/151.0.0.0 Safari/537.36',
    } as unknown as Page;
    const context = {
      newCDPSession: async () => {
        throw new Error('a normal browser identity must not open a CDP session');
      },
    } as unknown as BrowserContext;

    await runWithNormalizedHeadlessUserAgent(headedPage, context, false, async () => {
      events.push('headed-operation');
    });
    await runWithNormalizedHeadlessUserAgent(normalPage, context, true, async () => {
      events.push('normal-operation');
    });
    expect(events).toEqual(['headed-operation', 'normal-operation']);
  });

  test('uses a fresh page for every headless session or explicit headed start', () => {
    expect(requiresFreshInstitutionPage({ headless: true })).toBe(true);
    expect(requiresFreshInstitutionPage({ headless: false })).toBe(false);
    expect(requiresFreshInstitutionPage({ headless: false, forceStartUrl: true })).toBe(true);
  });

  test('does not hang when opening the first page after browser launch never settles', async () => {
    const context = {
      pages: () => [],
      newPage: () => new Promise<Page>(() => {}),
    } as unknown as Pick<BrowserContext, 'newPage' | 'pages'>;

    const startedAt = performance.now();
    await expect(institutionStartPage(context, false, 10))
      .rejects.toThrow('Timed out opening an institution browser page');
    expect(performance.now() - startedAt).toBeLessThan(250);
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

  test('uses a fresh transient profile for the cached-auth probe and the canonical profile for fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'easymoney-playwright-profile-split-'));
    temporaryDirectories.push(root);
    const canonicalProfilePath = join(root, 'profiles', 'tiaa-catchup');
    const transientRoot = join(root, 'transient');
    await mkdir(canonicalProfilePath, { recursive: true });
    await writeFile(playwrightAuthStatePath(canonicalProfilePath), JSON.stringify({ cookies: [], origins: [] }));

    const attempts: Array<{
      headless: boolean;
      profilePath: string;
      authenticationProfilePath: string;
      interactiveLeaseProfilePath: string;
      forceStartUrl: boolean;
    }> = [];
    let transientProfilePath = '';
    let transientProfileMode = 0;
    const fakeWithPlaywrightPage: typeof withPlaywrightPage = async (sessionOptions, operation) => {
      const headless = sessionOptions.contextOptions?.headless ?? false;
      attempts.push({
        headless,
        profilePath: sessionOptions.profilePath ?? '',
        authenticationProfilePath: sessionOptions.authenticationProfilePath ?? '',
        interactiveLeaseProfilePath: sessionOptions.interactiveLeaseProfilePath ?? '',
        forceStartUrl: sessionOptions.forceStartUrl ?? false,
      });
      const context = new EventEmitter();
      const page = Object.assign(new EventEmitter(), {
        headlessProbe: headless,
        isClosed: () => false,
        context: () => context,
        screencast: { showChapter: async () => {} },
      }) as unknown as Page;
      Object.assign(context, { pages: () => [page] });
      return operation(page, context as unknown as BrowserContext);
    };
    const fakeWithTransientBrowserProfile: typeof withTransientBrowserProfile = async operation =>
      withTransientBrowserProfile(async profilePath => {
        transientProfilePath = profilePath;
        transientProfileMode = (await stat(profilePath)).mode & 0o777;
        return operation(profilePath);
      }, { temporaryRoot: transientRoot });

    const result = await runInstitutionBrowserProgram(
      {
        name: 'tiaa-catchup',
        startUrl: 'https://example.test/start',
        profilePath: canonicalProfilePath,
      },
      `async page => JSON.stringify({ status: page.headlessProbe ? 'login-required' : 'complete' })`,
      {
        completionDescription: 'Downloads complete.',
        isAuthenticated: async () => false,
      },
      {
        withPlaywrightPage: fakeWithPlaywrightPage,
        withTransientBrowserProfile: fakeWithTransientBrowserProfile,
      },
    );

    expect(result.status).toBe('complete');
    expect(transientProfilePath).not.toBe(canonicalProfilePath);
    expect(transientProfileMode).toBe(0o700);
    expect(attempts).toEqual([
      {
        headless: true,
        profilePath: transientProfilePath,
        authenticationProfilePath: canonicalProfilePath,
        interactiveLeaseProfilePath: canonicalProfilePath,
        forceStartUrl: false,
      },
      {
        headless: false,
        profilePath: canonicalProfilePath,
        authenticationProfilePath: canonicalProfilePath,
        interactiveLeaseProfilePath: canonicalProfilePath,
        forceStartUrl: true,
      },
    ]);
    expect(await stat(transientProfilePath).then(() => true, () => false)).toBe(false);
  });

  test('checkpoints a successful transient probe to canonical authentication state only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'easymoney-playwright-canonical-auth-'));
    temporaryDirectories.push(root);
    const canonicalProfilePath = join(root, 'profiles', 'vanguard-catchup');
    const transientRoot = join(root, 'transient');
    await mkdir(canonicalProfilePath, { recursive: true });
    await writeFile(playwrightAuthStatePath(canonicalProfilePath), JSON.stringify({ old: true }));
    await writeFile(playwrightSessionStoragePath(canonicalProfilePath), JSON.stringify({
      'https://stale.example.test': { stale: 'state' },
    }));

    const authenticationState = { cookies: [{ name: 'session', value: 'fresh' }], origins: [] };
    let transientProfilePath = '';
    let transientAuthStateWasWritten = false;
    const fakeWithPlaywrightPage: typeof withPlaywrightPage = async (sessionOptions, operation) => {
      const context = new EventEmitter();
      const page = Object.assign(new EventEmitter(), {
        isClosed: () => false,
        context: () => context,
        evaluate: async () => ({
          origin: 'https://accounts.example.test',
          entries: { authenticatedFlow: 'fresh-resume-token' },
        }),
        screencast: { showChapter: async () => {} },
      }) as unknown as Page;
      Object.assign(context, {
        pages: () => [page],
        storageState: async (options: unknown) => {
          expect(options).toEqual({ indexedDB: true });
          return authenticationState;
        },
      });
      const result = await operation(page, context as unknown as BrowserContext);
      transientAuthStateWasWritten = await stat(playwrightAuthStatePath(sessionOptions.profilePath ?? ''))
        .then(() => true, () => false);
      return result;
    };
    const fakeWithTransientBrowserProfile: typeof withTransientBrowserProfile = async operation =>
      withTransientBrowserProfile(profilePath => {
        transientProfilePath = profilePath;
        return operation(profilePath);
      }, { temporaryRoot: transientRoot });

    const result = await runInstitutionBrowserProgram(
      {
        name: 'vanguard-catchup',
        startUrl: 'https://example.test/start',
        profilePath: canonicalProfilePath,
      },
      `async () => JSON.stringify({ status: 'complete' })`,
      {
        completionDescription: 'Downloads complete.',
        isAuthenticated: async () => true,
      },
      {
        withPlaywrightPage: fakeWithPlaywrightPage,
        withTransientBrowserProfile: fakeWithTransientBrowserProfile,
      },
    );

    expect(result.status).toBe('complete');
    expect(transientAuthStateWasWritten).toBe(false);
    expect(JSON.parse(await readFile(playwrightAuthStatePath(canonicalProfilePath), 'utf8')))
      .toEqual(authenticationState);
    expect(JSON.parse(await readFile(playwrightSessionStoragePath(canonicalProfilePath), 'utf8'))).toEqual({
      'https://accounts.example.test': { authenticatedFlow: 'fresh-resume-token' },
    });
    expect(await stat(transientProfilePath).then(() => true, () => false)).toBe(false);
  });

  test('uses a transient headed profile and canonical lease identity when authentication caching is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'easymoney-playwright-no-auth-cache-'));
    temporaryDirectories.push(root);
    const canonicalProfilePath = join(root, 'profiles', 'sequoia-fund-catchup');
    const transientRoot = join(root, 'transient');
    const savedAuthentication = JSON.stringify({ existing: 'authentication' });
    const savedSessionStorage = JSON.stringify({
      'https://accounts.example.test': { existing: 'session' },
    });
    await mkdir(canonicalProfilePath, { recursive: true });
    await writeFile(playwrightAuthStatePath(canonicalProfilePath), savedAuthentication);
    await writeFile(playwrightSessionStoragePath(canonicalProfilePath), savedSessionStorage);

    let transientProfilePath = '';
    let storageStateCalls = 0;
    const attempts: Array<{
      headless: boolean;
      profilePath: string;
      authenticationProfilePath: string;
      interactiveLeaseProfilePath: string;
      forceStartUrl: boolean;
    }> = [];
    const fakeWithPlaywrightPage: typeof withPlaywrightPage = async (sessionOptions, operation) => {
      attempts.push({
        headless: sessionOptions.contextOptions?.headless ?? false,
        profilePath: sessionOptions.profilePath ?? '',
        authenticationProfilePath: sessionOptions.authenticationProfilePath ?? '',
        interactiveLeaseProfilePath: sessionOptions.interactiveLeaseProfilePath ?? '',
        forceStartUrl: sessionOptions.forceStartUrl ?? false,
      });
      const context = new EventEmitter();
      const page = Object.assign(new EventEmitter(), {
        isClosed: () => false,
        context: () => context,
        screencast: { showChapter: async () => {} },
      }) as unknown as Page;
      Object.assign(context, {
        pages: () => [page],
        storageState: async () => {
          storageStateCalls += 1;
          return { cookies: [], origins: [] };
        },
      });
      return operation(page, context as unknown as BrowserContext);
    };
    const fakeWithTransientBrowserProfile: typeof withTransientBrowserProfile = async operation =>
      withTransientBrowserProfile(profilePath => {
        transientProfilePath = profilePath;
        return operation(profilePath);
      }, { temporaryRoot: transientRoot });

    const result = await runInstitutionBrowserProgram(
      {
        name: 'sequoia-fund-catchup',
        startUrl: 'https://example.test/start',
        profilePath: canonicalProfilePath,
        persistAuthentication: false,
      },
      `async () => JSON.stringify({ status: 'complete' })`,
      {
        completionDescription: 'Downloads complete.',
        isAuthenticated: async () => true,
      },
      {
        withPlaywrightPage: fakeWithPlaywrightPage,
        withTransientBrowserProfile: fakeWithTransientBrowserProfile,
      },
    );

    expect(result.status).toBe('complete');
    expect(transientProfilePath).not.toBe(canonicalProfilePath);
    expect(attempts).toEqual([{
      headless: false,
      profilePath: transientProfilePath,
      authenticationProfilePath: canonicalProfilePath,
      interactiveLeaseProfilePath: canonicalProfilePath,
      forceStartUrl: false,
    }]);
    expect(storageStateCalls).toBe(0);
    expect(await readFile(playwrightAuthStatePath(canonicalProfilePath), 'utf8')).toBe(savedAuthentication);
    expect(await readFile(playwrightSessionStoragePath(canonicalProfilePath), 'utf8')).toBe(savedSessionStorage);
    expect(await stat(transientProfilePath).then(() => true, () => false)).toBe(false);
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

  test('bounds a browser launch that settles late and closes its eventual context once', async () => {
    const launch = Promise.withResolvers<BrowserContext>();
    const lateContextClosed = Promise.withResolvers<void>();
    let closeCalls = 0;
    const lateContext = {
      close: async () => {
        closeCalls += 1;
        lateContextClosed.resolve();
      },
    } as unknown as BrowserContext;

    const startedAt = performance.now();
    await expect(launchPersistentContextWithDeadline(
      () => launch.promise,
      { sessionName: 'tiaa-catchup', timeoutMs: 10 },
    )).rejects.toThrow('Timed out opening the tiaa-catchup browser');
    expect(performance.now() - startedAt).toBeLessThan(250);

    launch.resolve(lateContext);
    await lateContextClosed.promise;
    expect(closeCalls).toBe(1);
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
    const authenticationState = { cookies: [], origins: [] };
    const context = {
      storageState: async (options: unknown) => {
        expect(options).toEqual({ indexedDB: true });
        return authenticationState;
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
    expect(JSON.parse(await readFile(authStatePath, 'utf8'))).toEqual(authenticationState);
    expect(JSON.parse(await readFile(playwrightSessionStoragePath(profilePath), 'utf8'))).toEqual({
      'https://accounts.example.test': { authenticatedFlow: 'resume-token' },
    });
  });

  test('removes stale saved session storage when the browser has none', async () => {
    const profilePath = await mkdtemp(join(tmpdir(), 'easymoney-playwright-stale-session-storage-'));
    temporaryDirectories.push(profilePath);
    const authStatePath = playwrightAuthStatePath(profilePath);
    const sessionStoragePath = playwrightSessionStoragePath(profilePath);
    await writeFile(sessionStoragePath, JSON.stringify({
      'https://stale.example.test': { stale: 'value' },
    }));
    const context = {
      storageState: async () => ({ cookies: [], origins: [] }),
      pages: () => [],
    };

    expect(await persistBrowserAuthentication(context as never, authStatePath)).toBe(true);
    expect(await stat(sessionStoragePath).then(() => true, () => false)).toBe(false);
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
