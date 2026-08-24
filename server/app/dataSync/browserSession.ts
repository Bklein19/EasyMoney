import { chmod, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';

import { chromium, type BrowserContext, type Page } from 'playwright';

export const PLAYWRIGHT_VERSION = '1.62.1';

export type PlaywrightProfileState = 'existing' | 'missing';

export type InstitutionBrowserLaunchStrategy = {
  initialHeadless: boolean;
  allowHeadedAuthenticationFallback: boolean;
};

type SessionOptions = {
  name: string;
  startUrl: string;
  profilePath?: string;
  persistAuthentication?: boolean;
  savedAuthenticationMode?: 'headless' | 'headed';
  onInteractiveBrowserWait?: (message: string) => void;
  contextOptions?: NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;
  launchArgs?: string[];
};

type RunOptions = {
  authenticationTimeoutMs?: number;
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

type InteractiveBrowserLeaseOptions = {
  profilePath: string;
  sessionName: string;
  timeoutMs?: number;
  staleAfterMs?: number;
  pollIntervalMs?: number;
  onWait?: (message: string) => void;
};

type InteractiveBrowserLeaseOwner = {
  token: string;
  pid: number;
  sessionName: string;
  startedAt: string;
};

const interactiveBrowserLockName = '.interactive-browser.lock';

function interactiveBrowserLockPath(profilePath: string): string {
  return join(dirname(resolve(profilePath)), interactiveBrowserLockName);
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
      if (Date.now() - lockStat.mtimeMs > staleAfterMs) {
        const cleanupLockPath = `${lockPath}.cleanup`;
        let ownsCleanupLock = false;
        try {
          await mkdir(cleanupLockPath);
          ownsCleanupLock = true;
          const currentLockStat = await stat(lockPath).catch(() => null);
          if (currentLockStat && Date.now() - currentLockStat.mtimeMs > staleAfterMs) {
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
): Promise<void> {
  if (page.url() !== 'about:blank' && !restoredAuthentication) return;
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
}

export function institutionBrowserLaunchStrategy(options: {
  hasSavedAuthentication: boolean;
  persistAuthentication?: boolean;
  requestedHeadless?: boolean;
  savedAuthenticationMode?: 'headless' | 'headed';
}): InstitutionBrowserLaunchStrategy {
  if (options.requestedHeadless !== undefined) {
    return {
      initialHeadless: options.requestedHeadless,
      allowHeadedAuthenticationFallback: false,
    };
  }

  const initialHeadless = (options.persistAuthentication ?? true) &&
    options.hasSavedAuthentication &&
    options.savedAuthenticationMode !== 'headed';
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
  await mkdir(profilePath, { recursive: true });

  if (options.contextOptions?.headless !== true) {
    return withInteractiveBrowserLease({
      profilePath,
      sessionName: options.name,
      onWait: options.onInteractiveBrowserWait,
    }, () => launchPlaywrightPage({ ...options, profilePath }, operation));
  }

  return launchPlaywrightPage({ ...options, profilePath }, operation);
}

async function launchPlaywrightPage<T>(
  options: SessionOptions & { profilePath: string },
  operation: (page: Page, context: BrowserContext) => Promise<T>,
): Promise<T> {
  const profilePath = options.profilePath;
  const authStatePath = playwrightAuthStatePath(profilePath);
  const persistAuthentication = options.persistAuthentication ?? true;

  const savedStorageState = persistAuthentication && await fileExists(authStatePath)
    ? authStatePath
    : undefined;

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chrome',
      headless: options.contextOptions?.headless ?? false,
      acceptDownloads: true,
      chromiumSandbox: true,
      ...options.contextOptions,
      args: [...(options.contextOptions?.args ?? []), ...(options.launchArgs ?? [])],
    });
  } catch (error) {
    if (isLockedProfileError(error)) {
      throw new Error(`The ${options.name} browser profile is already open. Close that browser window, then rerun.`);
    }
    throw error;
  }

  try {
    if (savedStorageState) await context.setStorageState(savedStorageState);
    const page = context.pages()[0] ?? await context.newPage();
    await openInstitutionStartPage(page, options.startUrl, Boolean(savedStorageState));
    return await runWhileBrowserOpen(context, () => operation(page, context));
  } finally {
    try {
      if (persistAuthentication) {
        const persisted = await persistBrowserAuthentication(context, authStatePath);
        if (!persisted) console.warn(`Could not finish saving authentication for ${options.name}.`);
      }
    } finally {
      const closed = await closeBrowserContext(context);
      if (!closed) console.warn(`Timed out closing the ${options.name} browser context after Chrome exited.`);
    }
  }
}

export async function persistBrowserAuthentication(
  context: Pick<BrowserContext, 'storageState'>,
  authStatePath: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const persisted = await Promise.race([
      Promise.resolve()
        .then(() => context.storageState({ path: authStatePath, indexedDB: true }))
        .then(() => true),
      new Promise<false>(resolveTimeout => {
        timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
    if (!persisted) return false;
    if (process.platform !== 'win32') await chmod(authStatePath, 0o600);
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
  context: Pick<BrowserContext, 'once' | 'off'>,
  operation: () => Promise<T>,
): Promise<T> {
  let rejectClosed: ((error: Error) => void) | undefined;
  const handleClose = () => rejectClosed?.(
    new Error('Browser closed before the institution sync completed'),
  );
  const browserClosed = new Promise<never>((_resolve, reject) => {
    rejectClosed = reject;
    context.once('close', handleClose);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      browserClosed,
    ]);
  } finally {
    rejectClosed = undefined;
    context.off('close', handleClose);
  }
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
  options: Pick<RunOptions, 'isAuthenticated' | 'waitUntilAuthenticated'> = {},
): Promise<void> {
  const isAuthenticated = options.isAuthenticated ?? hasDefaultAuthentication;
  const waitUntilAuthenticated = options.waitUntilAuthenticated ?? waitUntilDefaultAuthentication;

  if (page.isClosed()) throw new Error('The browser was closed before authentication completed');
  if (await isAuthenticated(page)) return;

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
}

function isClosedContextError(error: unknown): boolean {
  return /Target page, context or browser has been closed/i.test(String(error instanceof Error ? error.message : error));
}

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
  await page.screencast.showChapter('Sign in required', {
    description: action,
    duration: 2_000,
  });
  await page.waitForTimeout(2_000);
  await page.screencast.hideOverlays();
}

export async function runInstitutionBrowserProgram<T extends Record<string, unknown>>(
  session: SessionOptions,
  code: string,
  options: RunOptions,
): Promise<InstitutionBrowserProgramResult<T>> {
  // Browser programs are repository-owned strings retained from the former CLI runner.
  const program = Function(`"use strict"; return (${code});`)() as (
    browserPage: Page,
    reportProgress: (message: string) => void,
    bindings: Record<string, unknown>,
  ) => Promise<unknown>;
  const reportProgress = options.onProgress ?? (() => {});
  const hasSavedAuthentication = (session.persistAuthentication ?? true)
    ? await playwrightHasSavedAuthentication(session.name, session.profilePath)
    : false;
  const launchStrategy = institutionBrowserLaunchStrategy({
    hasSavedAuthentication,
    persistAuthentication: session.persistAuthentication,
    requestedHeadless: session.contextOptions?.headless,
    savedAuthenticationMode: session.savedAuthenticationMode,
  });

  const runAttempt = async (headless: boolean, allowInteractiveAuthentication: boolean) => withPlaywrightPage({
    ...session,
    onInteractiveBrowserWait: reportProgress,
    contextOptions: {
      ...session.contextOptions,
      headless,
    },
  }, async (page, context) => {
    const deadline = Date.now() + (options.authenticationTimeoutMs ?? 10 * 60_000);
    let result = decodeInstitutionBrowserProgramResult<T>(await program(
      page,
      reportProgress,
      options.programBindings ?? {},
    ));
    if (result.status === 'login-required' && allowInteractiveAuthentication) {
      await showAuthenticationChapter(
        page,
        result.action ?? `Complete login and MFA for ${session.name}. EasyMoney will continue automatically.`,
      );
      console.log(`Authentication required in ${session.name}. Complete login and MFA in the open browser.`);
    }
    while (allowInteractiveAuthentication && result.status === 'login-required' && Date.now() < deadline) {
      await waitForInteractiveAuthentication(page, deadline, options);
      if (session.persistAuthentication ?? true) {
        const profilePath = resolve(session.profilePath ?? playwrightProfilePath(session.name));
        const persisted = await persistBrowserAuthentication(context, playwrightAuthStatePath(profilePath));
        if (!persisted) console.warn(`Could not checkpoint authentication for ${session.name}.`);
      }
      reportProgress('Authentication complete. Continuing downloads.');
      result = decodeInstitutionBrowserProgramResult<T>(await program(
        page,
        reportProgress,
        options.programBindings ?? {},
      ));
    }
    if (allowInteractiveAuthentication && result.status === 'login-required') {
      throw new Error(`Authentication timed out in ${session.name}`);
    }
    if (result.status === 'complete') await showSyncCompletionChapter(page, options);
    return result;
  });

  const initialResult = await runAttempt(
    launchStrategy.initialHeadless,
    !launchStrategy.initialHeadless,
  );
  if (initialResult.status !== 'login-required' || !launchStrategy.allowHeadedAuthenticationFallback) {
    return initialResult;
  }

  console.log(`Saved authentication for ${session.name} needs attention. Opening the browser for login or MFA.`);
  return runAttempt(false, true);
}
