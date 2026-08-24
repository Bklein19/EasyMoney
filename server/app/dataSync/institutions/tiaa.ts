import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { chromium, type Page, type Request, type Response } from 'playwright';

import { parseCsvRows } from '../../importParsers/csvRows.ts';
import parseTiaaActivity, {
  meta as tiaaActivityMeta,
  tiaaActivitySourceAccountName,
} from '../../importParsers/moneyParsers/tiaa-activity-csv.ts';
import parseTiaaStatement, {
  meta as tiaaStatementMeta,
} from '../../importParsers/moneyParsers/tiaa-statement-pdf.ts';
import { runInstitutionBrowserProgram } from '../browserSession.ts';

const TIAA_SESSION = 'tiaa-catchup';
const TIAA_HOME_URL = 'https://my.tiaa.org/private/participant/home';
const TIAA_ACTIVITY_URL = 'https://my.tiaa.org/secure/participantdata/webconnect';
const TIAA_ACTIVITY_OPTIONS_PATH = '/secure/participantdata/api/options';
const TIAA_ACTIVITY_DOWNLOAD_PATH = '/secure/participantdata/api/quickendownload';
const TIAA_STATEMENTS_URL = 'https://my.tiaa.org/secure/account-statements/all';
const TIAA_STATEMENT_METADATA_PATH = '/secure/account-statements/api/type';
const TIAA_STATEMENT_REPORT_PATH = '/private/ahstatementsui/getreport';
const TIAA_AUTHENTICATED_PATH = '^/(?:private/participant|secure/(?:participantdata|account-statements))(?:/|$)';
const TIAA_STATEMENT_ACCOUNT_NAME = 'Retirement Annuity';
const AUTHENTICATION_FIELDS = [
  'input[type="password"]',
  'input[autocomplete="username"]',
  'input[autocomplete="current-password"]',
].join(',');
const VISIBLE_AUTHENTICATION_FIELDS = [
  'input[type="password"]:visible',
  'input[autocomplete="username"]:visible',
  'input[autocomplete="current-password"]:visible',
].join(',');

export type TiaaArtifactType = 'activity' | 'statement';
export type TiaaArtifactKind = 'csv' | 'pdf';
export type TiaaProgressPhase =
  | 'authentication'
  | 'account-discovery'
  | 'activity-downloads'
  | 'statement-discovery'
  | 'statement-downloads'
  | 'validation'
  | 'complete';

export interface TiaaSyncConfig {
  outputDir: string;
  from: string;
  through: string;
  session?: string;
  profilePath?: string;
  headless?: boolean;
  authenticationTimeoutMs?: number;
  artifactTypes?: TiaaArtifactType[];
}

export interface TiaaProgressEvent {
  phase: TiaaProgressPhase;
  state: 'started' | 'progress' | 'completed';
  message: string;
  elapsedMs: number;
  phaseElapsedMs: number;
  data?: Record<string, number | string | boolean>;
}

export interface TiaaRemoteAccountIdentity {
  routingKey: string;
  remoteAccountId: string;
  sourceAccountName: string;
  claimKey: string;
}

export interface TiaaArtifactAccount {
  routingKey: string;
  remoteAccounts: TiaaRemoteAccountIdentity[];
}

export interface TiaaDownloadedArtifact {
  fileName: string;
  path: string;
  kind: TiaaArtifactKind;
  artifactType: TiaaArtifactType;
  parserId: 'tiaa-activity-csv' | 'tiaa-statement-pdf';
  account: TiaaArtifactAccount;
  coveredFrom: string;
  coveredThrough: string;
  size: number;
  transactionCount: number;
  balanceCount: number;
  source: 'downloaded' | 'existing';
}

export interface TiaaSyncResult {
  artifacts: TiaaDownloadedArtifact[];
  accountsDiscovered: number;
  accountSelectionsDiscovered: number;
  activityPeriodsDiscovered: number;
  statementsDiscovered: number;
  emptyActivityExports: number;
  timingsMs: Partial<Record<TiaaProgressPhase, number>>;
}

export interface TiaaActivityPeriod {
  label: string;
  value: string;
  year: number;
  coveredFrom: string;
  coveredThrough: string;
}

type ActivityAccountType = {
  id: string;
  description: string;
  selected: boolean;
  routingKey: string;
};

type ActivityPageMetadata = {
  accountTypes: ActivityAccountType[];
  periods: TiaaActivityPeriod[];
};

type TiaaStatementPeriod = {
  label: string;
  year: number;
  quarter: number;
  coveredFrom: string;
  coveredThrough: string;
};

type StatementDocument = TiaaStatementPeriod & {
  docId: string;
  docLocation: string;
  docTypeId: string;
  categoryId: string;
  productType: string;
  destinationName: string;
  routingKey: string;
};

type BrowserRunResult = {
  artifacts: TiaaDownloadedArtifact[];
  accountsDiscovered: number;
  accountSelectionsDiscovered: number;
  activityPeriodsDiscovered: number;
  statementsDiscovered: number;
  emptyActivityExports: number;
};

type ActivityValidation = {
  size: number;
  remoteAccounts: TiaaRemoteAccountIdentity[];
  coveredFrom: string;
  coveredThrough: string;
  transactionCount: number;
  balanceCount: number;
};

type StatementValidation = {
  size: number;
  remoteAccounts: TiaaRemoteAccountIdentity[];
  coveredFrom: string;
  coveredThrough: string;
  transactionCount: number;
  balanceCount: number;
};

type BrowserFetchResult = {
  status: number;
  contentType: string;
  finalUrl: string;
  body: Buffer;
};

type TiaaAuthenticationEntry = {
  url: string;
  ready: 'activity' | 'statement';
};

class TiaaAuthenticationRequiredError extends Error {
  override name = 'TiaaAuthenticationRequiredError';
}

let normalChromeUserAgentPromise: Promise<string> | null = null;

async function normalChromeUserAgent(): Promise<string> {
  normalChromeUserAgentPromise ??= (async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
    try {
      const version = browser.version();
      if (!/^\d+(?:\.\d+){3}$/.test(version)) throw new Error('Installed Chrome version is unavailable');
      const platform = process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : process.platform === 'win32'
          ? 'Windows NT 10.0; Win64; x64'
          : 'X11; Linux x86_64';
      return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
    } finally {
      await browser.close();
    }
  })();
  return normalChromeUserAgentPromise;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validateConfig(config: TiaaSyncConfig): void {
  if (!isIsoDate(config.from) || !isIsoDate(config.through)) {
    throw new Error('TIAA sync dates must use valid YYYY-MM-DD values');
  }
  if (config.from > config.through) throw new Error('TIAA sync start date must not follow its end date');
  const artifactTypes = config.artifactTypes ?? ['activity', 'statement'];
  if (artifactTypes.length === 0 || artifactTypes.some(value => value !== 'activity' && value !== 'statement')) {
    throw new Error('TIAA sync requires at least one supported artifact type');
  }
}

function dateIntersection(
  leftFrom: string,
  leftThrough: string,
  rightFrom: string,
  rightThrough: string,
): { coveredFrom: string; coveredThrough: string } | null {
  const coveredFrom = leftFrom > rightFrom ? leftFrom : rightFrom;
  const coveredThrough = leftThrough < rightThrough ? leftThrough : rightThrough;
  return coveredFrom <= coveredThrough ? { coveredFrom, coveredThrough } : null;
}

export function tiaaActivityPeriod(
  label: string,
  value: string,
  currentYear = new Date().getFullYear(),
): TiaaActivityPeriod | null {
  const normalized = label.replace(/\s+/g, ' ').trim();
  const explicitYear = normalized.match(/\b(20\d{2})\b/)?.[1];
  const year = /^Current year$/i.test(normalized) ? currentYear : explicitYear ? Number(explicitYear) : null;
  if (!year) return null;
  return {
    label: normalized,
    value,
    year,
    coveredFrom: `${year}-01-01`,
    coveredThrough: `${year}-12-31`,
  };
}

function quarterEnd(year: number, quarter: number): string {
  if (quarter === 1) return `${year}-03-31`;
  if (quarter === 2) return `${year}-06-30`;
  if (quarter === 3) return `${year}-09-30`;
  return `${year}-12-31`;
}

function quarterStart(year: number, quarter: number): string {
  const month = (quarter - 1) * 3 + 1;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

export function tiaaStatementPeriod(label: string): TiaaStatementPeriod | null {
  const match = label.match(/\bRETIREMENT\s+Q([1-4])\s*\/\s*(20\d{2})\b/i);
  if (!match) return null;
  const quarter = Number(match[1]);
  const year = Number(match[2]);
  return {
    label: `RETIREMENT Q${quarter}/${year}`,
    year,
    quarter,
    coveredFrom: quarterStart(year, quarter),
    coveredThrough: quarterEnd(year, quarter),
  };
}

function routingKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export { tiaaActivitySourceAccountName };

export function tiaaSourceAccountClaimKey(sourceAccountName: string): string {
  const normalized = sourceAccountName.trim();
  if (!normalized) throw new Error('TIAA source account name is empty');
  return `TIAA||${normalized}`;
}

export function tiaaActivityRemoteAccount(remoteAccountId: string): TiaaRemoteAccountIdentity {
  const sourceAccountName = tiaaActivitySourceAccountName(remoteAccountId);
  return {
    routingKey: routingKey(remoteAccountId),
    remoteAccountId,
    sourceAccountName,
    claimKey: tiaaSourceAccountClaimKey(sourceAccountName),
  };
}

function tiaaStatementRemoteAccount(): TiaaRemoteAccountIdentity {
  return {
    routingKey: routingKey(TIAA_STATEMENT_ACCOUNT_NAME),
    remoteAccountId: TIAA_STATEMENT_ACCOUNT_NAME,
    sourceAccountName: TIAA_STATEMENT_ACCOUNT_NAME,
    claimKey: tiaaSourceAccountClaimKey(TIAA_STATEMENT_ACCOUNT_NAME),
  };
}

function isTiaaHost(hostname: string): boolean {
  return /(?:^|\.)tiaa\.org$/i.test(hostname);
}

export function tiaaResponseRequiresAuthentication(status: number, finalUrl: string): boolean {
  if (status === 401 || status === 403) return true;
  let url: URL;
  try {
    url = new URL(finalUrl);
  } catch {
    return false;
  }
  return /^auth\.tiaa\.org$/i.test(url.hostname) ||
    /\/(?:public\/authentication|login|signin|authorization|oauth)(?:\/|$)/i.test(url.pathname);
}

export function tiaaResponseBodyRequiresAuthentication(contentType: string, body: Buffer): boolean {
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) return false;
  const sample = body.toString('utf8', 0, 64 * 1_024);
  return /<input\b[^>]*(?:type=["']?password|autocomplete=["']?(?:username|current-password))/i.test(sample) ||
    /auth\.tiaa\.org|\/public\/authentication\/securelogin/i.test(sample);
}

export function tiaaAuthenticationEntry(artifactTypes: readonly TiaaArtifactType[]): TiaaAuthenticationEntry {
  return artifactTypes.length === 1 && artifactTypes[0] === 'statement'
    ? { url: TIAA_STATEMENTS_URL, ready: 'statement' }
    : { url: TIAA_ACTIVITY_URL, ready: 'activity' };
}

function isTiaaAuthenticationRequired(error: unknown): boolean {
  return error instanceof TiaaAuthenticationRequiredError ||
    (error instanceof Error && error.name === 'TiaaAuthenticationRequiredError');
}

function validatedTiaaUrl(value: string, expectedPath: RegExp): string {
  const url = new URL(value, TIAA_HOME_URL);
  if (url.protocol !== 'https:' || !isTiaaHost(url.hostname) || !expectedPath.test(url.pathname)) {
    throw new Error('TIAA metadata contained an invalid destination');
  }
  return url.toString();
}

function sanitizedError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/https?:\/\/\S+/g, '<redacted-url>')
    .replace(/\b[A-Za-z0-9_.~-]{16,}\b/g, '<redacted-id>')
    .replace(/\b\d{4,}\b/g, '<digits>')
    .slice(0, 500);
}

function asRecord(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`TIAA ${description} had an unexpected shape`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`TIAA ${description} is unavailable`);
  return value.trim();
}

function requestRoot(request: Request): Request {
  let root = request;
  while (root.redirectedFrom()) root = root.redirectedFrom()!;
  return root;
}

function belongsToBrowserFetch(request: Request, destination: string, method: 'GET' | 'POST'): boolean {
  const root = requestRoot(request);
  return root.url() === destination && root.method() === method;
}

export async function browserFetch(
  page: Page,
  url: string,
  options: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string } = {},
): Promise<BrowserFetchResult> {
  const destination = validatedTiaaUrl(url, /^\/(?:secure|private)\//i);
  const method = options.method ?? 'GET';
  let authenticationEvidence = false;
  const observeRequest = (request: Request) => {
    if (belongsToBrowserFetch(request, destination, method) &&
      tiaaResponseRequiresAuthentication(200, request.url())) authenticationEvidence = true;
  };
  const observeResponse = (response: Response) => {
    if (belongsToBrowserFetch(response.request(), destination, method) &&
      tiaaResponseRequiresAuthentication(response.status(), response.url())) authenticationEvidence = true;
  };
  page.on('request', observeRequest);
  page.on('response', observeResponse);
  let response: { status: number; contentType: string; finalUrl: string; body: string };
  try {
    response = await page.evaluate(async ({ destination, method, headers, body }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const result = await fetch(destination, {
          method,
          headers,
          body,
          credentials: 'include',
          redirect: 'follow',
          signal: controller.signal,
        });
        const bytes = new Uint8Array(await result.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return {
          status: result.status,
          contentType: result.headers.get('content-type') ?? '',
          finalUrl: result.url,
          body: btoa(binary),
        };
      } finally {
        clearTimeout(timeout);
      }
    }, {
      destination,
      method,
      headers: options.headers ?? {},
      body: options.body,
    });
  } catch (error) {
    if (authenticationEvidence) throw new TiaaAuthenticationRequiredError('TIAA authentication is required');
    throw error;
  } finally {
    page.off('request', observeRequest);
    page.off('response', observeResponse);
  }
  const decoded = {
    status: response.status,
    contentType: response.contentType.toLowerCase(),
    finalUrl: response.finalUrl,
    body: Buffer.from(response.body, 'base64'),
  };
  if (tiaaResponseRequiresAuthentication(decoded.status, decoded.finalUrl) ||
    tiaaResponseBodyRequiresAuthentication(decoded.contentType, decoded.body)) {
    throw new TiaaAuthenticationRequiredError('TIAA authentication is required');
  }
  return decoded;
}

async function browserFetchJson(
  page: Page,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<unknown> {
  const response = await browserFetch(page, new URL(path, TIAA_HOME_URL).toString(), {
    method: options.method ?? 'GET',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (response.status < 200 || response.status >= 300 || !/application\/json/i.test(response.contentType)) {
    throw new Error(`TIAA JSON request failed with status ${response.status}`);
  }
  try {
    return JSON.parse(response.body.toString('utf8')) as unknown;
  } catch {
    throw new Error('TIAA JSON response could not be decoded');
  }
}

export async function isTiaaAuthenticatedPage(page: Page): Promise<boolean> {
  if (await page.locator(VISIBLE_AUTHENTICATION_FIELDS).count() > 0) return false;
  const url = new URL(page.url());
  return isTiaaHost(url.hostname) && new RegExp(TIAA_AUTHENTICATED_PATH, 'i').test(url.pathname);
}

export async function waitUntilTiaaAuthenticated(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    ({ pathPattern, authenticationFields }: { pathPattern: string; authenticationFields: string }) => {
      const visibleAuthenticationField = Array.from(document.querySelectorAll(authenticationFields)).some(element => {
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      });
      return !visibleAuthenticationField
        && /(?:^|\.)tiaa\.org$/i.test(location.hostname)
        && new RegExp(pathPattern, 'i').test(location.pathname);
    },
    { pathPattern: TIAA_AUTHENTICATED_PATH, authenticationFields: AUTHENTICATION_FIELDS },
    { timeout: timeoutMs },
  );
}

async function openTiaaForAuthentication(page: Page, entry: TiaaAuthenticationEntry): Promise<void> {
  let current: URL | null = null;
  try {
    current = new URL(page.url());
  } catch {}
  const target = new URL(entry.url);
  if (!current || current.hostname !== target.hostname || current.pathname !== target.pathname) {
    try {
      await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (error) {
      if (!/net::ERR_ABORTED|navigation.*interrupted/i.test(String(error instanceof Error ? error.message : error))) {
        throw error;
      }
    }
  }
  const ready = entry.ready === 'activity'
    ? page.getByRole('button', { name: /^Download$/i })
    : page.getByRole('combobox');
  await Promise.race([
    ready.first().waitFor({ state: 'visible', timeout: 30_000 }),
    page.locator(VISIBLE_AUTHENTICATION_FIELDS).first().waitFor({ state: 'visible', timeout: 30_000 }),
    page.waitForURL(url => /login|signin|authenticate|authorization|oauth|sso|auth\./i.test(url.toString()), {
      timeout: 30_000,
    }),
  ]);
}

async function navigateToSpa(page: Page, url: string, ready: () => ReturnType<Page['locator']>): Promise<void> {
  const target = new URL(url);
  const current = new URL(page.url());
  if (current.hostname !== target.hostname || current.pathname !== target.pathname) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (error) {
      if (!/net::ERR_ABORTED|navigation.*interrupted/i.test(String(error instanceof Error ? error.message : error))) {
        throw error;
      }
    }
  }
  await ready().first().waitFor({ state: 'visible', timeout: 30_000 });
}

async function comboboxOptions(page: Page): Promise<Array<{ label: string; value: string }>> {
  const combobox = page.getByRole('combobox').first();
  await combobox.click();
  const options = page.getByRole('option');
  await options.first().waitFor({ state: 'visible', timeout: 30_000 });
  const values = await options.evaluateAll(elements => elements.map(element => ({
    label: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
    value: element.getAttribute('data-value') ?? element.getAttribute('value') ?? '',
  })));
  await page.keyboard.press('Escape');
  return values;
}

async function selectComboboxLabel(page: Page, label: string): Promise<void> {
  const combobox = page.getByRole('combobox').first();
  await combobox.click();
  const target = page.getByRole('option', { name: label, exact: true });
  await target.waitFor({ state: 'visible', timeout: 30_000 });
  await target.click();
}

export function tiaaActivityAccountTypes(value: unknown): ActivityAccountType[] {
  const response = asRecord(value, 'activity options');
  if (!Array.isArray(response.availableAccountTypes)) throw new Error('TIAA activity account options are unavailable');
  const accountTypes = response.availableAccountTypes.map((itemValue, index) => {
    const item = asRecord(itemValue, `activity account option ${index + 1}`);
    const id = requiredString(item.id, 'activity account option id');
    const description = requiredString(item.description, 'activity account option description');
    return {
      id,
      description,
      selected: item.selected === true,
      routingKey: routingKey(`activity-type\u0000${id}\u0000${description}`),
    };
  });
  if (accountTypes.length === 0) throw new Error('TIAA activity download exposed no account selections');
  if (accountTypes.length !== 1 || !/\bretirement\b/i.test(accountTypes[0]!.description)) {
    throw new Error('TIAA activity download exposed unsupported account selections');
  }
  return accountTypes;
}

async function discoverActivityMetadata(
  page: Page,
  config: Pick<TiaaSyncConfig, 'from' | 'through'>,
): Promise<ActivityPageMetadata> {
  await navigateToSpa(page, TIAA_ACTIVITY_URL, () => page.getByRole('button', { name: /^Download$/i }));
  const accountTypes = tiaaActivityAccountTypes(
    await browserFetchJson(page, TIAA_ACTIVITY_OPTIONS_PATH, { method: 'POST' }),
  );
  if (new Set(accountTypes.map(account => account.routingKey)).size !== accountTypes.length) {
    throw new Error('TIAA activity account selections are ambiguous');
  }

  const currentYear = new Date().getFullYear();
  const periodsByYear = new Map<number, TiaaActivityPeriod>();
  for (const option of await comboboxOptions(page)) {
    const period = tiaaActivityPeriod(option.label, option.value, currentYear);
    if (!period || !dateIntersection(period.coveredFrom, period.coveredThrough, config.from, config.through)) continue;
    periodsByYear.set(period.year, period);
  }
  const periods = [...periodsByYear.values()].sort((left, right) => right.year - left.year);
  if (periods.length === 0) throw new Error('TIAA offers no activity period for the requested range');
  return { accountTypes, periods };
}

export function validateTiaaActivityRequestBody(
  value: unknown,
  period: TiaaActivityPeriod,
  account: Pick<ActivityAccountType, 'id' | 'description'>,
): Record<string, unknown> {
  const record = asRecord(value, 'activity download request');
  if (typeof record.selectedTimePeriod !== 'string' || !Array.isArray(record.selectedAccountTypes)) {
    throw new Error('TIAA activity download request had an unexpected shape');
  }
  if (record.downloadCSV !== true || record.noAccountSelected !== false) {
    throw new Error('TIAA activity download request did not select an isolated CSV export');
  }
  if (period.value && record.selectedTimePeriod !== period.value) {
    throw new Error('TIAA activity download request did not match the selected period');
  }
  if (record.selectedAccountTypes.length !== 1) {
    throw new Error('TIAA activity download request did not isolate the supported account selection');
  }
  const selected = asRecord(record.selectedAccountTypes[0], 'selected activity account');
  if (selected.id !== account.id || selected.description !== account.description || selected.selected !== true) {
    throw new Error('TIAA activity download request did not match the supported account selection');
  }
  return record;
}

async function captureActivityRequestBody(
  page: Page,
  period: TiaaActivityPeriod,
  account: ActivityAccountType,
): Promise<Record<string, unknown>> {
  await selectComboboxLabel(page, period.label);
  const csv = page.getByRole('checkbox', { name: /CSV/i }).first();
  await csv.waitFor({ state: 'visible', timeout: 30_000 });
  if (!await csv.isChecked()) await csv.check();
  const requestPromise = page.waitForRequest(request => {
    const url = new URL(request.url());
    return request.method() === 'POST' && url.hostname === 'my.tiaa.org' && url.pathname === TIAA_ACTIVITY_DOWNLOAD_PATH;
  }, { timeout: 30_000 });
  const routePattern = `**${TIAA_ACTIVITY_DOWNLOAD_PATH}`;
  await page.route(routePattern, route => route.abort());
  try {
    await page.getByRole('button', { name: /^Download$/i }).click();
    const request = await requestPromise;
    return validateTiaaActivityRequestBody(request.postDataJSON() as unknown, period, account);
  } finally {
    await page.unroute(routePattern);
  }
}

async function responseBody(response: BrowserFetchResult, kind: TiaaArtifactKind): Promise<Buffer> {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`TIAA ${kind.toUpperCase()} request failed with status ${response.status}`);
  }
  const minimumSize = kind === 'pdf' ? 10_000 : 50;
  if (response.body.length < minimumSize) throw new Error(`TIAA ${kind.toUpperCase()} response was empty or too small`);
  const signatureMatches = kind === 'pdf'
    ? response.body.subarray(0, 5).toString('ascii') === '%PDF-'
    : !response.body.includes(0) && response.body.toString('utf8', 0, 1_024).replace(/^\uFEFF/, '')
      .startsWith('Date,AccountId,Action,Security,Price,Quantity,Amount,Text,Memo,Commission');
  if (!signatureMatches) throw new Error(`TIAA ${kind.toUpperCase()} response had an unexpected signature`);
  if (/text\/html|application\/(?:json|xhtml\+xml)/.test(response.contentType)) {
    throw new Error(`TIAA ${kind.toUpperCase()} response had an unexpected content type`);
  }
  return response.body;
}

export function tiaaActivityAccountIds(text: string): string[] {
  const rows = parseCsvRows(text);
  const headerIndex = rows.findIndex(row => row[0]?.trim() === 'Date' && row.includes('AccountId'));
  if (headerIndex < 0) throw new Error('TIAA CSV header is missing');
  const accountIndex = rows[headerIndex]!.findIndex(value => value.trim() === 'AccountId');
  const ids = rows.slice(headerIndex + 1).map(row => row[accountIndex]?.trim() ?? '').filter(Boolean);
  return [...new Set(ids)];
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(info => info.isFile()).catch(() => false);
}

function safeArtifactPath(outputDir: string, fileName: string): string {
  if (basename(fileName) !== fileName || !/^tiaa-[a-z0-9-]+\.(csv|pdf)$/i.test(fileName)) {
    throw new Error('TIAA artifact filename is invalid');
  }
  const path = resolve(outputDir, fileName);
  if (dirname(path) !== resolve(outputDir)) throw new Error('TIAA artifact path escaped its output directory');
  return path;
}

export async function validateTiaaActivityArtifact(
  path: string,
  logicalFileName = basename(path),
): Promise<ActivityValidation> {
  const info = await stat(path);
  if (!info.isFile() || info.size < 50) throw new Error('TIAA CSV artifact is empty or too small');
  const bytes = await readFile(path);
  if (bytes.includes(0)) throw new Error('TIAA CSV artifact contains binary data');
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  const header = 'Date,AccountId,Action,Security,Price,Quantity,Amount,Text,Memo,Commission';
  if (!text.startsWith(header)) throw new Error('TIAA CSV artifact has an unexpected signature');
  if (!tiaaActivityMeta.matches({ filename: logicalFileName, sample: text.slice(0, 1_024) })) {
    throw new Error('EasyMoney did not recognize the TIAA CSV artifact');
  }
  const parsed = await parseTiaaActivity(path);
  if (parsed.transactions.length === 0) throw new Error('TIAA CSV artifact contains no parser-visible activity');
  const remoteAccountIds = tiaaActivityAccountIds(text);
  if (remoteAccountIds.length === 0) throw new Error('TIAA activity artifact exposes no remote account identities');
  const expectedAccountNames = remoteAccountIds.map(tiaaActivitySourceAccountName).sort();
  const parsedAccountNames = [...new Set(parsed.transactions.map(transaction => transaction.account).filter(Boolean))].sort();
  if (expectedAccountNames.join('\u0000') !== parsedAccountNames.join('\u0000')) {
    throw new Error('TIAA parser account claims do not match the CSV remote identities');
  }
  return {
    size: info.size,
    remoteAccounts: remoteAccountIds.map(tiaaActivityRemoteAccount),
    coveredFrom: parsed.covered_from ?? '',
    coveredThrough: parsed.covered_to ?? '',
    transactionCount: parsed.transactions.length,
    balanceCount: parsed.balances.length,
  };
}

export async function validateTiaaStatementArtifact(
  path: string,
  logicalFileName = basename(path),
  parser: typeof parseTiaaStatement = parseTiaaStatement,
  expectedCoverage?: { coveredFrom: string; coveredThrough: string },
): Promise<StatementValidation> {
  const info = await stat(path);
  if (!info.isFile() || info.size < 10_000) throw new Error('TIAA PDF artifact is empty or too small');
  const bytes = await readFile(path);
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('TIAA PDF artifact has an unexpected signature');
  if (!tiaaStatementMeta.matches({ filename: logicalFileName, sample: '' })) {
    throw new Error('EasyMoney did not recognize the TIAA PDF artifact');
  }
  const parsed = await parser(path);
  if (parsed.balances.length === 0) throw new Error('TIAA PDF parser found no balance');
  const parsedAccounts = new Set([
    ...parsed.transactions.map(transaction => transaction.account),
    ...parsed.balances.map(balance => balance.account),
  ]);
  if (parsedAccounts.size !== 1 || !parsedAccounts.has(TIAA_STATEMENT_ACCOUNT_NAME)) {
    throw new Error('TIAA PDF parser produced an unexpected account identity');
  }
  if (expectedCoverage &&
    (parsed.covered_from !== expectedCoverage.coveredFrom || parsed.covered_to !== expectedCoverage.coveredThrough)) {
    throw new Error('TIAA PDF parser coverage did not match the requested statement period');
  }
  return {
    size: info.size,
    remoteAccounts: [tiaaStatementRemoteAccount()],
    coveredFrom: parsed.covered_from ?? '',
    coveredThrough: parsed.covered_to ?? '',
    transactionCount: parsed.transactions.length,
    balanceCount: parsed.balances.length,
  };
}

async function writeValidatedArtifact<T>(options: {
  outputDir: string;
  fileName: string;
  body: Buffer;
  validate: (path: string, logicalFileName: string) => Promise<T>;
}): Promise<{ path: string; source: 'downloaded'; validation: T }> {
  const path = safeArtifactPath(options.outputDir, options.fileName);
  const partialPath = join(options.outputDir, `.${options.fileName}.partial`);
  await writeFile(partialPath, options.body);
  try {
    const validation = await options.validate(partialPath, options.fileName);
    await rename(partialPath, path);
    return { path, source: 'downloaded', validation };
  } catch (error) {
    await unlink(partialPath).catch(() => {});
    throw error;
  }
}

async function existingValidatedArtifact<T>(options: {
  outputDir: string;
  fileName: string;
  validate: (path: string, logicalFileName: string) => Promise<T>;
}): Promise<{ path: string; source: 'existing'; validation: T } | null> {
  const path = safeArtifactPath(options.outputDir, options.fileName);
  if (!await fileExists(path)) return null;
  return { path, source: 'existing', validation: await options.validate(path, options.fileName) };
}

function activityFileName(account: ActivityAccountType, period: TiaaActivityPeriod): string {
  return `tiaa-retirement-annuity-${period.year}-account-${account.routingKey}-${period.coveredFrom}-to-${period.coveredThrough}.csv`;
}

export function validateTiaaActivityCoverage(
  coverage: Pick<ActivityValidation, 'coveredFrom' | 'coveredThrough'>,
  period: Pick<TiaaActivityPeriod, 'coveredFrom' | 'coveredThrough'>,
): void {
  if (coverage.coveredFrom < period.coveredFrom || coverage.coveredThrough > period.coveredThrough) {
    throw new Error('TIAA activity artifact falls outside the selected period');
  }
}

async function downloadActivityArtifact(
  page: Page,
  outputDir: string,
  account: ActivityAccountType,
  period: TiaaActivityPeriod,
  requestTemplate: Record<string, unknown>,
): Promise<TiaaDownloadedArtifact> {
  const fileName = activityFileName(account, period);
  const existing = await existingValidatedArtifact({ outputDir, fileName, validate: validateTiaaActivityArtifact });
  const saved = existing ?? await (async () => {
    const response = await browserFetch(page, new URL(TIAA_ACTIVITY_DOWNLOAD_PATH, TIAA_HOME_URL).toString(), {
      method: 'POST',
      headers: { accept: 'text/csv', 'content-type': 'application/json' },
      body: JSON.stringify(requestTemplate),
    });
    return writeValidatedArtifact({
      outputDir,
      fileName,
      body: await responseBody(response, 'csv'),
      validate: validateTiaaActivityArtifact,
    });
  })();
  validateTiaaActivityCoverage(saved.validation, period);
  return {
    fileName,
    path: saved.path,
    kind: 'csv',
    artifactType: 'activity',
    parserId: 'tiaa-activity-csv',
    account: { routingKey: account.routingKey, remoteAccounts: saved.validation.remoteAccounts },
    coveredFrom: saved.validation.coveredFrom || period.coveredFrom,
    coveredThrough: saved.validation.coveredThrough || period.coveredThrough,
    size: saved.validation.size,
    transactionCount: saved.validation.transactionCount,
    balanceCount: saved.validation.balanceCount,
    source: saved.source,
  };
}

function nestedObjects(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(nestedObjects);
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  return [item, ...Object.values(item).flatMap(nestedObjects)];
}

export function tiaaStatementDocuments(value: unknown): StatementDocument[] {
  const documents = nestedObjects(value).flatMap(item => {
    const additionalDescription = typeof item.additionalDescription === 'string' ? item.additionalDescription : '';
    const description = typeof item.description === 'string' ? item.description : '';
    const period = tiaaStatementPeriod(`${additionalDescription} ${description}`);
    if (!period) return [];
    const docId = typeof item.docID === 'string' ? item.docID.trim() : '';
    const docLocation = typeof item.docLocation === 'string' ? item.docLocation.trim() : '';
    const docTypeId = typeof item.docTypeID === 'string' ? item.docTypeID.trim() : '';
    const categoryId = typeof item.categoryID === 'string' ? item.categoryID.trim() : '';
    const productType = typeof item.productType === 'string' ? item.productType.trim() : '';
    const destinationName = typeof item.destinationName === 'string' ? item.destinationName.trim() : '';
    if (!docId || !docLocation || !docTypeId || !categoryId || !productType || !destinationName) {
      throw new Error('TIAA quarterly statement metadata is missing a stable account identity');
    }
    return [{
      ...period,
      docId,
      docLocation,
      docTypeId,
      categoryId,
      productType,
      destinationName,
      routingKey: routingKey(`statement\u0000${productType}\u0000${categoryId}\u0000${destinationName}`),
    }];
  });
  const unique = new Map<string, StatementDocument>();
  for (const document of documents) unique.set(`${document.docId}\u0000${document.docLocation}`, document);
  return [...unique.values()].sort((left, right) => right.coveredThrough.localeCompare(left.coveredThrough));
}

export function validateTiaaStatementDocumentIdentities(documents: readonly StatementDocument[]): void {
  if (documents.length === 0) return;
  const statementRoutingKeys = new Set(documents.map(document => document.routingKey));
  const statementPeriods = new Set(documents.map(document => document.coveredThrough));
  if (statementRoutingKeys.size !== 1 || statementPeriods.size !== documents.length) {
    throw new Error('TIAA statement metadata identifies multiple accounts that the parser cannot distinguish');
  }
}

export function tiaaStatementRequestUrl(document: Pick<
  StatementDocument,
  'docId' | 'label' | 'categoryId' | 'docTypeId' | 'docLocation' | 'productType'
>): string {
  const url = new URL(TIAA_STATEMENT_REPORT_PATH, TIAA_HOME_URL);
  url.searchParams.set('doc', document.docId);
  url.searchParams.set('linkName', document.label);
  url.searchParams.set('categoryId', document.categoryId);
  url.searchParams.set('docType', document.docTypeId);
  url.searchParams.set('docLoc', document.docLocation);
  url.searchParams.set('docProductType', document.productType);
  return validatedTiaaUrl(url.toString(), /^\/private\/ahstatementsui\/getreport$/i);
}

function statementFileName(document: StatementDocument): string {
  return `tiaa-${document.coveredThrough}-retirement-q${document.quarter}-${document.year}-${document.routingKey}.pdf`;
}

async function downloadStatementArtifact(
  page: Page,
  outputDir: string,
  document: StatementDocument,
): Promise<TiaaDownloadedArtifact> {
  const fileName = statementFileName(document);
  const validate = (path: string, logicalFileName: string) =>
    validateTiaaStatementArtifact(path, logicalFileName, parseTiaaStatement, document);
  const existing = await existingValidatedArtifact({ outputDir, fileName, validate });
  const saved = existing ?? await (async () => {
    const response = await browserFetch(page, tiaaStatementRequestUrl(document), {
      headers: { accept: 'application/pdf' },
    });
    return writeValidatedArtifact({
      outputDir,
      fileName,
      body: await responseBody(response, 'pdf'),
      validate,
    });
  })();
  return {
    fileName,
    path: saved.path,
    kind: 'pdf',
    artifactType: 'statement',
    parserId: 'tiaa-statement-pdf',
    account: { routingKey: document.routingKey, remoteAccounts: saved.validation.remoteAccounts },
    coveredFrom: saved.validation.coveredFrom || document.coveredFrom,
    coveredThrough: saved.validation.coveredThrough || document.coveredThrough,
    size: saved.validation.size,
    transactionCount: saved.validation.transactionCount,
    balanceCount: saved.validation.balanceCount,
    source: saved.source,
  };
}

async function discoverStatementDocuments(
  page: Page,
  config: Pick<TiaaSyncConfig, 'from' | 'through'>,
): Promise<StatementDocument[]> {
  await navigateToSpa(page, TIAA_STATEMENTS_URL, () => page.getByRole('combobox'));
  const metadata = await browserFetchJson(page, TIAA_STATEMENT_METADATA_PATH);
  return tiaaStatementDocuments(metadata).filter(document =>
    dateIntersection(document.coveredFrom, document.coveredThrough, config.from, config.through)
  );
}

function createProgressTracker(onProgress: (event: TiaaProgressEvent) => void) {
  const started = performance.now();
  const phaseStarts = new Map<TiaaProgressPhase, number>();
  const timingsMs: Partial<Record<TiaaProgressPhase, number>> = {};
  const emit = (
    phase: TiaaProgressPhase,
    state: TiaaProgressEvent['state'],
    message: string,
    data?: TiaaProgressEvent['data'],
  ) => {
    const now = performance.now();
    const phaseStarted = phaseStarts.get(phase) ?? now;
    onProgress({
      phase,
      state,
      message,
      elapsedMs: Math.round(now - started),
      phaseElapsedMs: Math.round(now - phaseStarted),
      ...(data ? { data } : {}),
    });
  };
  return {
    timingsMs,
    start(phase: TiaaProgressPhase, message: string, data?: TiaaProgressEvent['data']) {
      phaseStarts.set(phase, performance.now());
      emit(phase, 'started', message, data);
    },
    progress(phase: TiaaProgressPhase, message: string, data?: TiaaProgressEvent['data']) {
      emit(phase, 'progress', message, data);
    },
    complete(phase: TiaaProgressPhase, message: string, data?: TiaaProgressEvent['data']) {
      const now = performance.now();
      timingsMs[phase] = (timingsMs[phase] ?? 0) + Math.round(now - (phaseStarts.get(phase) ?? now));
      emit(phase, 'completed', message, data);
    },
  };
}

type AuthenticatedTiaaOperations = {
  discoverActivityMetadata: typeof discoverActivityMetadata;
  captureActivityRequestBody: typeof captureActivityRequestBody;
  downloadActivityArtifact: typeof downloadActivityArtifact;
  discoverStatementDocuments: typeof discoverStatementDocuments;
  downloadStatementArtifact: typeof downloadStatementArtifact;
};

const authenticatedTiaaOperations: AuthenticatedTiaaOperations = {
  discoverActivityMetadata,
  captureActivityRequestBody,
  downloadActivityArtifact,
  discoverStatementDocuments,
  downloadStatementArtifact,
};

export async function runAuthenticatedTiaa(
  page: Page,
  config: TiaaSyncConfig,
  progress: ReturnType<typeof createProgressTracker> = createProgressTracker(() => {}),
  operationOverrides: Partial<AuthenticatedTiaaOperations> = {},
): Promise<BrowserRunResult> {
  const operations = { ...authenticatedTiaaOperations, ...operationOverrides };
  const requestedTypes = new Set(config.artifactTypes ?? ['activity', 'statement']);
  progress.complete('authentication', 'TIAA authentication is ready');

  const artifacts: TiaaDownloadedArtifact[] = [];
  let accountSelectionsDiscovered = 0;
  let activityPeriodsDiscovered = 0;
  let emptyActivityExports = 0;
  if (requestedTypes.has('activity')) {
    progress.start('account-discovery', 'Discovering TIAA account selections and activity periods');
    const activityMetadata = await operations.discoverActivityMetadata(page, config);
    accountSelectionsDiscovered = activityMetadata.accountTypes.length;
    activityPeriodsDiscovered = activityMetadata.periods.length;
    progress.complete('account-discovery', 'TIAA account discovery is complete', {
      accountSelections: activityMetadata.accountTypes.length,
      activityPeriods: activityMetadata.periods.length,
    });
    const total = activityMetadata.accountTypes.length * activityMetadata.periods.length;
    progress.start('activity-downloads', 'Downloading TIAA activity artifacts', { total });
    let index = 0;
    for (const period of activityMetadata.periods) {
      const account = activityMetadata.accountTypes[0]!;
      const requestTemplate = await operations.captureActivityRequestBody(page, period, account);
      index += 1;
      progress.progress('activity-downloads', 'Downloading a TIAA activity artifact', { index, total });
      progress.start('validation', 'Validating a TIAA activity artifact', { index, total });
      try {
        const artifact = await operations.downloadActivityArtifact(
          page,
          config.outputDir,
          account,
          period,
          requestTemplate,
        );
        artifacts.push(artifact);
        progress.complete('validation', 'TIAA activity passed signature, account-claim, and parser validation', {
          index,
          total,
          sourceAccounts: artifact.account.remoteAccounts.length,
          transactions: artifact.transactionCount,
        });
      } catch (error) {
        if (/no parser-visible activity/.test(String(error instanceof Error ? error.message : error))) {
          emptyActivityExports += 1;
          progress.complete('validation', 'TIAA activity period contained no importable rows', { index, total });
          continue;
        }
        throw error;
      }
    }
    progress.complete('activity-downloads', 'TIAA activity downloads are complete', {
      artifacts: artifacts.filter(artifact => artifact.artifactType === 'activity').length,
      empty: emptyActivityExports,
    });
  }

  let statementsDiscovered = 0;
  if (requestedTypes.has('statement')) {
    progress.start('statement-discovery', 'Discovering TIAA statements from authenticated metadata');
    const documents = await operations.discoverStatementDocuments(page, config);
    validateTiaaStatementDocumentIdentities(documents);
    const statementRoutingKeys = new Set(documents.map(document => document.routingKey));
    statementsDiscovered = documents.length;
    progress.complete('statement-discovery', 'TIAA statement discovery is complete', {
      statements: documents.length,
      accountIdentities: statementRoutingKeys.size,
    });
    progress.start('statement-downloads', 'Downloading TIAA statements from authenticated requests', {
      total: documents.length,
    });
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index]!;
      progress.progress('statement-downloads', 'Downloading a TIAA statement artifact', {
        index: index + 1,
        total: documents.length,
      });
      progress.start('validation', 'Validating a TIAA statement artifact', {
        index: index + 1,
        total: documents.length,
      });
      const artifact = await operations.downloadStatementArtifact(page, config.outputDir, document);
      artifacts.push(artifact);
      progress.complete('validation', 'TIAA statement passed signature and parser validation', {
        index: index + 1,
        total: documents.length,
        transactions: artifact.transactionCount,
        balances: artifact.balanceCount,
      });
    }
    progress.complete('statement-downloads', 'TIAA statement downloads are complete', {
      artifacts: documents.length,
    });
  }

  const sourceClaims = new Set(artifacts.flatMap(artifact => artifact.account.remoteAccounts.map(account => account.claimKey)));
  return {
    artifacts,
    accountsDiscovered: sourceClaims.size,
    accountSelectionsDiscovered,
    activityPeriodsDiscovered,
    statementsDiscovered,
    emptyActivityExports,
  };
}

const browserProgram = `async (page, _reportProgress, bindings) => {
  try {
    await bindings.openHome(page);
    if (!await bindings.isAuthenticated(page)) {
      return JSON.stringify({
        status: 'login-required',
        action: 'Sign in to TIAA and complete MFA. EasyMoney will continue automatically without refreshing this page.',
      });
    }
    const result = await bindings.run(page);
    return JSON.stringify({ status: 'complete', ...result });
  } catch (error) {
    if (bindings.isAuthenticationRequired(error)) {
      return JSON.stringify({
        status: 'login-required',
        action: 'Sign in to TIAA and complete MFA. EasyMoney will continue automatically without refreshing this page.',
      });
    }
    return JSON.stringify({ status: 'error', message: bindings.sanitizeError(error) });
  }
}`;

export async function runTiaaSync(
  config: TiaaSyncConfig,
  onProgress: (event: TiaaProgressEvent) => void = () => {},
): Promise<TiaaSyncResult> {
  validateConfig(config);
  const artifactTypes: TiaaArtifactType[] = config.artifactTypes ?? ['activity', 'statement'];
  const normalizedConfig: TiaaSyncConfig = {
    ...config,
    outputDir: resolve(config.outputDir),
    session: config.session ?? TIAA_SESSION,
    artifactTypes: [...new Set(artifactTypes)],
  };
  await mkdir(normalizedConfig.outputDir, { recursive: true });
  const progress = createProgressTracker(onProgress);
  progress.start('authentication', 'Checking the cached TIAA authentication');
  const userAgent = await normalChromeUserAgent();
  const authenticationEntry = tiaaAuthenticationEntry(normalizedConfig.artifactTypes!);

  const result = await runInstitutionBrowserProgram<BrowserRunResult>(
    {
      name: normalizedConfig.session!,
      startUrl: authenticationEntry.url,
      profilePath: normalizedConfig.profilePath,
      launchArgs: ['--disable-blink-features=AutomationControlled'],
      contextOptions: {
        userAgent,
        ...(normalizedConfig.headless === undefined ? {} : { headless: normalizedConfig.headless }),
      },
    },
    browserProgram,
    {
      authenticationTimeoutMs: normalizedConfig.authenticationTimeoutMs,
      completionDescription: 'TIAA downloads are complete and ready for review.',
      isAuthenticated: isTiaaAuthenticatedPage,
      waitUntilAuthenticated: waitUntilTiaaAuthenticated,
      onProgress: message => {
        if (/Authentication complete/i.test(message)) progress.progress('authentication', 'TIAA login and MFA completed');
      },
      programBindings: {
        isAuthenticated: isTiaaAuthenticatedPage,
        openHome: (page: Page) => openTiaaForAuthentication(page, authenticationEntry),
        run: (page: Page) => runAuthenticatedTiaa(page, normalizedConfig, progress),
        isAuthenticationRequired: isTiaaAuthenticationRequired,
        sanitizeError: sanitizedError,
      },
    },
  );
  if (result.status === 'login-required') throw new Error(result.action ?? 'TIAA login is required');
  if (result.status !== 'complete') throw new Error(result.message ?? 'TIAA sync did not complete');

  progress.start('complete', 'Finalizing TIAA artifact results');
  progress.complete('complete', 'TIAA artifacts are ready for preview', { artifacts: result.artifacts.length });
  return {
    artifacts: result.artifacts,
    accountsDiscovered: result.accountsDiscovered,
    accountSelectionsDiscovered: result.accountSelectionsDiscovered,
    activityPeriodsDiscovered: result.activityPeriodsDiscovered,
    statementsDiscovered: result.statementsDiscovered,
    emptyActivityExports: result.emptyActivityExports,
    timingsMs: { ...progress.timingsMs },
  };
}
