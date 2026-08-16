import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';

export const PLAYWRIGHT_VERSION = '1.62.1';
export const PLAYWRIGHT_CLI = ['bunx', `playwright@${PLAYWRIGHT_VERSION}`, 'cli'] as const;

export type PlaywrightSessionState = 'live' | 'stale' | 'missing';

export type PlaywrightCliResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

type ListedBrowser = {
  name?: string;
  status?: string;
};

type SessionList = {
  browsers?: ListedBrowser[];
  sessions?: ListedBrowser[];
};

type RunOptions = {
  allowFailure?: boolean;
  cwd?: string;
  timeoutMs?: number;
};

type EnsureSessionOptions = {
  name: string;
  startUrl: string;
  cwd?: string;
  openArgs?: string[];
  profilePath?: string;
};

function safeError(value: string): string {
  return value
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\$[\d,]+(?:\.\d{2})?/g, '[amount]')
    .replace(/\b\d{4,}\b/g, '[number]')
    .slice(0, 1_000);
}

export function parsePlaywrightSessionList(value: string): ListedBrowser[] {
  if (!value.trim()) return [];
  const payload = JSON.parse(value) as SessionList | ListedBrowser[];
  if (Array.isArray(payload)) return payload;
  return payload.browsers ?? payload.sessions ?? [];
}

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

export async function executePlaywrightCli(
  args: string[],
  options: RunOptions = {},
): Promise<PlaywrightCliResult> {
  const child = Bun.spawn([...PLAYWRIGHT_CLI, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 120_000);
  const exitCode = await child.exited;
  clearTimeout(timer);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const result = { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  if (!options.allowFailure && exitCode !== 0) {
    throw new Error(safeError(stderr || stdout || `Playwright CLI exited with ${exitCode}`));
  }
  return result;
}

export async function runPlaywrightCli(args: string[], options: RunOptions = {}): Promise<string> {
  return (await executePlaywrightCli(args, options)).stdout;
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(info => info.isDirectory()).catch(() => false);
}

export async function playwrightSessionState(
  name: string,
  options: { cwd?: string; profilePath?: string } = {},
): Promise<PlaywrightSessionState> {
  const listed = parsePlaywrightSessionList(
    await runPlaywrightCli(['list', '--json'], { cwd: options.cwd, timeoutMs: 30_000 }),
  );
  if (listed.some(browser => browser.name === name && browser.status === 'open')) return 'live';
  return await pathExists(options.profilePath ?? playwrightProfilePath(name)) ? 'stale' : 'missing';
}

function isLockedProfileError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error);
  return /SingletonLock|profile.*(?:in use|locked)|user data directory.*in use/i.test(message);
}

export async function ensurePlaywrightSession(options: EnsureSessionOptions): Promise<{
  opened: boolean;
  previousState: PlaywrightSessionState;
  profilePath: string;
}> {
  const profilePath = resolve(options.profilePath ?? playwrightProfilePath(options.name));
  const previousState = await playwrightSessionState(options.name, { cwd: options.cwd, profilePath });
  if (previousState === 'live') return { opened: false, previousState, profilePath };

  await mkdir(dirname(profilePath), { recursive: true });
  try {
    await runPlaywrightCli([
      `-s=${options.name}`,
      'open',
      options.startUrl,
      '--browser=chrome',
      '--headed',
      '--persistent',
      `--profile=${profilePath}`,
      ...(options.openArgs ?? []),
    ], { cwd: options.cwd, timeoutMs: 60_000 });
  } catch (error) {
    if (isLockedProfileError(error)) {
      throw new Error(`The ${options.name} browser profile is open without a live Playwright controller. Close that browser window, then rerun.`);
    }
    throw error;
  }
  return { opened: true, previousState, profilePath };
}

export async function runPlaywrightCode(
  session: string,
  code: string,
  options: RunOptions = {},
): Promise<string> {
  return runPlaywrightCli([`-s=${session}`, '--raw', 'run-code', code], options);
}
