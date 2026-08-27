import { chmod, mkdir, mkdtemp, open, readFile, readlink, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export const PLAYWRIGHT_VERSION = '1.62.1';

export type PlaywrightProfileState = 'existing' | 'missing';

export type InstitutionBrowserLaunchStrategy = {
  initialHeadless: boolean;
  allowHeadedAuthenticationFallback: boolean;
};

type PersistentContextOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

type SessionOptions = {
  name: string;
  startUrl: string;
  beforeStartNavigation?: (page: Page, context: BrowserContext) => void | Promise<void>;
  profilePath?: string;
  authenticationProfilePath?: string;
  interactiveLeaseProfilePath?: string;
  forceStartUrl?: boolean;
  persistAuthentication?: boolean;
  browserLaunchTimeoutMs?: number;
  onInteractiveBrowserWait?: (message: string) => void;
  contextOptions?: PersistentContextOptions;
  launchArgs?: string[];
};

type RunOptions = {
  allowInteractiveAuthentication?: boolean;
  authenticationTimeoutMs?: number;
  authenticationCheckpointTimeoutMs?: number;
  authenticationRecoveryUrl?: string;
  isAuthenticated?: (page: Page) => boolean | Promise<boolean>;
  waitUntilAuthenticated?: (page: Page, timeoutMs: number) => Promise<void>;
  onProgress?: (message: string) => void;
  programBindings?: Record<string, unknown>;
  completionDescription: string;
  completionDurationMs?: number;
};

export type InstitutionBrowserProgramResult<T extends Record<string, unknown> = Record<string, never>> =
  | ({ status: 'complete' } & T)
  | { status: 'login-required'; action?: string }
  | { status: 'error'; message?: string };

export function playwrightProfilePath(
  name: string,
  options: { home?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): string {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathApi = platform === 'win32' ? win32 : posix;
  const root = platform === 'darwin'
    ? pathApi.join(home, 'Library', 'Application Support', 'EasyMoney', 'playwright-profiles')
    : platform === 'win32'
      ? pathApi.join(env.LOCALAPPDATA ?? pathApi.join(home, 'AppData', 'Local'), 'EasyMoney', 'playwright-profiles')
      : pathApi.join(env.XDG_STATE_HOME ?? pathApi.join(home, '.local', 'state'), 'easymoney', 'playwright-profiles');
  return pathApi.join(root, name);
}

export function playwrightAuthStatePath(profilePath: string): string {
  return resolve(profilePath, '.easymoney-auth-state.json');
}

export function playwrightSessionStoragePath(profilePath: string): string {
  return resolve(profilePath, '.easymoney-session-storage.json');
}

export async function withTransientBrowserProfile<T>(
  operation: (profilePath: string) => Promise<T>,
  options: { temporaryRoot?: string } = {},
): Promise<T> {
  const temporaryRoot = resolve(options.temporaryRoot ?? tmpdir());
  await mkdir(temporaryRoot, { recursive: true });
  const profilePath = await mkdtemp(join(temporaryRoot, '.easymoney-headless-profile-'));
  if (process.platform !== 'win32') await chmod(profilePath, 0o700);
  try {
    return await operation(profilePath);
  } finally {
    await rm(profilePath, { recursive: true, force: true });
  }
}

type InteractiveBrowserLeaseOptions = {
  profilePath: string;
  sessionName: string;
  timeoutMs?: number;
  staleAfterMs?: number;
  pollIntervalMs?: number;
  onWait?: (message: string) => void;
  processIsAlive?: (pid: number) => boolean;
};

type InteractiveBrowserLeaseOwner = {
  token: string;
  pid: number;
  sessionName: string;
  startedAt: string;
};

const interactiveBrowserLockName = '.interactive-browser.lock';

function interactiveBrowserLockPath(profilePath: string): string {
  return join(resolve(profilePath), interactiveBrowserLockName);
}

function fileSystemErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : null;
}

async function interactiveBrowserLeaseMatches(lockPath: string, token: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as Partial<InteractiveBrowserLeaseOwner>;
    return owner.token === token;
  } catch {
    return false;
  }
}

async function interactiveBrowserLeaseOwner(
  lockPath: string,
): Promise<InteractiveBrowserLeaseOwner | null> {
  try {
    const owner = JSON.parse(
      await readFile(join(lockPath, 'owner.json'), 'utf8'),
    ) as Partial<InteractiveBrowserLeaseOwner>;
    if (typeof owner.token !== 'string' ||
        !Number.isInteger(owner.pid) || owner.pid! <= 0 ||
        typeof owner.sessionName !== 'string' ||
        typeof owner.startedAt !== 'string') {
      return null;
    }
    return owner as InteractiveBrowserLeaseOwner;
  } catch {
    return null;
  }
}

function systemProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return fileSystemErrorCode(error) !== 'ESRCH';
  }
}

async function interactiveBrowserLeaseCanBeReclaimed(
  lockPath: string,
  modifiedAtMs: number,
  staleAfterMs: number,
  processIsAlive: (pid: number) => boolean,
): Promise<boolean> {
  const owner = await interactiveBrowserLeaseOwner(lockPath);
  if (owner) return !processIsAlive(owner.pid);
  return Date.now() - modifiedAtMs > staleAfterMs;
}

export async function withInteractiveBrowserLease<T>(
  options: InteractiveBrowserLeaseOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = interactiveBrowserLockPath(options.profilePath);
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const staleAfterMs = options.staleAfterMs ?? 2 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  const token = crypto.randomUUID();
  const processIsAlive = options.processIsAlive ?? systemProcessIsAlive;
  let reportedWait = false;

  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      const owner: InteractiveBrowserLeaseOwner = {
        token,
        pid: process.pid,
        sessionName: options.sessionName,
        startedAt: new Date().toISOString(),
      };
      try {
        await writeFile(join(lockPath, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (fileSystemErrorCode(error) !== 'EEXIST') throw error;
      const lockStat = await stat(lockPath).catch(() => null);
      if (!lockStat) continue;
      if (await interactiveBrowserLeaseCanBeReclaimed(
        lockPath,
        lockStat.mtimeMs,
        staleAfterMs,
        processIsAlive,
      )) {
        const cleanupLockPath = `${lockPath}.cleanup`;
        let ownsCleanupLock = false;
        try {
          await mkdir(cleanupLockPath);
          ownsCleanupLock = true;
          const currentLockStat = await stat(lockPath).catch(() => null);
          if (currentLockStat && await interactiveBrowserLeaseCanBeReclaimed(
            lockPath,
            currentLockStat.mtimeMs,
            staleAfterMs,
            processIsAlive,
          )) {
            await rm(lockPath, { recursive: true, force: true });
          }
        } catch (cleanupError) {
          if (fileSystemErrorCode(cleanupError) !== 'EEXIST') throw cleanupError;
        } finally {
          if (ownsCleanupLock) await rm(cleanupLockPath, { recursive: true, force: true });
        }
        continue;
      }
      if (!reportedWait) {
        reportedWait = true;
        options.onWait?.('Waiting for another institution sign-in to finish');
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting to open the ${options.sessionName} sign-in browser`);
      }
      await Bun.sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }

  const heartbeat = setInterval(() => {
    void interactiveBrowserLeaseMatches(lockPath, token).then(matches => {
      if (matches) return utimes(lockPath, new Date(), new Date());
    }).catch(() => {});
  }, Math.max(1_000, Math.floor(staleAfterMs / 3)));

  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    if (await interactiveBrowserLeaseMatches(lockPath, token)) {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}

async function directoryExists(path: string): Promise<boolean> {
  return stat(path).then(info => info.isDirectory()).catch(() => false);
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(info => info.isFile()).catch(() => false);
}

export async function playwrightProfileState(
  name: string,
  profilePath = playwrightProfilePath(name),
): Promise<PlaywrightProfileState> {
  return await directoryExists(profilePath) ? 'existing' : 'missing';
}

export async function playwrightHasSavedAuthentication(
  name: string,
  profilePath = playwrightProfilePath(name),
): Promise<boolean> {
  return fileExists(playwrightAuthStatePath(resolve(profilePath)));
}

export async function openInstitutionStartPage(
  page: Pick<Page, 'goto' | 'url'>,
  startUrl: string,
  restoredAuthentication: boolean,
  forceStartUrl = false,
): Promise<void> {
  if (!forceStartUrl && page.url() !== 'about:blank' && !restoredAuthentication) return;
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
}

const defaultBrowserLaunchTimeoutMs = 30_000;
const browserLaunchWatchdogGraceMs = 1_000;
const restoredPageCloseTimeoutMs = 1_000;
export const institutionAutomationControlledLaunchArgument =
  '--disable-blink-features=AutomationControlled';

export function institutionBrowserLaunchArguments(
  ...argumentGroups: Array<readonly string[] | undefined>
): string[] {
  const blinkFeatures = new Set(['AutomationControlled']);
  const launchArguments: string[] = [];

  for (const group of argumentGroups) {
    if (!group) continue;
    for (let index = 0; index < group.length; index += 1) {
      const argument = group[index]!;
      let features: string | undefined;
      if (argument === '--disable-blink-features') {
        const nextArgument = group[index + 1];
        if (nextArgument && !nextArgument.startsWith('--')) {
          features = nextArgument;
          index += 1;
        }
      } else if (argument.startsWith('--disable-blink-features=')) {
        features = argument.slice('--disable-blink-features='.length);
      } else {
        launchArguments.push(argument);
        continue;
      }

      for (const feature of (features ?? '').split(',')) {
        const normalized = feature.trim();
        if (normalized) blinkFeatures.add(normalized);
      }
    }
  }

  return [
    `--disable-blink-features=${[...blinkFeatures].join(',')}`,
    ...launchArguments,
  ];
}

export function normalizeHeadlessUserAgent(userAgent: string): string {
  return userAgent.replace(/\bHeadlessChrome\//, 'Chrome/');
}

type NormalChromeUserAgentProbeOptions = {
  timeoutMs?: number;
  launch?: () => Promise<Pick<Browser, 'newPage' | 'close'>>;
};

export async function deriveNormalChromeUserAgent(
  options: NormalChromeUserAgentProbeOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? defaultBrowserLaunchTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Chrome user-agent probe timeout must be a positive number');
  }

  const timeoutError = () => new Error('Timed out reading the installed Chrome user agent');
  let browser: Pick<Browser, 'newPage' | 'close'> | undefined;
  let browserClose: Promise<unknown> | undefined;
  let deadlineExpired = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const launch = options.launch ?? (() => chromium.launch({
    channel: 'chrome',
    headless: true,
    chromiumSandbox: true,
    timeout: timeoutMs,
    args: institutionBrowserLaunchArguments(),
  }));
  const closeBrowser = () => {
    if (!browser) return Promise.resolve();
    browserClose ??= browser.close().catch(() => {});
    return browserClose;
  };

  const probe = (async () => {
    try {
      browser = await launch();
      if (deadlineExpired) throw timeoutError();
      const page = await browser.newPage();
      if (deadlineExpired) throw timeoutError();
      const userAgent = await page.evaluate(() => navigator.userAgent);
      const normalizedUserAgent = normalizeHeadlessUserAgent(userAgent);
      if (/\bHeadlessChrome\//.test(normalizedUserAgent) || !/\bChrome\/\d/.test(normalizedUserAgent)) {
        throw new Error('Installed Chrome did not expose a recognizable user agent');
      }
      return normalizedUserAgent;
    } finally {
      await closeBrowser();
    }
  })();

  try {
    return await Promise.race([
      probe,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          deadlineExpired = true;
          void closeBrowser();
          reject(timeoutError());
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (deadlineExpired) throw timeoutError();
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createCachedNormalChromeUserAgent(
  derive: () => Promise<string>,
): () => Promise<string> {
  let cachedUserAgent: string | undefined;
  let inFlight: Promise<string> | undefined;
  return () => {
    if (cachedUserAgent !== undefined) return Promise.resolve(cachedUserAgent);
    inFlight ??= (async () => {
      try {
        const userAgent = await derive();
        cachedUserAgent = userAgent;
        return userAgent;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };
}

const normalChromeUserAgent = createCachedNormalChromeUserAgent(deriveNormalChromeUserAgent);

export async function institutionBrowserContextOptions(
  contextOptions: PersistentContextOptions,
  resolveNormalChromeUserAgent: () => Promise<string> = normalChromeUserAgent,
): Promise<PersistentContextOptions> {
  if (contextOptions.headless !== true) return contextOptions;
  return {
    ...contextOptions,
    userAgent: await resolveNormalChromeUserAgent(),
  };
}

async function settleBeforeBrowserDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function institutionStartPage(
  context: Pick<BrowserContext, 'newPage' | 'pages'>,
  forceFreshPage = false,
  timeoutMs = defaultBrowserLaunchTimeoutMs,
  closeTimeoutMs = restoredPageCloseTimeoutMs,
): Promise<Page> {
  const existingPages = context.pages().filter(page => !page.isClosed());
  if (!forceFreshPage) {
    return existingPages[0] ?? settleBeforeBrowserDeadline(
      context.newPage(),
      timeoutMs,
      'Timed out opening an institution browser page',
    );
  }

  const freshPage = await settleBeforeBrowserDeadline(
    context.newPage(),
    timeoutMs,
    'Timed out opening a fresh institution browser page',
  );
  try {
    await settleBeforeBrowserDeadline(
      Promise.allSettled(existingPages.map(page => page.close())),
      closeTimeoutMs,
      'Timed out closing restored institution browser pages',
    );
  } catch {
    console.warn('Timed out closing a restored institution browser page; continuing in the fresh page.');
  }
  return freshPage;
}

export function institutionBrowserLaunchStrategy(options: {
  hasSavedAuthentication: boolean;
  persistAuthentication?: boolean;
  requestedHeadless?: boolean;
}): InstitutionBrowserLaunchStrategy {
  if (options.requestedHeadless !== undefined) {
    return {
      initialHeadless: options.requestedHeadless,
      allowHeadedAuthenticationFallback: false,
    };
  }

  const initialHeadless = (options.persistAuthentication ?? true) &&
    options.hasSavedAuthentication;
  return {
    initialHeadless,
    allowHeadedAuthenticationFallback: initialHeadless,
  };
}

function isLockedProfileError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error);
  return /SingletonLock|profile.*(?:in use|locked)|user data directory.*in use|ProcessSingleton/i.test(message);
}

export async function withPlaywrightPage<T>(
  options: SessionOptions,
  operation: (page: Page, context: BrowserContext) => Promise<T>,
): Promise<T> {
  const profilePath = resolve(options.profilePath ?? playwrightProfilePath(options.name));
  const authenticationProfilePath = resolve(options.authenticationProfilePath ?? profilePath);
  const interactiveLeaseProfilePath = resolve(options.interactiveLeaseProfilePath ?? profilePath);
  await mkdir(profilePath, { recursive: true });

  if (options.contextOptions?.headless !== true) {
    return withInteractiveBrowserLease({
      profilePath: interactiveLeaseProfilePath,
      sessionName: options.name,
      onWait: options.onInteractiveBrowserWait,
    }, () => launchPlaywrightPage({ ...options, profilePath, authenticationProfilePath }, operation));
  }

  return launchPlaywrightPage({ ...options, profilePath, authenticationProfilePath }, operation);
}

export async function launchPersistentContextWithDeadline(
  launch: () => Promise<BrowserContext>,
  options: {
    sessionName: string;
    timeoutMs?: number;
    closeLateContext?: (context: BrowserContext) => Promise<unknown>;
  },
): Promise<BrowserContext> {
  const timeoutMs = options.timeoutMs ?? defaultBrowserLaunchTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Browser launch timeout must be a positive number');
  }

  const launchPromise = Promise.resolve().then(launch);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let deadlineExpired = false;
  const timeoutError = () => new Error(`Timed out opening the ${options.sessionName} browser`);

  try {
    return await Promise.race([
      launchPromise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          deadlineExpired = true;
          reject(timeoutError());
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (deadlineExpired) {
      const closeLateContext = options.closeLateContext ?? (async context => {
        await closeBrowserContext(context);
      });
      void launchPromise.then(closeLateContext).catch(() => {});
      throw timeoutError();
    }
    if (error instanceof Error && error.name === 'TimeoutError') throw timeoutError();
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function launchPlaywrightPage<T>(
  options: SessionOptions & { profilePath: string; authenticationProfilePath: string },
  operation: (page: Page, context: BrowserContext) => Promise<T>,
): Promise<T> {
  const profilePath = options.profilePath;
  const authenticationProfilePath = options.authenticationProfilePath;
  const persistAuthentication = options.persistAuthentication ?? true;
  const browserLaunchTimeoutMs = options.browserLaunchTimeoutMs ?? defaultBrowserLaunchTimeoutMs;
  const contextOptions = await institutionBrowserContextOptions(options.contextOptions ?? {});

  const hasSavedAuthentication = persistAuthentication &&
    await fileExists(playwrightAuthStatePath(authenticationProfilePath));

  let context: BrowserContext;
  try {
    context = await launchPersistentContextWithDeadline(
      () => chromium.launchPersistentContext(profilePath, {
        channel: 'chrome',
        headless: contextOptions.headless ?? false,
        acceptDownloads: true,
        chromiumSandbox: true,
        ...contextOptions,
        timeout: browserLaunchTimeoutMs,
        args: institutionBrowserLaunchArguments(contextOptions.args, options.launchArgs),
      }),
      {
        sessionName: options.name,
        timeoutMs: browserLaunchTimeoutMs + browserLaunchWatchdogGraceMs,
      },
    );
  } catch (error) {
    if (isLockedProfileError(error)) {
      throw new Error(`The ${options.name} browser profile is already open. Close that browser window, then rerun.`);
    }
    throw error;
  }

  try {
    return await runWhilePersistentBrowserOpen(
      context,
      profilePath,
      async () => {
    if (hasSavedAuthentication) await restoreBrowserAuthentication(context, authenticationProfilePath);
    const page = await institutionStartPage(context, options.forceStartUrl, browserLaunchTimeoutMs);
    if (options.beforeStartNavigation) {
      await settleBeforeBrowserDeadline(
        Promise.resolve(options.beforeStartNavigation(page, context)),
        browserLaunchTimeoutMs,
        `Timed out preparing the ${options.name} browser page`,
      );
    }
    await openInstitutionStartPage(page, options.startUrl, hasSavedAuthentication, options.forceStartUrl);
        return operation(page, context);
      },
    );
  } finally {
    const closed = await closeBrowserContext(context);
    if (!closed) console.warn(`Timed out closing the ${options.name} browser context after Chrome exited.`);
  }
}

type SessionStorageByOrigin = Record<string, Record<string, string>>;

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(entry => typeof entry === 'string');
}

function isSessionStorageByOrigin(value: unknown): value is SessionStorageByOrigin {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([origin, entries]) =>
    /^https?:\/\//.test(origin) && isStringRecord(entries)
  );
}

async function savedSessionStorage(profilePath: string): Promise<SessionStorageByOrigin> {
  try {
    const value = JSON.parse(await readFile(playwrightSessionStoragePath(profilePath), 'utf8')) as unknown;
    return isSessionStorageByOrigin(value) ? value : {};
  } catch {
    return {};
  }
}

export async function restoreBrowserAuthentication(
  context: Pick<BrowserContext, 'addInitScript' | 'setStorageState'>,
  profilePath: string,
): Promise<void> {
  await context.setStorageState(playwrightAuthStatePath(profilePath));
  const storageByOrigin = await savedSessionStorage(profilePath);
  if (Object.keys(storageByOrigin).length === 0) return;
  await context.addInitScript((saved: SessionStorageByOrigin) => {
    const entries = saved[location.origin];
    if (!entries) return;
    for (const [key, value] of Object.entries(entries)) sessionStorage.setItem(key, value);
  }, storageByOrigin);
}

async function captureSessionStorage(
  context: Pick<BrowserContext, 'pages'>,
): Promise<SessionStorageByOrigin | null> {
  const pages = context.pages();
  const snapshots = await Promise.all(pages.map(async page => {
    if (page.isClosed()) return null;
    try {
      return await page.evaluate(() => ({
        origin: location.origin,
        entries: Object.fromEntries(Object.entries(sessionStorage)),
      }));
    } catch {
      return null;
    }
  }));
  const valid = snapshots.filter((snapshot): snapshot is { origin: string; entries: Record<string, string> } =>
    Boolean(snapshot && /^https?:\/\//.test(snapshot.origin) && isStringRecord(snapshot.entries))
  );
  if (valid.length === 0) return null;
  return Object.fromEntries(valid.map(snapshot => [snapshot.origin, snapshot.entries]));
}

async function replacePrivateJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.partial`);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporaryPath, JSON.stringify(value), { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      const code = fileSystemErrorCode(error);
      if (process.platform !== 'win32' || (code !== 'EEXIST' && code !== 'EPERM')) throw error;
      await rm(path, { force: true });
      await rename(temporaryPath, path);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function persistBrowserAuthentication(
  context: Pick<BrowserContext, 'pages' | 'storageState'>,
  authStatePath: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      Promise.resolve()
        .then(async () => {
          const authenticationState = await context.storageState({ indexedDB: true });
          const sessionStorage = await captureSessionStorage(context);
          return { authenticationState, sessionStorage };
        }),
      new Promise<null>(resolveTimeout => {
        timeout = setTimeout(() => resolveTimeout(null), timeoutMs);
      }),
    ]);
    if (!snapshot) return false;
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }

    await replacePrivateJson(authStatePath, snapshot.authenticationState);
    const sessionStoragePath = playwrightSessionStoragePath(dirname(authStatePath));
    try {
      if (snapshot.sessionStorage) {
        await replacePrivateJson(sessionStoragePath, snapshot.sessionStorage);
      } else {
        await rm(sessionStoragePath, { force: true });
      }
    } catch (error) {
      await rm(authStatePath, { force: true });
      throw error;
    }
    return true;
  } catch (error) {
    if (!isClosedContextError(error)) {
      console.warn('Browser authentication state could not be saved.');
    }
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function checkAuthenticationForCheckpoint(
  page: Page,
  isAuthenticated: (page: Page) => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<boolean> {
  if (page.isClosed()) return false;
  let context: BrowserContext;
  try {
    context = page.context();
  } catch {
    return false;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed: ((authenticated: false) => void) | undefined;
  const handleClose = () => resolveClosed?.(false);
  const closed = new Promise<false>(resolve => {
    resolveClosed = resolve;
    page.on('close', handleClose);
    context.on('close', handleClose);
  });

  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => isAuthenticated(page))
        .then(Boolean)
        .catch(() => false),
      closed,
      new Promise<false>(resolveTimeout => {
        timeout = setTimeout(() => resolveTimeout(false), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    resolveClosed = undefined;
    page.off('close', handleClose);
    context.off('close', handleClose);
    if (timeout) clearTimeout(timeout);
  }
}

export async function closeBrowserContext(
  context: Pick<BrowserContext, 'close'>,
  timeoutMs = 5_000,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      context.close().then(() => true),
      new Promise<false>(resolveTimeout => {
        timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function runWhileBrowserOpen<T>(
  context: Pick<BrowserContext, 'browser' | 'once' | 'off'>,
  operation: () => Promise<T>,
  options: {
    isBrowserProcessAlive?: () => boolean | Promise<boolean>;
    processPollIntervalMs?: number;
  } = {},
): Promise<T> {
  const browser: Pick<Browser, 'isConnected' | 'once' | 'off'> | null =
    typeof (context as Partial<BrowserContext>).browser === 'function'
      ? context.browser()
      : null;
  let rejectClosed: ((error: Error) => void) | undefined;
  const handleClose = () => rejectClosed?.(
    new Error('Browser closed before the institution sync completed'),
  );
  const browserClosed = new Promise<never>((_resolve, reject) => {
    rejectClosed = reject;
    context.once('close', handleClose);
    browser?.once('disconnected', handleClose);
  });
  let processPoll: ReturnType<typeof setTimeout> | undefined;
  let stopProcessPolling = false;
  const isBrowserProcessAlive = options.isBrowserProcessAlive;
  const browserProcessClosed = isBrowserProcessAlive
    ? new Promise<never>((_resolve, reject) => {
        const poll = async () => {
          if (stopProcessPolling) return;
          let alive = false;
          try {
            alive = await isBrowserProcessAlive();
          } catch {
            alive = false;
          }
          if (stopProcessPolling) return;
          if (!alive) {
            reject(new Error('Browser closed before the institution sync completed'));
            return;
          }
          processPoll = setTimeout(poll, options.processPollIntervalMs ?? 250);
        };
        void poll();
      })
    : null;

  try {
    if (browser && !browser.isConnected()) handleClose();
    return await Promise.race([
      Promise.resolve().then(operation),
      browserClosed,
      ...(browserProcessClosed ? [browserProcessClosed] : []),
    ]);
  } finally {
    stopProcessPolling = true;
    if (processPoll) clearTimeout(processPoll);
    rejectClosed = undefined;
    context.off('close', handleClose);
    browser?.off('disconnected', handleClose);
  }
}

export type ChromeBrowserProfileOwner =
  | { kind: 'process'; lockTarget: string; pid: number }
  | { kind: 'windows-lock' };

type ChromeBrowserProfileOwnerOptions = {
  platform?: NodeJS.Platform;
  windowsLockIsHeld?: (lockPath: string) => boolean | Promise<boolean>;
};

async function windowsChromeProfileLockIsHeld(lockPath: string): Promise<boolean> {
  try {
    const handle = await open(lockPath, 'r+');
    await handle.close();
    return false;
  } catch (error) {
    return fileSystemErrorCode(error) !== 'ENOENT';
  }
}

export async function chromeBrowserProfileOwner(
  profilePath: string,
  options: ChromeBrowserProfileOwnerOptions = {},
): Promise<ChromeBrowserProfileOwner | null> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    const lockPath = join(resolve(profilePath), 'lockfile');
    const lockIsHeld = options.windowsLockIsHeld ?? windowsChromeProfileLockIsHeld;
    return await lockIsHeld(lockPath) ? { kind: 'windows-lock' } : null;
  }
  try {
    const lockTarget = await readlink(join(resolve(profilePath), 'SingletonLock'));
    const pidText = /-(\d+)$/.exec(lockTarget)?.[1];
    if (!pidText) return null;
    const pid = Number(pidText);
    return Number.isSafeInteger(pid) && pid > 0
      ? { kind: 'process', lockTarget, pid }
      : null;
  } catch {
    return null;
  }
}

async function chromeBrowserProfileOwnerIsAlive(
  profilePath: string,
  owner: ChromeBrowserProfileOwner,
): Promise<boolean> {
  if (owner.kind === 'windows-lock') {
    return windowsChromeProfileLockIsHeld(join(resolve(profilePath), 'lockfile'));
  }
  try {
    const lockTarget = await readlink(join(resolve(profilePath), 'SingletonLock'));
    return lockTarget === owner.lockTarget && systemProcessIsAlive(owner.pid);
  } catch {
    return false;
  }
}

export async function runWhilePersistentBrowserOpen<T>(
  context: Pick<BrowserContext, 'browser' | 'once' | 'off'>,
  profilePath: string,
  operation: () => Promise<T>,
  options: {
    processPollIntervalMs?: number;
    readBrowserProfileOwner?: (profilePath: string) => Promise<ChromeBrowserProfileOwner | null>;
    browserProfileOwnerIsAlive?: (
      profilePath: string,
      owner: ChromeBrowserProfileOwner,
    ) => boolean | Promise<boolean>;
  } = {},
): Promise<T> {
  const readBrowserProfileOwner = options.readBrowserProfileOwner ?? chromeBrowserProfileOwner;
  const owner = await readBrowserProfileOwner(profilePath);
  if (!owner) throw new Error('Browser closed before the institution sync completed');
  const browserProfileOwnerIsAlive = options.browserProfileOwnerIsAlive ?? chromeBrowserProfileOwnerIsAlive;
  return runWhileBrowserOpen(context, operation, {
    isBrowserProcessAlive: () => browserProfileOwnerIsAlive(profilePath, owner),
    processPollIntervalMs: options.processPollIntervalMs,
  });
}

export function decodeInstitutionBrowserProgramResult<T extends Record<string, unknown>>(
  value: unknown,
): InstitutionBrowserProgramResult<T> {
  let decoded = value;
  for (let depth = 0; depth < 2 && typeof decoded === 'string'; depth += 1) {
    decoded = JSON.parse(decoded) as unknown;
  }
  if (!decoded || typeof decoded !== 'object' || !('status' in decoded)) {
    throw new Error('Institution browser program returned an invalid result');
  }
  const status = (decoded as { status?: unknown }).status;
  if (status !== 'complete' && status !== 'login-required' && status !== 'error') {
    throw new Error(`Institution browser program returned an unknown status: ${String(status)}`);
  }
  return decoded as InstitutionBrowserProgramResult<T>;
}

const authenticationFieldSelector = [
  'input[type="password"]',
  'input[autocomplete="username"]',
  'input[autocomplete="current-password"]',
].join(',');

async function hasDefaultAuthentication(page: Page): Promise<boolean> {
  return !/(?:login|logon|sign[-_]?in|authenticate|authorization|oauth|sso|auth\.)/i.test(page.url()) &&
    await page.locator(authenticationFieldSelector).count() === 0;
}

async function waitUntilDefaultAuthentication(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction((selector: string) => {
    const loginLikeUrl = /(?:login|logon|sign[-_]?in|authenticate|authorization|oauth|sso|auth\.)/i.test(location.href);
    const hasVisibleAuthenticationField = Array.from(document.querySelectorAll(selector)).some(element => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    });
    return !loginLikeUrl && !hasVisibleAuthenticationField;
  }, authenticationFieldSelector, { timeout: timeoutMs });
}

export async function waitForInteractiveAuthentication(
  page: Page,
  deadline: number,
  options: Pick<
    RunOptions,
    'authenticationRecoveryUrl' | 'isAuthenticated' | 'onProgress' | 'waitUntilAuthenticated'
  > = {},
  context?: Pick<BrowserContext, 'newPage' | 'pages' | 'on' | 'off'>,
): Promise<Page> {
  const isAuthenticated = options.isAuthenticated ?? hasDefaultAuthentication;
  const waitUntilAuthenticated = options.waitUntilAuthenticated ?? waitUntilDefaultAuthentication;

  const browserContext = context ?? (
    typeof (page as Partial<Page>).context === 'function'
      ? page.context()
      : undefined
  );
  if (!browserContext) {
    if (page.isClosed()) throw new Error('The browser was closed before authentication completed');
    if (await isAuthenticated(page)) return page;

    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new Error('Authentication timed out');

    try {
      await waitUntilAuthenticated(page, timeoutMs);
    } catch (error) {
      if (isClosedContextError(error)) throw new Error('The browser was closed before authentication completed');
      if (error instanceof Error && error.name === 'TimeoutError') throw new Error('Authentication timed out');
      throw error;
    }

    if (page.isClosed()) throw new Error('The browser was closed before authentication completed');
    if (!await isAuthenticated(page)) {
      throw new Error('Authentication state changed without completing sign-in');
    }
    return page;
  }

  let rejectContextClosed: ((error: Error) => void) | undefined;
  const handleContextClose = () => rejectContextClosed?.(
    new Error('The browser was closed before authentication completed'),
  );
  const contextClosed = new Promise<never>((_resolve, reject) => {
    rejectContextClosed = reject;
    browserContext.on('close', handleContextClose);
  });

  let activePage: Page | null = newestOpenPage(browserContext, page);
  let recoveredClosedAuthenticationPage = false;
  try {
    while (true) {
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) throw new Error('Authentication timed out');

      if (!activePage) {
        if (options.authenticationRecoveryUrl &&
            !recoveredClosedAuthenticationPage &&
            typeof browserContext.newPage === 'function') {
          recoveredClosedAuthenticationPage = true;
          options.onProgress?.('Authentication window closed. Reopening it.');
          let recoveryTimeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const recoveryPage = await Promise.race([
              Promise.resolve()
                .then(() => browserContext.newPage())
                .then(async nextPage => {
                  await nextPage.goto(options.authenticationRecoveryUrl!, {
                    waitUntil: 'domcontentloaded',
                  });
                  return nextPage;
                }),
              contextClosed,
              new Promise<never>((_resolve, reject) => {
                recoveryTimeout = setTimeout(
                  () => reject(new Error('Browser stopped responding while reopening authentication')),
                  Math.min(5_000, Math.max(1, timeoutMs)),
                );
              }),
            ]);
            activePage = newestOpenPage(browserContext, recoveryPage);
          } catch (error) {
            if (isClosedContextError(error)) {
              throw new Error('The browser was closed before authentication completed');
            }
            throw error;
          } finally {
            if (recoveryTimeout) clearTimeout(recoveryTimeout);
          }
          continue;
        }
        if (recoveredClosedAuthenticationPage) {
          throw new Error('The authentication window closed before sign-in completed');
        }
        const observer = observeAuthenticationPageChange(browserContext, undefined, timeoutMs);
        try {
          const outcome = await Promise.race([observer.promise, contextClosed]);
          if (outcome.type === 'timeout') throw new Error('Authentication timed out');
          activePage = newestOpenPage(
            browserContext,
            outcome.type === 'page' ? outcome.page : undefined,
          );
        } finally {
          observer.dispose();
        }
        continue;
      }

      if (activePage.isClosed()) {
        activePage = newestOpenPage(browserContext);
        continue;
      }
      if (await Promise.race([
        Promise.resolve().then(() => isAuthenticated(activePage!)),
        contextClosed,
      ])) return activePage;

      const pageAtWaitStart = activePage;
      const observer = observeAuthenticationPageChange(browserContext, pageAtWaitStart, timeoutMs);
      const newestAfterObserving = newestOpenPage(browserContext, pageAtWaitStart);
      if (newestAfterObserving && newestAfterObserving !== pageAtWaitStart) {
        observer.dispose();
        activePage = newestAfterObserving;
        continue;
      }
      if (pageAtWaitStart.isClosed()) {
        observer.dispose();
        activePage = newestOpenPage(browserContext);
        continue;
      }

      let outcome: AuthenticationWaitOutcome;
      try {
        outcome = await Promise.race([
          Promise.resolve()
            .then(() => waitUntilAuthenticated(pageAtWaitStart, timeoutMs))
            .then((): AuthenticationWaitOutcome => ({ type: 'authentication-changed' }))
            .catch((error): AuthenticationWaitOutcome => ({ type: 'wait-error', error })),
          observer.promise,
          contextClosed,
        ]);
      } finally {
        observer.dispose();
      }

      if (outcome.type === 'timeout') throw new Error('Authentication timed out');
      if (outcome.type === 'page' || outcome.type === 'page-closed') {
        activePage = newestOpenPage(
          browserContext,
          outcome.type === 'page' ? outcome.page : undefined,
        );
        continue;
      }

      const newestPage = newestOpenPage(browserContext, pageAtWaitStart);
      if (newestPage && newestPage !== pageAtWaitStart) {
        activePage = newestPage;
        continue;
      }
      if (outcome.type === 'wait-error') {
        if (pageAtWaitStart.isClosed() || isClosedContextError(outcome.error)) {
          activePage = newestOpenPage(browserContext);
          continue;
        }
        if (outcome.error instanceof Error && outcome.error.name === 'TimeoutError') {
          throw new Error('Authentication timed out');
        }
        throw outcome.error;
      }

      if (pageAtWaitStart.isClosed()) {
        activePage = newestOpenPage(browserContext);
        continue;
      }
      if (!await Promise.race([
        Promise.resolve().then(() => isAuthenticated(pageAtWaitStart)),
        contextClosed,
      ])) {
        throw new Error('Authentication state changed without completing sign-in');
      }
      return pageAtWaitStart;
    }
  } finally {
    rejectContextClosed = undefined;
    browserContext.off('close', handleContextClose);
  }
}

type AuthenticationWaitOutcome =
  | { type: 'authentication-changed' }
  | { type: 'wait-error'; error: unknown }
  | { type: 'page'; page: Page }
  | { type: 'page-closed' }
  | { type: 'timeout' };

function newestOpenPage(
  context: Pick<BrowserContext, 'pages'>,
  preferred?: Page,
): Page | null {
  const pages = context.pages().filter(candidate => !candidate.isClosed());
  return pages.at(-1) ?? (preferred && !preferred.isClosed() ? preferred : null);
}

function observeAuthenticationPageChange(
  context: Pick<BrowserContext, 'on' | 'off'>,
  page: Page | undefined,
  timeoutMs: number,
): { promise: Promise<AuthenticationWaitOutcome>; dispose: () => void } {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveOutcome: ((outcome: AuthenticationWaitOutcome) => void) | undefined;
  const promise = new Promise<AuthenticationWaitOutcome>(resolve => {
    resolveOutcome = resolve;
  });
  const finish = (outcome: AuthenticationWaitOutcome) => resolveOutcome?.(outcome);
  const handlePage = (nextPage: Page) => finish({ type: 'page', page: nextPage });
  const handlePageClose = () => finish({ type: 'page-closed' });

  context.on('page', handlePage);
  page?.on('close', handlePageClose);
  timeout = setTimeout(() => finish({ type: 'timeout' }), timeoutMs);

  return {
    promise,
    dispose: () => {
      resolveOutcome = undefined;
      context.off('page', handlePage);
      page?.off('close', handlePageClose);
      if (timeout) clearTimeout(timeout);
    },
  };
}

function isClosedContextError(error: unknown): boolean {
  return /Target page, context or browser has been closed/i.test(String(error instanceof Error ? error.message : error));
}

class ResumeHeadlesslyAfterAuthentication extends Error {}

export async function showSyncCompletionChapter(
  page: Page,
  options: Pick<RunOptions, 'completionDescription' | 'completionDurationMs'>,
): Promise<void> {
  await page.screencast.showChapter('Done', {
    description: options.completionDescription,
    duration: options.completionDurationMs ?? 2_000,
  });
}

export async function showAuthenticationChapter(page: Page, action: string): Promise<void> {
  await page.bringToFront();
  await page.screencast.showChapter('Sign in required', {
    description: action,
    duration: 2_000,
  });
  await page.waitForTimeout(2_000);
  await page.screencast.hideOverlays();
}

type InstitutionBrowserProgramDependencies = {
  withPlaywrightPage: typeof withPlaywrightPage;
  withTransientBrowserProfile: typeof withTransientBrowserProfile;
};

export async function runInstitutionBrowserProgram<T extends Record<string, unknown>>(
  session: SessionOptions,
  code: string,
  options: RunOptions,
  dependencyOverrides: Partial<InstitutionBrowserProgramDependencies> = {},
): Promise<InstitutionBrowserProgramResult<T>> {
  // Browser programs are repository-owned strings retained from the former CLI runner.
  const program = Function(`"use strict"; return (${code});`)() as (
    browserPage: Page,
    reportProgress: (message: string) => void,
    bindings: Record<string, unknown>,
  ) => Promise<unknown>;
  const runWithPlaywrightPage = dependencyOverrides.withPlaywrightPage ?? withPlaywrightPage;
  const runWithTransientBrowserProfile = dependencyOverrides.withTransientBrowserProfile ??
    withTransientBrowserProfile;
  const reportProgress = options.onProgress ?? (() => {});
  const canonicalProfilePath = resolve(session.profilePath ?? playwrightProfilePath(session.name));
  const hasSavedAuthentication = (session.persistAuthentication ?? true)
    ? await playwrightHasSavedAuthentication(session.name, canonicalProfilePath)
    : false;
  const launchStrategy = institutionBrowserLaunchStrategy({
    hasSavedAuthentication,
    persistAuthentication: session.persistAuthentication,
    requestedHeadless: session.contextOptions?.headless,
  });
  const resumeHeadlesslyAfterAuthentication = session.contextOptions?.headless === undefined;

  const runAttempt = async (
    headless: boolean,
    allowInteractiveAuthentication: boolean,
    browserProfilePath = canonicalProfilePath,
    forceStartUrl = false,
  ) => runWithPlaywrightPage({
    ...session,
    profilePath: browserProfilePath,
    authenticationProfilePath: canonicalProfilePath,
    interactiveLeaseProfilePath: canonicalProfilePath,
    forceStartUrl,
    onInteractiveBrowserWait: reportProgress,
    contextOptions: {
      ...session.contextOptions,
      headless,
    },
  }, async (page, context) => {
    const interactiveAuthenticationEnabled = allowInteractiveAuthentication &&
      (options.allowInteractiveAuthentication ?? true);
    let activePage = page;
    const deadline = Date.now() + (options.authenticationTimeoutMs ?? 10 * 60_000);
    const isAuthenticated = options.isAuthenticated ?? hasDefaultAuthentication;
    const checkpointAuthentication = async (): Promise<boolean> => {
      if (!(session.persistAuthentication ?? true)) return false;
      const authenticated = await checkAuthenticationForCheckpoint(
        activePage,
        isAuthenticated,
        options.authenticationCheckpointTimeoutMs,
      );
      if (!authenticated) return false;
      const persisted = await persistBrowserAuthentication(
        context,
        playwrightAuthStatePath(canonicalProfilePath),
      );
      if (!persisted) console.warn(`Could not checkpoint authentication for ${session.name}.`);
      return persisted;
    };
    let result = decodeInstitutionBrowserProgramResult<T>(await program(
      activePage,
      reportProgress,
      options.programBindings ?? {},
    ));
    if (result.status === 'login-required' && interactiveAuthenticationEnabled) {
      await showAuthenticationChapter(
        activePage,
        result.action ?? `Complete login and MFA for ${session.name}. EasyMoney will continue automatically.`,
      );
      console.log(`Authentication required in ${session.name}. Complete login and MFA in the open browser.`);
    }
    while (interactiveAuthenticationEnabled && result.status === 'login-required' && Date.now() < deadline) {
      activePage = await waitForInteractiveAuthentication(activePage, deadline, {
        ...options,
        authenticationRecoveryUrl: options.authenticationRecoveryUrl ?? session.startUrl,
      }, context);
      const checkpointed = await checkpointAuthentication();
      reportProgress('Authentication complete. Continuing downloads.');
      if (checkpointed && resumeHeadlesslyAfterAuthentication) {
        throw new ResumeHeadlesslyAfterAuthentication();
      }
      result = decodeInstitutionBrowserProgramResult<T>(await program(
        activePage,
        reportProgress,
        options.programBindings ?? {},
      ));
    }
    if (interactiveAuthenticationEnabled && result.status === 'login-required') {
      throw new Error(`Authentication timed out in ${session.name}`);
    }
    if (result.status !== 'login-required') await checkpointAuthentication();
    if (result.status === 'complete') await showSyncCompletionChapter(activePage, options);
    return result;
  });

  if (session.persistAuthentication === false) {
    return runWithTransientBrowserProfile(profilePath => runAttempt(
      launchStrategy.initialHeadless,
      !launchStrategy.initialHeadless,
      profilePath,
    ));
  }

  const runInteractiveAttemptWithResume = async (
    operation: () => Promise<InstitutionBrowserProgramResult<T>>,
  ): Promise<InstitutionBrowserProgramResult<T>> => {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof ResumeHeadlesslyAfterAuthentication)) throw error;
      console.log(`Authentication for ${session.name} was saved. Resuming headlessly.`);
      const resumed = await runWithTransientBrowserProfile(profilePath => runAttempt(
        true,
        false,
        profilePath,
      ));
      if (resumed.status === 'login-required') {
        throw new Error(`Saved authentication for ${session.name} could not be restored headlessly`);
      }
      return resumed;
    }
  };

  const initialResult = launchStrategy.allowHeadedAuthenticationFallback
    ? await runWithTransientBrowserProfile(profilePath => runAttempt(true, false, profilePath))
    : launchStrategy.initialHeadless
      ? await runAttempt(true, false)
      : await runInteractiveAttemptWithResume(() => runAttempt(false, true));
  if (
    initialResult.status !== 'login-required' ||
    !launchStrategy.allowHeadedAuthenticationFallback ||
    options.allowInteractiveAuthentication === false
  ) {
    return initialResult;
  }

  console.log(`Saved authentication for ${session.name} needs attention. Opening the browser for login or MFA.`);
  return runInteractiveAttemptWithResume(() => runAttempt(false, true, canonicalProfilePath, true));
}
