import { chmod, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, resolve, win32 } from 'node:path';

import { chromium, type BrowserContext, type Page } from 'playwright';

export const PLAYWRIGHT_VERSION = '1.62.1';

export type PlaywrightProfileState = 'existing' | 'missing';

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
};

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

function authenticationRequired(value: string): boolean {
  return /authentication-required|auth-required|login-required/i.test(value);
}

export async function waitForInteractiveAuthentication(page: Page, deadline: number): Promise<void> {
  let authenticatedSince: number | null = null;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('The browser was closed before authentication completed');
    const authenticationUrl = /(?:login|logon|sign[-_]?in|authenticate|authorization|oauth|sso|auth\.)/i.test(page.url());
    const authenticationFields = await page.locator([
      'input[type="password"]',
      'input[autocomplete="username"]',
      'input[autocomplete="current-password"]',
    ].join(',')).count() > 0;

    if (!authenticationUrl && !authenticationFields) {
      authenticatedSince ??= Date.now();
      if (Date.now() - authenticatedSince >= 1_500) return;
    } else {
      authenticatedSince = null;
    }
    try {
      await page.waitForTimeout(500);
    } catch (error) {
      if (isClosedContextError(error)) throw new Error('The browser was closed before authentication completed');
      throw error;
    }
  }
  throw new Error('Authentication timed out');
}

function isClosedContextError(error: unknown): boolean {
  return /Target page, context or browser has been closed/i.test(String(error instanceof Error ? error.message : error));
}

export async function runPlaywrightCode(
  session: SessionOptions,
  code: string,
  options: RunOptions = {},
): Promise<string> {
  return withPlaywrightPage(session, async page => {
    // Browser programs are repository-owned strings retained from the former CLI runner.
    const program = Function(`"use strict"; return (${code});`)() as (browserPage: Page) => Promise<unknown>;
    const deadline = Date.now() + (options.authenticationTimeoutMs ?? 10 * 60_000);
    let result = String(await program(page));
    if (authenticationRequired(result)) {
      console.log(`Authentication required in ${session.name}. Complete login and MFA in the open browser.`);
    }
    while (authenticationRequired(result) && Date.now() < deadline) {
      await waitForInteractiveAuthentication(page, deadline);
      result = String(await program(page));
    }
    if (authenticationRequired(result)) throw new Error(`Authentication timed out in ${session.name}`);
    return result;
  });
}
