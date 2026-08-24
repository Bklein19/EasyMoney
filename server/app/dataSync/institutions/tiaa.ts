import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type { APIResponse, Locator, Page } from 'playwright';

import { parseCsvRows } from '../../importParsers/csvRows.ts';
import parseTiaaActivity, {
  meta as tiaaActivityMeta,
} from '../../importParsers/moneyParsers/tiaa-activity-csv.ts';
import parseTiaaStatement, {
  meta as tiaaStatementMeta,
} from '../../importParsers/moneyParsers/tiaa-statement-pdf.ts';
import { runInstitutionBrowserProgram } from '../browserSession.ts';

const TIAA_SESSION = 'tiaa-catchup';
const TIAA_HOME_URL = 'https://my.tiaa.org/private/participant/home';
const TIAA_AUTHENTICATED_PATH = '^/private/participant(?:/|$)';
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

export interface TiaaArtifactAccount {
  routingKey: string;
  remoteAccountId: string | null;
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
  source: 'downloaded' | 'existing';
}

export interface TiaaSyncResult {
  artifacts: TiaaDownloadedArtifact[];
  accountsDiscovered: number;
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

type TiaaApiRequest = {
  url: string;
  method: 'GET' | 'POST';
  data?: string;
  headers?: Record<string, string>;
};

type RawActivityAccount = {
  id: string;
  name: string;
  value: string;
  label: string;
  ordinal: number;
};

type DiscoveredActivityAccount = RawActivityAccount & {
  routingKey: string;
  identityTokens: string[];
};

type ActivityPageMetadata = {
  accounts: DiscoveredActivityAccount[];
  periods: TiaaActivityPeriod[];
};

type TiaaNavigation = {
  activityUrl: string;
  statementsUrl: string;
};

type TiaaStatementPeriod = {
  label: string;
  year: number;
  quarter: number;
  coveredFrom: string;
  coveredThrough: string;
};

type StatementDocument = TiaaStatementPeriod & {
  rowText: string;
  account: DiscoveredActivityAccount;
};

type BrowserRunResult = {
  artifacts: TiaaDownloadedArtifact[];
  accountsDiscovered: number;
  activityPeriodsDiscovered: number;
  statementsDiscovered: number;
  emptyActivityExports: number;
};

type ActivityValidation = {
  size: number;
  remoteAccountId: string;
  coveredFrom: string;
  coveredThrough: string;
};

type StatementValidation = {
  size: number;
  coveredFrom: string;
  coveredThrough: string;
};

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

function accountIdentityTokens(account: RawActivityAccount): string[] {
  const values = `${account.value} ${account.id} ${account.label}`.match(/\d{4,}/g) ?? [];
  const tokens = values.flatMap(value => [value, value.slice(-4)]).filter(value => value.length >= 4);
  return [...new Set(tokens)];
}

function isTiaaHost(hostname: string): boolean {
  return /(?:^|\.)tiaa\.org$/i.test(hostname);
}

function validatedTiaaUrl(value: string, expectedPath: RegExp): string {
  const url = new URL(value, TIAA_HOME_URL);
  if (url.protocol !== 'https:' || !isTiaaHost(url.hostname) || !expectedPath.test(url.pathname)) {
    throw new Error('TIAA navigation metadata contained an invalid destination');
  }
  return url.toString();
}

function validatedActivityAction(value: string): string {
  const url = new URL(value, TIAA_HOME_URL);
  if (url.protocol !== 'https:' || !isTiaaHost(url.hostname)) {
    throw new Error('TIAA activity form contained an invalid destination');
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

export async function isTiaaAuthenticatedPage(page: Page): Promise<boolean> {
  const authenticationFields = await page.locator(VISIBLE_AUTHENTICATION_FIELDS).count();
  if (authenticationFields > 0) return false;
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

async function openTiaaHomeForAuthentication(page: Page): Promise<void> {
  let current: URL | null = null;
  try {
    current = new URL(page.url());
  } catch {}
  const alreadyPrivate = current && isTiaaHost(current.hostname)
    && new RegExp(TIAA_AUTHENTICATED_PATH, 'i').test(current.pathname);
  if (alreadyPrivate) return;

  await page.goto(TIAA_HOME_URL, { waitUntil: 'commit', timeout: 30_000 });
  await page.waitForFunction(
    ({ pathPattern, authenticationFields }: { pathPattern: string; authenticationFields: string }) => {
      const privateTiaaPage = /(?:^|\.)tiaa\.org$/i.test(location.hostname)
        && new RegExp(pathPattern, 'i').test(location.pathname);
      const visibleAuthenticationField = Array.from(document.querySelectorAll(authenticationFields)).some(element => {
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      });
      const loginLikeLocation = /login|signin|authenticate|authorization|oauth|sso|auth\./i.test(location.href);
      return privateTiaaPage || visibleAuthenticationField || loginLikeLocation;
    },
    { pathPattern: TIAA_AUTHENTICATED_PATH, authenticationFields: AUTHENTICATION_FIELDS },
    { timeout: 30_000 },
  );
}

async function discoverNavigation(page: Page): Promise<TiaaNavigation> {
  const url = new URL(page.url());
  if (url.href !== TIAA_HOME_URL) {
    await page.goto(TIAA_HOME_URL, { waitUntil: 'commit', timeout: 30_000 });
  }
  const links = page.locator(
    'a[href*="participantdata/quickendownload"], a[href*="account-statements"]',
  );
  await links.first().waitFor({ state: 'attached', timeout: 30_000 }).catch(() => {
    throw new Error('TIAA navigation metadata did not load');
  });
  const destinations = await links.evaluateAll(elements => elements.map(element => ({
    href: (element as HTMLAnchorElement).href,
    activity: /participantdata\/quickendownload/i.test((element as HTMLAnchorElement).href),
    statements: /account-statements/i.test((element as HTMLAnchorElement).href),
  })));
  const activityUrl = destinations.find(destination => destination.activity)?.href;
  const statementsUrl = destinations.find(destination => destination.statements)?.href;
  if (!activityUrl || !statementsUrl) throw new Error('TIAA did not expose both supported artifact routes');
  return {
    activityUrl: validatedTiaaUrl(activityUrl, /participantdata\/quickendownload/i),
    statementsUrl: validatedTiaaUrl(statementsUrl, /account-statements/i),
  };
}

async function comboboxOptions(combobox: Locator, page: Page): Promise<Array<{ label: string; value: string }>> {
  const tagName = await combobox.evaluate(element => element.tagName);
  if (tagName === 'SELECT') {
    return combobox.locator('option').evaluateAll(options => options.map(option => ({
      label: (option.textContent ?? '').replace(/\s+/g, ' ').trim(),
      value: (option as HTMLOptionElement).value,
    })));
  }

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

async function selectComboboxOption(
  combobox: Locator,
  page: Page,
  option: { label: string; value: string },
): Promise<void> {
  const tagName = await combobox.evaluate(element => element.tagName);
  if (tagName === 'SELECT') {
    if (option.value) await combobox.selectOption(option.value);
    else await combobox.selectOption({ label: option.label });
    return;
  }
  await combobox.click();
  const target = page.getByRole('option', { name: option.label, exact: true });
  await target.waitFor({ state: 'visible', timeout: 30_000 });
  await target.click();
}

async function discoverActivityMetadata(
  page: Page,
  activityUrl: string,
  config: Pick<TiaaSyncConfig, 'from' | 'through'>,
): Promise<ActivityPageMetadata> {
  await page.goto(activityUrl, { waitUntil: 'commit', timeout: 30_000 });
  const downloadButton = page.getByRole('button', { name: /^Download$/i });
  await downloadButton.first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {
    throw new Error('TIAA activity download form did not load');
  });
  const combobox = page.getByRole('combobox').first();
  await combobox.waitFor({ state: 'attached', timeout: 30_000 });

  const rawAccounts = await page.evaluate(() => {
    const checkboxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    const textFor = (input: HTMLInputElement) => [
      ...Array.from(input.labels ?? []).map(label => label.textContent ?? ''),
      input.getAttribute('aria-label') ?? '',
      input.getAttribute('title') ?? '',
      input.name,
      input.value,
    ].join(' ').replace(/\s+/g, ' ').trim();
    const csv = checkboxes.find(input => /download to csv/i.test(textFor(input)));
    if (!csv?.form) throw new Error('TIAA CSV form control is unavailable');
    return checkboxes
      .filter(input => input.form === csv.form && input !== csv && !input.disabled)
      .filter(input => !/select all/i.test(textFor(input)))
      .map((input, ordinal) => ({
        id: input.id,
        name: input.name,
        value: input.value,
        label: textFor(input),
        ordinal,
      }));
  });
  if (rawAccounts.length === 0) throw new Error('TIAA activity download exposed no accounts');

  const accountsBySelection = new Map<string, DiscoveredActivityAccount>();
  for (const account of rawAccounts) {
    const selectionIdentity = `${account.name}\u0000${account.value}\u0000${account.id}`;
    if (accountsBySelection.has(selectionIdentity)) continue;
    accountsBySelection.set(selectionIdentity, {
      ...account,
      routingKey: routingKey(`${selectionIdentity}\u0000${account.label}`),
      identityTokens: accountIdentityTokens(account),
    });
  }
  const accounts = [...accountsBySelection.values()];
  if (new Set(accounts.map(account => account.routingKey)).size !== accounts.length) {
    throw new Error('TIAA account routing keys are ambiguous');
  }

  const currentYear = new Date().getFullYear();
  const periods = (await comboboxOptions(combobox, page))
    .map(option => tiaaActivityPeriod(option.label, option.value, currentYear))
    .filter((period): period is TiaaActivityPeriod => Boolean(period))
    .filter(period => dateIntersection(
      period.coveredFrom,
      period.coveredThrough,
      config.from,
      config.through,
    ));
  if (periods.length === 0) throw new Error('TIAA offers no activity period for the requested range');
  return { accounts, periods };
}

type ActivityFormSubmission = {
  action: string;
  method: string;
  enctype: string;
  entries: Array<[string, string]>;
};

async function activityFormSubmission(
  page: Page,
  account: DiscoveredActivityAccount,
  period: TiaaActivityPeriod,
): Promise<ActivityFormSubmission> {
  const combobox = page.getByRole('combobox').first();
  await selectComboboxOption(combobox, page, period);
  return page.evaluate(({ selectedAccount }) => {
    const checkboxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    const textFor = (input: HTMLInputElement) => [
      ...Array.from(input.labels ?? []).map(label => label.textContent ?? ''),
      input.getAttribute('aria-label') ?? '',
      input.getAttribute('title') ?? '',
      input.name,
      input.value,
    ].join(' ').replace(/\s+/g, ' ').trim();
    const csv = checkboxes.find(input => /download to csv/i.test(textFor(input)));
    if (!csv?.form) throw new Error('TIAA CSV form control is unavailable');
    const form = csv.form;
    const accountInputs = checkboxes
      .filter(input => input.form === form && input !== csv && !input.disabled)
      .filter(input => !/select all/i.test(textFor(input)));
    const matchingTargets = accountInputs.filter(input =>
      input.name === selectedAccount.name
      && input.value === selectedAccount.value
      && input.id === selectedAccount.id
    );
    if (matchingTargets.length !== 1) throw new Error('TIAA selected account control is unavailable or ambiguous');
    const target = matchingTargets[0]!;

    const entries: Array<[string, string]> = [];
    const add = (name: string, value: string) => {
      if (name) entries.push([name, value]);
    };
    for (const control of Array.from(form.elements)) {
      if (!(control instanceof HTMLElement) || !('name' in control) || control.hasAttribute('disabled')) continue;
      const name = String(control.name);
      if (!name) continue;
      if (control instanceof HTMLInputElement) {
        const type = control.type.toLowerCase();
        if (type === 'checkbox') {
          if (control === csv || control === target) add(name, control.value || 'on');
          else if (!accountInputs.includes(control) && control.checked) add(name, control.value || 'on');
        } else if (type === 'radio') {
          if (control.checked) add(name, control.value);
        } else if (!['button', 'file', 'image', 'reset', 'submit'].includes(type)) {
          add(name, control.value);
        }
      } else if (control instanceof HTMLSelectElement) {
        for (const option of Array.from(control.selectedOptions)) add(name, option.value);
      } else if (control instanceof HTMLTextAreaElement) {
        add(name, control.value);
      }
    }
    const submitter = Array.from(form.elements).find(control => {
      if (control instanceof HTMLButtonElement) return /^Download$/i.test((control.textContent ?? '').trim());
      return control instanceof HTMLInputElement
        && ['submit', 'button'].includes(control.type.toLowerCase())
        && /^Download$/i.test(control.value.trim());
    });
    if (submitter && 'name' in submitter && String(submitter.name)) {
      add(String(submitter.name), 'value' in submitter ? String(submitter.value) : '');
    }
    return {
      action: form.action,
      method: form.method.toUpperCase(),
      enctype: form.enctype.toLowerCase(),
      entries,
    };
  }, { selectedAccount: account });
}

export function tiaaFormRequest(
  action: string,
  method: string,
  enctype: string,
  entries: Array<[string, string]>,
): TiaaApiRequest {
  const url = new URL(validatedActivityAction(action));
  const params = new URLSearchParams(entries);
  if (method.toUpperCase() === 'GET') {
    for (const [name, value] of params) url.searchParams.append(name, value);
    return { url: url.toString(), method: 'GET' };
  }
  if (method.toUpperCase() !== 'POST') throw new Error('TIAA activity form uses an unsupported method');
  if (enctype && enctype !== 'application/x-www-form-urlencoded') {
    throw new Error('TIAA activity form uses an unsupported encoding');
  }
  return {
    url: url.toString(),
    method: 'POST',
    data: params.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
}

async function executeTiaaRequest(page: Page, request: TiaaApiRequest): Promise<APIResponse> {
  return page.context().request.fetch(request.url, {
    method: request.method,
    data: request.data,
    headers: {
      referer: page.url(),
      ...request.headers,
    },
  });
}

async function responseBody(response: APIResponse, kind: TiaaArtifactKind): Promise<Buffer> {
  if (!response.ok()) throw new Error(`TIAA ${kind.toUpperCase()} request failed with status ${response.status()}`);
  const contentType = response.headers()['content-type']?.toLowerCase() ?? '';
  const body = await response.body();
  if (body.length < (kind === 'pdf' ? 10_000 : 50)) {
    throw new Error(`TIAA ${kind.toUpperCase()} response was empty or too small`);
  }
  const signatureMatches = kind === 'pdf'
    ? body.subarray(0, 5).toString('ascii') === '%PDF-'
    : !body.includes(0) && body.toString('utf8', 0, 1_024).replace(/^\uFEFF/, '')
      .startsWith('Date,AccountId,Action,Security,Price,Quantity,Amount,Text,Memo,Commission');
  if (!signatureMatches) throw new Error(`TIAA ${kind.toUpperCase()} response had an unexpected signature`);
  if (/text\/html|application\/(?:json|xhtml\+xml)/.test(contentType)) {
    throw new Error(`TIAA ${kind.toUpperCase()} response had an unexpected content type`);
  }
  return body;
}

export function tiaaActivityAccountIds(text: string): string[] {
  const rows = parseCsvRows(text);
  const headerIndex = rows.findIndex(row => row[0]?.trim() === 'Date' && row.includes('AccountId'));
  if (headerIndex < 0) throw new Error('TIAA CSV header is missing');
  const accountIndex = rows[headerIndex]!.findIndex(value => value.trim() === 'AccountId');
  const ids = rows.slice(headerIndex + 1)
    .map(row => row[accountIndex]?.trim() ?? '')
    .filter(Boolean);
  return [...new Set(ids)];
}

export function assertTiaaActivityAccount(ids: string[]): string {
  if (ids.length !== 1) throw new Error('TIAA activity artifact does not identify exactly one remote account');
  return ids[0]!;
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
  const remoteAccountId = assertTiaaActivityAccount(tiaaActivityAccountIds(text));
  const parserAccountIds = [...new Set(parsed.transactions.map(transaction =>
    String(transaction.raw.accountId ?? '').trim()
  ).filter(Boolean))];
  if (parserAccountIds.length !== 1 || parserAccountIds[0] !== remoteAccountId) {
    throw new Error('TIAA parser account identity does not match the CSV artifact');
  }
  return {
    size: info.size,
    remoteAccountId,
    coveredFrom: parsed.covered_from ?? '',
    coveredThrough: parsed.covered_to ?? '',
  };
}

export async function validateTiaaStatementArtifact(
  path: string,
  logicalFileName = basename(path),
  parser: typeof parseTiaaStatement = parseTiaaStatement,
): Promise<StatementValidation> {
  const info = await stat(path);
  if (!info.isFile() || info.size < 10_000) throw new Error('TIAA PDF artifact is empty or too small');
  const bytes = await readFile(path);
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('TIAA PDF artifact has an unexpected signature');
  }
  if (!tiaaStatementMeta.matches({ filename: logicalFileName, sample: '' })) {
    throw new Error('EasyMoney did not recognize the TIAA PDF artifact');
  }
  const parsed = await parser(path);
  if (parsed.balances.length === 0) throw new Error('TIAA PDF parser found no balance');
  if (new Set(parsed.balances.map(balance => balance.account)).size !== 1) {
    throw new Error('TIAA PDF parser produced ambiguous account identities');
  }
  return {
    size: info.size,
    coveredFrom: parsed.covered_from ?? '',
    coveredThrough: parsed.covered_to ?? '',
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

function activityFileName(account: DiscoveredActivityAccount, period: TiaaActivityPeriod): string {
  return `tiaa-retirement-annuity-${period.year}-account-${account.routingKey}-${period.coveredFrom}-to-${period.coveredThrough}.csv`;
}

async function downloadActivityArtifact(
  page: Page,
  outputDir: string,
  account: DiscoveredActivityAccount,
  period: TiaaActivityPeriod,
): Promise<TiaaDownloadedArtifact> {
  const fileName = activityFileName(account, period);
  const existing = await existingValidatedArtifact({
    outputDir,
    fileName,
    validate: validateTiaaActivityArtifact,
  });
  const saved = existing ?? await (async () => {
    const submission = await activityFormSubmission(page, account, period);
    const request = tiaaFormRequest(
      submission.action,
      submission.method,
      submission.enctype,
      submission.entries,
    );
    const body = await responseBody(await executeTiaaRequest(page, request), 'csv');
    return writeValidatedArtifact({
      outputDir,
      fileName,
      body,
      validate: validateTiaaActivityArtifact,
    });
  })();
  return {
    fileName,
    path: saved.path,
    kind: 'csv',
    artifactType: 'activity',
    parserId: 'tiaa-activity-csv',
    account: { routingKey: account.routingKey, remoteAccountId: saved.validation.remoteAccountId },
    coveredFrom: saved.validation.coveredFrom || period.coveredFrom,
    coveredThrough: saved.validation.coveredThrough || period.coveredThrough,
    size: saved.validation.size,
    source: saved.source,
  };
}

function statementYearOptions(options: Array<{ label: string; value: string }>): Array<{ label: string; value: string; year: number }> {
  const years = new Map<number, { label: string; value: string; year: number }>();
  for (const option of options) {
    const year = option.label.match(/\b(20\d{2})\b/)?.[1];
    if (!year) continue;
    years.set(Number(year), { ...option, year: Number(year) });
  }
  return [...years.values()].sort((left, right) => right.year - left.year);
}

async function expandStatementRows(page: Page): Promise<void> {
  const accordion = page.getByRole('button', { name: /^Statements$/i }).first();
  await accordion.waitFor({ state: 'visible', timeout: 30_000 });
  if (await accordion.getAttribute('aria-expanded') !== 'true') await accordion.click();
}

async function waitForStatementYear(page: Page, year: number): Promise<void> {
  await Promise.race([
    page.locator('tr:visible').filter({ hasText: new RegExp(`\\b${year}\\b`) }).first()
      .waitFor({ state: 'visible', timeout: 30_000 }),
    page.getByText(/no (?:statements|documents)|nothing to display/i).first()
      .waitFor({ state: 'visible', timeout: 30_000 }),
  ]).catch(() => {
    throw new Error('TIAA statement rows did not finish loading');
  });
}

export function selectTiaaStatementAccount<T extends {
  routingKey: string;
  identityTokens: string[];
}>(accounts: T[], statementMetadata: string): T {
  if (accounts.length === 1) return accounts[0]!;
  const matches = accounts.filter(account => account.identityTokens.some(token => statementMetadata.includes(token)));
  if (matches.length !== 1) throw new Error('TIAA statement account association is ambiguous');
  return matches[0]!;
}

async function statementDocumentsForSelectedYear(
  page: Page,
  accounts: DiscoveredActivityAccount[],
  config: Pick<TiaaSyncConfig, 'from' | 'through'>,
): Promise<StatementDocument[]> {
  await expandStatementRows(page);
  const rows = page.locator('tr:visible');
  const texts = await rows.allTextContents();
  const documents: StatementDocument[] = [];
  for (const rowText of texts) {
    const period = tiaaStatementPeriod(rowText);
    if (!period || !dateIntersection(period.coveredFrom, period.coveredThrough, config.from, config.through)) continue;
    documents.push({
      ...period,
      rowText,
      account: selectTiaaStatementAccount(accounts, rowText),
    });
  }
  return documents;
}

async function statementDocumentUrl(page: Page, document: StatementDocument): Promise<string> {
  const rows = page.locator('tr:visible').filter({ hasText: document.label });
  const matchingRows: Locator[] = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    const candidate = rows.nth(index);
    if ((await candidate.textContent()) === document.rowText) matchingRows.push(candidate);
  }
  if (matchingRows.length !== 1) throw new Error('TIAA statement row is unavailable or ambiguous');
  const view = matchingRows[0]!.getByText('View', { exact: true });
  if (await view.count() !== 1) throw new Error('TIAA statement View control is unavailable');
  const href = await view.getAttribute('href')
    ?? await view.locator('xpath=ancestor-or-self::a[1]').getAttribute('href').catch(() => null);
  if (href) {
    const url = new URL(href, page.url());
    if (url.protocol !== 'https:') throw new Error('TIAA statement destination is not HTTPS');
    return url.toString();
  }

  const popupPromise = page.waitForEvent('popup', { timeout: 30_000 });
  await view.evaluate(element => (element as HTMLElement).click());
  const popup = await popupPromise;
  try {
    await popup.waitForURL(url => url.protocol === 'https:', { timeout: 30_000 });
    return popup.url();
  } finally {
    await popup.close().catch(() => {});
  }
}

function statementFileName(document: StatementDocument): string {
  return `tiaa-${document.coveredThrough}-retirement-q${document.quarter}-${document.year}-${document.account.routingKey}.pdf`;
}

async function downloadStatementArtifact(
  page: Page,
  outputDir: string,
  document: StatementDocument,
  remoteAccountIds: Map<string, string>,
): Promise<TiaaDownloadedArtifact> {
  const fileName = statementFileName(document);
  const existing = await existingValidatedArtifact({
    outputDir,
    fileName,
    validate: validateTiaaStatementArtifact,
  });
  const saved = existing ?? await (async () => {
    const url = await statementDocumentUrl(page, document);
    const response = await page.context().request.get(url, { headers: { referer: page.url() } });
    const body = await responseBody(response, 'pdf');
    return writeValidatedArtifact({
      outputDir,
      fileName,
      body,
      validate: validateTiaaStatementArtifact,
    });
  })();
  return {
    fileName,
    path: saved.path,
    kind: 'pdf',
    artifactType: 'statement',
    parserId: 'tiaa-statement-pdf',
    account: {
      routingKey: document.account.routingKey,
      remoteAccountId: remoteAccountIds.get(document.account.routingKey) ?? null,
    },
    coveredFrom: saved.validation.coveredFrom || document.coveredFrom,
    coveredThrough: saved.validation.coveredThrough || document.coveredThrough,
    size: saved.validation.size,
    source: saved.source,
  };
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

async function runAuthenticatedTiaa(
  page: Page,
  config: TiaaSyncConfig,
  progress: ReturnType<typeof createProgressTracker>,
): Promise<BrowserRunResult> {
  const requestedTypes = new Set(config.artifactTypes ?? ['activity', 'statement']);
  progress.complete('authentication', 'TIAA authentication is ready');

  progress.start('account-discovery', 'Discovering TIAA accounts and activity periods');
  const navigation = await discoverNavigation(page);
  const activityMetadata = await discoverActivityMetadata(page, navigation.activityUrl, config);
  progress.complete('account-discovery', 'TIAA account discovery is complete', {
    accounts: activityMetadata.accounts.length,
    activityPeriods: activityMetadata.periods.length,
  });

  const artifacts: TiaaDownloadedArtifact[] = [];
  const remoteAccountIds = new Map<string, string>();
  let emptyActivityExports = 0;
  if (requestedTypes.has('activity')) {
    const total = activityMetadata.accounts.length * activityMetadata.periods.length;
    progress.start('activity-downloads', 'Downloading TIAA activity artifacts', { total });
    let index = 0;
    for (const account of activityMetadata.accounts) {
      for (const period of activityMetadata.periods) {
        index += 1;
        progress.progress('activity-downloads', 'Downloading a TIAA activity artifact', { index, total });
        progress.start('validation', 'Validating a TIAA activity artifact', { index, total });
        try {
          const artifact = await downloadActivityArtifact(page, config.outputDir, account, period);
          const knownId = remoteAccountIds.get(account.routingKey);
          if (knownId && knownId !== artifact.account.remoteAccountId) {
            throw new Error('TIAA account identity changed across activity periods');
          }
          remoteAccountIds.set(account.routingKey, artifact.account.remoteAccountId!);
          artifacts.push(artifact);
          progress.complete('validation', 'TIAA activity artifact passed signature and parser validation', {
            index,
            total,
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
    }
    const duplicateIds = [...remoteAccountIds.values()].filter((value, index, all) => all.indexOf(value) !== index);
    if (duplicateIds.length > 0) throw new Error('Multiple TIAA selections resolved to the same remote account');
    progress.complete('activity-downloads', 'TIAA activity downloads are complete', {
      artifacts: artifacts.filter(artifact => artifact.artifactType === 'activity').length,
      empty: emptyActivityExports,
    });
  }

  let statementsDiscovered = 0;
  if (requestedTypes.has('statement')) {
    progress.start('statement-discovery', 'Discovering every offered TIAA statement year');
    await page.goto(navigation.statementsUrl, { waitUntil: 'commit', timeout: 30_000 });
    const yearCombobox = page.getByRole('combobox').first();
    await yearCombobox.waitFor({ state: 'attached', timeout: 30_000 });
    const years = statementYearOptions(await comboboxOptions(yearCombobox, page))
      .filter(option => String(option.year) >= config.from.slice(0, 4) && String(option.year) <= config.through.slice(0, 4));
    if (years.length === 0) throw new Error('TIAA offers no statement year for the requested range');
    progress.complete('statement-discovery', 'TIAA statement-year discovery is complete', { years: years.length });

    progress.start('statement-downloads', 'Downloading dynamically discovered TIAA statements');
    for (const year of years) {
      await selectComboboxOption(yearCombobox, page, year);
      await waitForStatementYear(page, year.year);
      const documents = await statementDocumentsForSelectedYear(page, activityMetadata.accounts, config);
      statementsDiscovered += documents.length;
      for (const document of documents) {
        const index = artifacts.filter(artifact => artifact.artifactType === 'statement').length + 1;
        progress.progress('statement-downloads', 'Downloading a TIAA statement artifact', { index });
        progress.start('validation', 'Validating a TIAA statement artifact', { index });
        artifacts.push(await downloadStatementArtifact(
          page,
          config.outputDir,
          document,
          remoteAccountIds,
        ));
        progress.complete('validation', 'TIAA statement passed signature and parser validation', { index });
      }
    }
    progress.complete('statement-downloads', 'TIAA statement downloads are complete', {
      discovered: statementsDiscovered,
      artifacts: artifacts.filter(artifact => artifact.artifactType === 'statement').length,
    });
  }

  return {
    artifacts,
    accountsDiscovered: activityMetadata.accounts.length,
    activityPeriodsDiscovered: activityMetadata.periods.length,
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

  const result = await runInstitutionBrowserProgram<BrowserRunResult>(
    { name: normalizedConfig.session!, startUrl: 'about:blank' },
    browserProgram,
    {
      completionDescription: 'TIAA downloads are complete and ready for review.',
      isAuthenticated: isTiaaAuthenticatedPage,
      waitUntilAuthenticated: waitUntilTiaaAuthenticated,
      onProgress: message => {
        if (/Authentication complete/i.test(message)) {
          progress.progress('authentication', 'TIAA login and MFA completed');
        }
      },
      programBindings: {
        isAuthenticated: isTiaaAuthenticatedPage,
        openHome: openTiaaHomeForAuthentication,
        run: (page: Page) => runAuthenticatedTiaa(page, normalizedConfig, progress),
        sanitizeError: sanitizedError,
      },
    },
  );
  if (result.status === 'login-required') {
    throw new Error(result.action ?? 'TIAA login is required');
  }
  if (result.status !== 'complete') throw new Error(result.message ?? 'TIAA sync did not complete');

  progress.start('complete', 'Finalizing TIAA artifact results');
  progress.complete('complete', 'TIAA artifacts are ready for preview', { artifacts: result.artifacts.length });
  return {
    artifacts: result.artifacts,
    accountsDiscovered: result.accountsDiscovered,
    activityPeriodsDiscovered: result.activityPeriodsDiscovered,
    statementsDiscovered: result.statementsDiscovered,
    emptyActivityExports: result.emptyActivityExports,
    timingsMs: { ...progress.timingsMs },
  };
}
