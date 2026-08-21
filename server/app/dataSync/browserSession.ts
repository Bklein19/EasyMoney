import { chmod, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, resolve, win32 } from 'node:path';

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
  contextOptions?: NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;
  launchArgs?: string[];
};

type RunOptions = {
  authenticationTimeoutMs?: number;
  isAuthenticated?: (page: Page) => boolean | Promise<boolean>;
  waitUntilAuthenticated?: (page: Page, timeoutMs: number) => Promise<void>;
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

  const initialHeadless = (options.persistAuthentication ?? true) && options.hasSavedAuthentication;
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
  const authStatePath = playwrightAuthStatePath(profilePath);
  const persistAuthentication = options.persistAuthentication ?? true;
  await mkdir(profilePath, { recursive: true });

  const savedStorageState = persistAuthentication && await fileExists(authStatePath)
    ? authStatePath
    : undefined;

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chrome',
      headless: false,
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
    if (page.url() === 'about:blank') await page.goto(options.startUrl, { waitUntil: 'domcontentloaded' });
    return await operation(page, context);
  } finally {
    try {
      if (persistAuthentication) {
        try {
          await context.storageState({ path: authStatePath, indexedDB: true });
          if (process.platform !== 'win32') await chmod(authStatePath, 0o600);
        } catch (error) {
          if (!isClosedContextError(error)) throw error;
        }
      }
    } finally {
      await context.close();
    }
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
  const program = Function(`"use strict"; return (${code});`)() as (browserPage: Page) => Promise<unknown>;
  const hasSavedAuthentication = (session.persistAuthentication ?? true)
    ? await playwrightHasSavedAuthentication(session.name, session.profilePath)
    : false;
  const launchStrategy = institutionBrowserLaunchStrategy({
    hasSavedAuthentication,
    persistAuthentication: session.persistAuthentication,
    requestedHeadless: session.contextOptions?.headless,
  });

  const runAttempt = async (headless: boolean, allowInteractiveAuthentication: boolean) => withPlaywrightPage({
    ...session,
    contextOptions: {
      ...session.contextOptions,
      headless,
    },
  }, async page => {
    const deadline = Date.now() + (options.authenticationTimeoutMs ?? 10 * 60_000);
    let result = decodeInstitutionBrowserProgramResult<T>(await program(page));
    if (result.status === 'login-required' && allowInteractiveAuthentication) {
      await showAuthenticationChapter(
        page,
        result.action ?? `Complete login and MFA for ${session.name}. EasyMoney will continue automatically.`,
      );
      console.log(`Authentication required in ${session.name}. Complete login and MFA in the open browser.`);
    }
    while (allowInteractiveAuthentication && result.status === 'login-required' && Date.now() < deadline) {
      await waitForInteractiveAuthentication(page, deadline, options);
      result = decodeInstitutionBrowserProgramResult<T>(await program(page));
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
