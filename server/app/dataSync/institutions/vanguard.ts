import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

import type { APIRequestContext, Locator, Page } from 'playwright';

import { vanguardActivityCsvParser } from '../../importParsers/vanguardActivityCsv.ts';
import { parseCsvRows } from '../../importParsers/csvRows.ts';
import { vanguardStatementParser } from '../../importParsers/vanguardStatement.ts';
import { runInstitutionBrowserProgram } from '../browserSession.ts';

const LOGIN_URL = 'https://investor.vanguard.com/my-account/log-on';
const TRANSACTION_HISTORY_URL = 'https://www.vanguard.com/en/investor/portfolio/transactions/history';
const STATEMENTS_URL = 'https://statements.web.vanguard.com/';
const AUTHENTICATED_PATH_PATTERN = '^/en/investor/portfolio(?:/|$)';
const AUTHENTICATION_REQUIRED = 'VANGUARD_AUTHENTICATION_REQUIRED';

const ALLOWED_ARTIFACT_HOSTS = new Set([
  'personal1.vanguard.com',
  'statements.web.vanguard.com',
  'transactions.web.vanguard.com',
]);

export type VanguardAccountKind = 'brokerage' | 'roth-ira' | 'traditional-ira';
export type VanguardArtifactType = 'activity' | 'statement';

export interface VanguardSyncAccount {
  accountId: number;
  accountKind: VanguardAccountKind;
  accountLast4: string;
  startDate: string;
  statementDates: string[];
}

export interface VanguardSyncProfile {
  id: string;
  session: string;
  accountHolder: string;
  accounts: VanguardSyncAccount[];
}

export interface VanguardSyncConfig {
  outputDir: string;
  through: string;
  profiles: VanguardSyncProfile[];
}

export interface VanguardArtifactIdentity {
  institution: 'vanguard';
  profileId: string;
  accountKind: VanguardAccountKind;
  accountLast4: string;
  artifactType: VanguardArtifactType;
}

export interface VanguardDownloadedArtifact extends VanguardArtifactIdentity {
  fileName: string;
  accountId: number;
}

export interface VanguardRemoteAccount {
  accountKind: VanguardAccountKind | null;
  accountLast4: string;
  controlIndex: number;
}

export interface VanguardMappedAccount {
  remote: VanguardRemoteAccount;
  planned: VanguardSyncAccount;
}

export interface VanguardApiRequest {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
}

export interface VanguardFormMetadata {
  action: string;
  method: string;
  fields: Array<[string, string]>;
}

type ArtifactFormat = 'csv' | 'pdf';
type VanguardProgressReporter = (message: string) => void;

interface ArtifactJob extends VanguardDownloadedArtifact {
  format: ArtifactFormat;
  targetPath: string;
  startDate?: string;
  statementDate?: string;
}

interface VanguardRemoteStatement {
  accountKind: VanguardAccountKind | null;
  accountLast4: string | null;
  statementDate: string;
  request: VanguardApiRequest;
}

interface VanguardProfileProgramResult {
  status: 'complete' | 'login-required' | 'error';
  saved?: string[];
  unavailable?: string[];
  accountCount?: number;
  action?: string;
  message?: string;
}

function isVanguardHost(hostname: string): boolean {
  return /(?:^|\.)vanguard\.com$/i.test(hostname);
}

function isVanguardLoginUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /^(?:login|logon)\.vanguard\.com$/i.test(url.hostname) ||
      /\/(?:login|logon|sign-in|authenticate|authorize)(?:\/|$)/i.test(url.pathname);
  } catch {
    return true;
  }
}

export function isVanguardAuthenticatedPath(pathname: string): boolean {
  return new RegExp(AUTHENTICATED_PATH_PATTERN, 'i').test(pathname);
}

export async function isVanguardAuthenticatedPage(page: Page): Promise<boolean> {
  const authenticationFields = await page.locator(
    'input[type="password"]:visible, input[autocomplete="username"]:visible',
  ).count() > 0;
  if (authenticationFields) return false;
  const url = new URL(page.url());
  if (isVanguardAuthenticatedPath(url.pathname)) return true;
  if (!isVanguardHost(url.hostname) || isVanguardLoginUrl(url.toString())) return false;
  return await page.getByRole('link', { name: /^Log off$/i }).count() > 0;
}

export async function waitUntilVanguardAuthenticated(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction((authenticatedPathPattern: string) => {
    const isVisible = (element: Element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    const hasAuthenticationFields = Array.from(document.querySelectorAll(
      'input[type="password"], input[autocomplete="username"]',
    )).some(isVisible);
    if (hasAuthenticationFields) return false;
    if (new RegExp(authenticatedPathPattern, 'i').test(location.pathname)) return true;
    if (!/(?:^|\.)vanguard\.com$/i.test(location.hostname)) return false;
    if (/^(?:login|logon)\.vanguard\.com$/i.test(location.hostname)) return false;
    return Array.from(document.querySelectorAll('a')).some(link =>
      /^Log off$/i.test(link.textContent?.trim() ?? '') && isVisible(link),
    );
  }, AUTHENTICATED_PATH_PATTERN, { timeout: timeoutMs });
}

export function vanguardThroughDate(requestedThrough: string, value = new Date()): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const localToday = `${year}-${month}-${day}`;
  return requestedThrough < localToday ? requestedThrough : localToday;
}

function accountLabel(kind: VanguardAccountKind): string {
  if (kind === 'roth-ira') return 'Roth-IRA';
  if (kind === 'traditional-ira') return 'Trad-IRA';
  return 'Brokerage';
}

function validateProfileLabel(value: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error('Vanguard profile labels must be PII-free kebab-case values');
  }
}

function validateIsoDate(value: string): void {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('Vanguard dates must use YYYY-MM-DD');
  }
}

export function vanguardAccountKindFromText(text: string): VanguardAccountKind | null {
  if (/roth/i.test(text) && /ira/i.test(text)) return 'roth-ira';
  if (/(?:traditional|trad\.?)/i.test(text) && /ira/i.test(text)) return 'traditional-ira';
  if (/brokerage|individual|joint|trust|custodial/i.test(text)) return 'brokerage';
  return null;
}

export function vanguardAccountLast4FromText(text: string): string | null {
  const match = text.match(
    /(?:ending\s+in|account(?:\s+number)?|[x*\u2022]{2,}|-{2,})\D{0,12}(\d{4})(?!\d)/i,
  );
  return match?.[1] ?? null;
}

export function parseVanguardRemoteAccount(text: string, controlIndex: number): VanguardRemoteAccount {
  const compact = text.replace(/\s+/g, ' ').trim();
  const fallback = compact.match(/(\d{4})(?!.*\d)/);
  const accountLast4 = vanguardAccountLast4FromText(compact) ?? fallback?.[1];
  if (!accountLast4) {
    throw new Error('A Vanguard remote account did not expose a usable account identity');
  }
  return {
    accountKind: vanguardAccountKindFromText(compact),
    accountLast4,
    controlIndex,
  };
}

export function mapVanguardRemoteAccounts(
  remoteAccounts: VanguardRemoteAccount[],
  plannedAccounts: VanguardSyncAccount[],
): VanguardMappedAccount[] {
  if (remoteAccounts.length === 0) {
    throw new Error('Vanguard did not expose any downloadable remote accounts');
  }
  const remoteIdentities = new Set<string>();
  for (const remote of remoteAccounts) {
    if (remoteIdentities.has(remote.accountLast4)) {
      throw new Error('Vanguard exposed ambiguous remote account identities');
    }
    remoteIdentities.add(remote.accountLast4);
  }
  const plannedIdentities = new Set<string>();
  for (const planned of plannedAccounts) {
    if (plannedIdentities.has(planned.accountLast4)) {
      throw new Error('Vanguard local account routing is ambiguous');
    }
    plannedIdentities.add(planned.accountLast4);
  }
  const mapped = remoteAccounts.map(remote => {
    const matches = plannedAccounts.filter(planned => planned.accountLast4 === remote.accountLast4);
    if (matches.length !== 1) {
      throw new Error('A Vanguard remote account has no unambiguous local account route');
    }
    const planned = matches[0]!;
    if (remote.accountKind && remote.accountKind !== planned.accountKind) {
      throw new Error('A Vanguard remote account conflicts with its planned local account kind');
    }
    return { remote, planned };
  });
  if (mapped.length !== plannedAccounts.length) {
    throw new Error('A planned Vanguard account was not present in the authenticated profile');
  }
  return mapped;
}

export function vanguardCsvAccountLast4s(text: string): string[] {
  const accountNumbers = parseCsvRows(text)
    .filter(row => row[0]?.trim().toLowerCase() !== 'account number')
    .map(row => row[0]?.replace(/\D/g, '') ?? '')
    .filter(value => value.length >= 4)
    .map(value => value.slice(-4));
  return [...new Set(accountNumbers)];
}

export function assertVanguardArtifactAccount(expectedLast4: string, actualLast4s: string[]): void {
  if (actualLast4s.length !== 1 || actualLast4s[0] !== expectedLast4) {
    throw new Error('Vanguard artifact does not match its planned EasyMoney account');
  }
}

async function validateCsv(path: string, expectedLast4: string): Promise<void> {
  const data = await readFile(path);
  if (data.includes(0)) throw new Error(`${basename(path)} contains binary NUL bytes`);
  const text = new TextDecoder().decode(data);
  if (!vanguardActivityCsvParser.matches({ fileName: basename(path), headers: [], sample: text })) {
    throw new Error(`${basename(path)} does not match EasyMoney's Vanguard activity parser`);
  }
  await vanguardActivityCsvParser.parse({
    fileName: basename(path),
    filePath: path,
    fileBytes: data,
    headers: [],
    rows: [],
    text,
  });
  assertVanguardArtifactAccount(expectedLast4, vanguardCsvAccountLast4s(text));
}

async function validatePdf(path: string, expectedLast4: string): Promise<void> {
  const data = await readFile(path);
  if (new TextDecoder().decode(data.subarray(0, 5)) !== '%PDF-') {
    throw new Error(`${basename(path)} does not have PDF magic`);
  }
  if (!vanguardStatementParser.matches({ fileName: basename(path), headers: [], sample: '' })) {
    throw new Error(`${basename(path)} does not match EasyMoney's Vanguard statement parser`);
  }
  const parsed = await vanguardStatementParser.parse({
    fileName: basename(path),
    filePath: path,
    fileBytes: data,
    headers: [],
    rows: [],
    text: '',
  });
  if (parsed.balances.length === 0) {
    throw new Error(`${basename(path)} has no Vanguard statement balance record`);
  }
  const accounts = [...parsed.transactions, ...parsed.balances]
    .map(record => record?.account)
    .filter((value): value is string => Boolean(value));
  const actualLast4s = [...new Set(accounts
    .map(account => account.match(/(\d{4})(?!.*\d)/)?.[1])
    .filter((value): value is string => Boolean(value)))];
  assertVanguardArtifactAccount(expectedLast4, actualLast4s);
}

export async function validateVanguardArtifact(
  path: string,
  format: ArtifactFormat,
  expectedLast4: string,
): Promise<void> {
  if (extname(path).toLowerCase() !== `.${format}`) {
    throw new Error(`${basename(path)} has the wrong extension`);
  }
  const info = await stat(path);
  const minimum = format === 'pdf' ? 10_000 : 100;
  if (!info.isFile() || info.size < minimum) {
    throw new Error(`${basename(path)} is smaller than the ${minimum}-byte minimum`);
  }
  if (format === 'pdf') await validatePdf(path, expectedLast4);
  else await validateCsv(path, expectedLast4);
}

async function isValid(path: string, format: ArtifactFormat, expectedLast4: string): Promise<boolean> {
  try {
    await validateVanguardArtifact(path, format, expectedLast4);
    return true;
  } catch {
    return false;
  }
}

export function vanguardActivityFileName(
  profileId: string,
  account: Pick<VanguardSyncAccount, 'accountKind' | 'accountLast4' | 'startDate'>,
  through: string,
): string {
  return `vanguard-${profileId}-${account.accountKind}-${account.startDate}-to-${through}-activity-${account.accountLast4}.csv`;
}

export function vanguardStatementFileName(
  profileId: string,
  account: Pick<VanguardSyncAccount, 'accountKind' | 'accountLast4'>,
  statementDate: string,
): string {
  return `${statementDate}-${accountLabel(account.accountKind)}-${account.accountLast4}---${profileId}.pdf`;
}

function jobsForProfile(config: VanguardSyncConfig, profile: VanguardSyncProfile): ArtifactJob[] {
  validateProfileLabel(profile.id);
  validateProfileLabel(profile.session);
  validateIsoDate(config.through);
  const jobs: ArtifactJob[] = [];
  for (const account of profile.accounts) {
    if (!Number.isInteger(account.accountId) || account.accountId < 1) {
      throw new Error('Vanguard accounts require a positive local account route');
    }
    if (!/^\d{4}$/.test(account.accountLast4)) {
      throw new Error('A Vanguard account is missing a usable last four digits');
    }
    validateIsoDate(account.startDate);
    const activityFileName = vanguardActivityFileName(profile.id, account, config.through);
    jobs.push({
      fileName: activityFileName,
      format: 'csv',
      targetPath: resolve(config.outputDir, activityFileName),
      accountId: account.accountId,
      institution: 'vanguard',
      profileId: profile.id,
      accountKind: account.accountKind,
      accountLast4: account.accountLast4,
      artifactType: 'activity',
      startDate: account.startDate,
    });
    for (const statementDate of [...new Set(account.statementDates)]) {
      validateIsoDate(statementDate);
      const fileName = vanguardStatementFileName(profile.id, account, statementDate);
      jobs.push({
        fileName,
        format: 'pdf',
        targetPath: resolve(config.outputDir, fileName),
        accountId: account.accountId,
        institution: 'vanguard',
        profileId: profile.id,
        accountKind: account.accountKind,
        accountLast4: account.accountLast4,
        artifactType: 'statement',
        statementDate,
      });
    }
  }
  return jobs;
}

function validatedArtifactUrl(value: string, baseUrl: string): string {
  const url = new URL(value, baseUrl);
  if (url.protocol !== 'https:' || !ALLOWED_ARTIFACT_HOSTS.has(url.hostname)) {
    throw new Error('Vanguard artifact API destination is outside the allowed institution hosts');
  }
  if (url.username || url.password || url.hash || isVanguardLoginUrl(url.toString())) {
    throw new Error('Vanguard artifact API destination is invalid');
  }
  if (!/(?:download|export|statement|document|transaction|open-fin-exchange|ofx)/i.test(url.pathname)) {
    throw new Error('Vanguard artifact API destination is not a verified artifact path');
  }
  return url.toString();
}

export function vanguardApiRequestFromForm(
  metadata: VanguardFormMetadata,
  baseUrl: string,
): VanguardApiRequest {
  const method = metadata.method.trim().toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    throw new Error('Vanguard artifact form uses an unsupported HTTP method');
  }
  const url = new URL(validatedArtifactUrl(metadata.action || baseUrl, baseUrl));
  const fields = new URLSearchParams(metadata.fields);
  if (method === 'GET') {
    for (const [name, value] of fields) url.searchParams.append(name, value);
    return { url: url.toString(), method };
  }
  return {
    url: url.toString(),
    method,
    body: fields.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
}

function vanguardGetRequest(value: string, baseUrl: string): VanguardApiRequest {
  return { url: validatedArtifactUrl(value, baseUrl), method: 'GET' };
}

function vanguardAuthenticationResponse(value: string): boolean {
  try {
    const url = new URL(value);
    return isVanguardLoginUrl(url.toString()) || !isVanguardHost(url.hostname);
  } catch {
    return true;
  }
}

async function saveVanguardArtifact(
  requestContext: APIRequestContext,
  request: VanguardApiRequest,
  job: ArtifactJob,
): Promise<void> {
  const response = await requestContext.fetch(request.url, {
    method: request.method,
    ...(request.body ? { data: request.body } : {}),
    ...(request.headers ? { headers: request.headers } : {}),
  });
  if (vanguardAuthenticationResponse(response.url()) || response.status() === 401 || response.status() === 403) {
    throw new Error(AUTHENTICATION_REQUIRED);
  }
  if (!response.ok()) {
    throw new Error(`Vanguard ${job.format.toUpperCase()} request failed with status ${response.status()}`);
  }
  const contentType = response.headers()['content-type']?.toLowerCase() ?? '';
  const validContentType = job.format === 'pdf'
    ? contentType.includes('pdf') || contentType.includes('octet-stream')
    : contentType.includes('csv') || contentType.includes('excel') ||
      contentType.includes('text/plain') || contentType.includes('octet-stream');
  if (!validContentType) {
    if (contentType.includes('html')) throw new Error(AUTHENTICATION_REQUIRED);
    throw new Error(`Vanguard ${job.format.toUpperCase()} response has an unexpected content type`);
  }
  await writeFile(job.targetPath, await response.body());
  try {
    await validateVanguardArtifact(job.targetPath, job.format, job.accountLast4);
  } catch (error) {
    await rm(job.targetPath, { force: true });
    throw error;
  }
}

function accountRow(control: Locator): Locator {
  return control.locator(
    'xpath=ancestor::*[self::tr or @role="row" or contains(@class,"account")][1]',
  );
}

async function ensureVanguardActivityForm(page: Page): Promise<boolean> {
  const dateRange = page.locator('select[name="downloadDateOption"]:visible').first();
  if (await dateRange.count() > 0) return true;
  if (!new URL(page.url()).pathname.includes('/portfolio/transactions/history')) {
    await page.goto(TRANSACTION_HISTORY_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
  if (isVanguardLoginUrl(page.url())) return false;
  if (await dateRange.count() === 0) {
    const downloadControl = page
      .getByRole('link', { name: /^Download center$/i })
      .or(page.getByRole('button', { name: /^Download(?: transactions| activity)?$/i }))
      .first();
    await downloadControl.waitFor({ state: 'visible', timeout: 30_000 });
    await downloadControl.click();
  }
  await dateRange.waitFor({ state: 'visible', timeout: 30_000 });
  return true;
}

export async function discoverVanguardAccounts(page: Page): Promise<VanguardRemoteAccount[]> {
  const controls = page.locator('input[name="check-box"]');
  await controls.first().waitFor({ state: 'attached', timeout: 30_000 }).catch(() => {
    throw new Error('Vanguard download accounts are unavailable');
  });
  const accounts: VanguardRemoteAccount[] = [];
  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index);
    const id = await control.getAttribute('id');
    const label = id ? page.locator(`label[for=${JSON.stringify(id)}]`) : null;
    const text = [
      await accountRow(control).textContent().catch(() => ''),
      label ? await label.textContent().catch(() => '') : '',
    ].filter(Boolean).join(' ');
    accounts.push(parseVanguardRemoteAccount(text, index));
  }
  return accounts;
}

async function csvFormatControl(page: Page): Promise<Locator> {
  const radios = page.locator('input[name="download-option"]');
  await radios.first().waitFor({ state: 'attached', timeout: 30_000 });
  for (let index = 0; index < await radios.count(); index += 1) {
    const radio = radios.nth(index);
    const id = await radio.getAttribute('id');
    const label = id ? await page.locator(`label[for=${JSON.stringify(id)}]`).textContent() : '';
    if (/csv/i.test(label ?? '')) return radio;
  }
  throw new Error('Vanguard CSV export is unavailable');
}

async function activityRequestForAccount(
  page: Page,
  account: VanguardRemoteAccount,
  from: string,
  through: string,
): Promise<VanguardApiRequest> {
  const controls = page.locator('input[name="check-box"]');
  for (let index = 0; index < await controls.count(); index += 1) {
    await controls.nth(index).setChecked(index === account.controlIndex);
  }
  await (await csvFormatControl(page)).setChecked(true);

  const dateRange = page.locator('select[name="downloadDateOption"]:visible').first();
  const customValue = await dateRange.locator('option').evaluateAll(options => {
    const custom = options.find(option => /^custom$/i.test(option.textContent?.trim() ?? ''));
    return custom?.getAttribute('value') ?? null;
  });
  if (customValue === null) throw new Error('Vanguard custom activity date range is unavailable');
  await dateRange.selectOption(customValue);
  await page.locator('input[name="fromDatePicker"]:visible').fill(from);
  await page.locator('input[name="toDatePicker"]:visible').fill(through);

  const button = page.getByRole('button', { name: /^download$/i }).last();
  await button.waitFor({ state: 'visible', timeout: 30_000 });
  const buttonHandle = await button.elementHandle();
  if (!buttonHandle) throw new Error('Vanguard activity download button is unavailable');
  await page.waitForFunction((element: Element) => {
    const buttonElement = element as HTMLButtonElement;
    return !buttonElement.disabled && buttonElement.getAttribute('aria-disabled') !== 'true';
  }, buttonHandle, { timeout: 30_000 });

  const form = button.locator('xpath=ancestor::form[1]');
  if (await form.count() !== 1) throw new Error('Vanguard activity API form is unavailable');
  const metadata = await form.evaluate((element): VanguardFormMetadata => {
    const formElement = element as HTMLFormElement;
    const fields: Array<[string, string]> = [];
    for (const [name, value] of new FormData(formElement).entries()) {
      if (typeof value !== 'string') throw new Error('Vanguard activity form included a file upload');
      fields.push([name, value]);
    }
    return { action: formElement.action, method: formElement.method, fields };
  });
  return vanguardApiRequestFromForm(metadata, page.url());
}

function statementDateFromText(text: string): string | null {
  const numeric = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (numeric) {
    return `${numeric[3]}-${numeric[1]!.padStart(2, '0')}-${numeric[2]!.padStart(2, '0')}`;
  }
  const named = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/i,
  );
  if (!named) return null;
  const month = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ].indexOf(named[1]!.toLowerCase()) + 1;
  return `${named[3]}-${String(month).padStart(2, '0')}-${named[2]!.padStart(2, '0')}`;
}

async function statementRequestFromRow(row: Locator, baseUrl: string): Promise<VanguardApiRequest> {
  const icon = row.locator('c11n-icon[name="download"]');
  if (await icon.count() !== 1) throw new Error('Vanguard statement download metadata is unavailable');
  const anchor = icon.locator('xpath=ancestor::a[@href][1]');
  if (await anchor.count() === 1) {
    const href = await anchor.getAttribute('href');
    if (href) return vanguardGetRequest(href, baseUrl);
  }
  const form = icon.locator('xpath=ancestor::form[1]');
  if (await form.count() === 1) {
    const metadata = await form.evaluate((element): VanguardFormMetadata => {
      const formElement = element as HTMLFormElement;
      const fields: Array<[string, string]> = [];
      for (const [name, value] of new FormData(formElement).entries()) {
        if (typeof value !== 'string') throw new Error('Vanguard statement form included a file upload');
        fields.push([name, value]);
      }
      return { action: formElement.action, method: formElement.method, fields };
    });
    return vanguardApiRequestFromForm(metadata, baseUrl);
  }
  const dataUrl = await icon.evaluate(element => {
    const candidates = [element, element.parentElement, element.parentElement?.parentElement]
      .filter((value): value is HTMLElement | SVGElement => value !== null && value !== undefined);
    for (const candidate of candidates) {
      for (const attribute of Array.from(candidate.attributes)) {
        if (/(?:href|url|download)/i.test(attribute.name) && attribute.value) return attribute.value;
      }
    }
    return null;
  });
  if (dataUrl) return vanguardGetRequest(dataUrl, baseUrl);
  throw new Error('Vanguard statement API request metadata is unavailable');
}

async function selectStatementYear(page: Page, year: string): Promise<boolean> {
  const yearSelect = page.locator('#select-year-id:visible').first();
  await yearSelect.waitFor({ state: 'visible', timeout: 30_000 });
  const optionValue = await yearSelect.locator('option').evaluateAll((options, expectedYear) => {
    const option = options.find(candidate =>
      candidate.getAttribute('value') === expectedYear || candidate.textContent?.trim() === expectedYear,
    );
    return option?.getAttribute('value') ?? null;
  }, year);
  if (optionValue === null) return false;
  const previous = await page.locator('tbody tr').evaluateAll(rows =>
    rows.map(row => row.textContent?.replace(/\s+/g, ' ').trim() ?? '').join('\n'),
  );
  if (await yearSelect.inputValue() !== optionValue) {
    await yearSelect.selectOption(optionValue);
    await page.waitForFunction(({ expectedYear, previousRows }) => {
      const select = document.querySelector('#select-year-id') as HTMLSelectElement | null;
      const rows = Array.from(document.querySelectorAll('tbody tr'));
      const text = rows.map(row => row.textContent?.replace(/\s+/g, ' ').trim() ?? '').join('\n');
      const selected = select?.selectedOptions[0];
      const selectedYear = selected?.value === expectedYear || selected?.textContent?.trim() === expectedYear;
      return Boolean(selectedYear && rows.length > 0 && text !== previousRows && text.includes(expectedYear));
    }, { expectedYear: year, previousRows: previous }, { timeout: 30_000 });
  }
  await page.locator('tbody tr').first().waitFor({ state: 'attached', timeout: 30_000 });
  return true;
}

async function discoverVanguardStatements(
  page: Page,
  years: string[],
  plannedAccounts: VanguardSyncAccount[],
): Promise<VanguardRemoteStatement[]> {
  const statements: VanguardRemoteStatement[] = [];
  for (const year of years) {
    if (!await selectStatementYear(page, year)) continue;
    const rows = page.locator('tbody tr');
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      if (await row.locator('c11n-icon[name="download"]').count() !== 1) continue;
      const text = (await row.textContent() ?? '').replace(/\s+/g, ' ').trim();
      const statementDate = statementDateFromText(text);
      if (!statementDate || !statementDate.startsWith(`${year}-`)) continue;
      const last4 = vanguardAccountLast4FromText(text);
      const kind = vanguardAccountKindFromText(text);
      let accountLast4 = last4;
      if (!accountLast4 && kind) {
        const matches = plannedAccounts.filter(account => account.accountKind === kind);
        if (matches.length > 1) {
          throw new Error('Vanguard statement metadata is ambiguous across local accounts');
        }
        accountLast4 = matches[0]?.accountLast4 ?? null;
      }
      statements.push({
        accountKind: kind,
        accountLast4,
        statementDate,
        request: await statementRequestFromRow(row, page.url()),
      });
    }
  }
  return statements;
}

function statementForJob(
  job: ArtifactJob,
  statements: VanguardRemoteStatement[],
): VanguardRemoteStatement | null {
  const exact = statements.filter(statement =>
    statement.statementDate === job.statementDate && statement.accountLast4 === job.accountLast4,
  );
  if (exact.length > 1) throw new Error('Multiple Vanguard statement artifacts matched one local account');
  if (exact.length === 1) return exact[0]!;
  const kindMatches = statements.filter(statement =>
    statement.statementDate === job.statementDate &&
    statement.accountLast4 === null &&
    statement.accountKind === job.accountKind,
  );
  if (kindMatches.length > 1) throw new Error('Vanguard statement artifact routing is ambiguous');
  return kindMatches[0] ?? null;
}

function safeVanguardError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/https?:\/\/\S+/g, '<redacted-url>')
    .replace(/\b[a-f0-9]{16,}\b/gi, '<redacted-id>')
    .replace(/\b\d{4,}\b/g, '<digits>');
}

async function executeVanguardProfile(
  page: Page,
  profile: VanguardSyncProfile,
  pending: ArtifactJob[],
  through: string,
  reportProgress: VanguardProgressReporter,
): Promise<VanguardProfileProgramResult> {
  const report = (message: string) => reportProgress(`Vanguard ${profile.id}: ${message}`);
  try {
    if (!await isVanguardAuthenticatedPage(page)) {
      return {
        status: 'login-required',
        action: 'Sign in to Vanguard and complete MFA. EasyMoney will continue automatically.',
      };
    }
    report('authenticated cached profile');
    report('opening activity metadata');
    if (!await ensureVanguardActivityForm(page)) {
      return {
        status: 'login-required',
        action: 'Sign in to Vanguard and complete MFA. EasyMoney will continue automatically.',
      };
    }

    report('discovering remote accounts');
    const remoteAccounts = await discoverVanguardAccounts(page);
    const mappedAccounts = mapVanguardRemoteAccounts(remoteAccounts, profile.accounts);
    report(`discovered ${mappedAccounts.length} remote account${mappedAccounts.length === 1 ? '' : 's'}`);

    const saved: string[] = [];
    const unavailable: string[] = [];
    const activityJobs = pending.filter(job => job.artifactType === 'activity');
    for (let index = 0; index < activityJobs.length; index += 1) {
      const job = activityJobs[index]!;
      const mapped = mappedAccounts.find(account => account.planned.accountId === job.accountId);
      if (!mapped) throw new Error('Vanguard activity routing changed after remote discovery');
      report(`preparing activity API request ${index + 1} of ${activityJobs.length}`);
      const request = await activityRequestForAccount(page, mapped.remote, job.startDate!, through);
      report(`downloading activity ${index + 1} of ${activityJobs.length}`);
      await saveVanguardArtifact(page.context().request, request, job);
      report(`validated activity ${index + 1} of ${activityJobs.length}`);
      saved.push(job.fileName);
    }

    const statementJobs = pending.filter(job => job.artifactType === 'statement');
    if (statementJobs.length > 0) {
      report('opening statement metadata');
      await page.goto(STATEMENTS_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      if (isVanguardLoginUrl(page.url())) {
        return {
          status: 'login-required',
          action: 'Sign in to Vanguard and complete MFA. EasyMoney will continue automatically.',
        };
      }
      const years = [...new Set(statementJobs.map(job => job.statementDate!.slice(0, 4)))].sort();
      report(`discovering statements across ${years.length} year${years.length === 1 ? '' : 's'}`);
      const statements = await discoverVanguardStatements(page, years, profile.accounts);
      report(`discovered ${statements.length} statement artifact${statements.length === 1 ? '' : 's'}`);
      for (let index = 0; index < statementJobs.length; index += 1) {
        const job = statementJobs[index]!;
        const statement = statementForJob(job, statements);
        if (!statement) {
          unavailable.push(job.fileName);
          continue;
        }
        report(`downloading statement ${index + 1} of ${statementJobs.length}`);
        await saveVanguardArtifact(page.context().request, statement.request, job);
        report(`validated statement ${index + 1} of ${statementJobs.length}`);
        saved.push(job.fileName);
      }
      if (unavailable.length > 0) {
        report(`${unavailable.length} requested statement artifact${unavailable.length === 1 ? ' was' : 's were'} unavailable`);
      }
    }

    report(`completed with ${saved.length} validated artifact${saved.length === 1 ? '' : 's'}`);
    return {
      status: 'complete',
      saved,
      unavailable,
      accountCount: mappedAccounts.length,
    };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (message.includes(AUTHENTICATION_REQUIRED) || isVanguardLoginUrl(page.url())) {
      return {
        status: 'login-required',
        action: 'Sign in to Vanguard and complete MFA. EasyMoney will continue automatically.',
      };
    }
    return { status: 'error', message: safeVanguardError(error) };
  }
}

function browserProgram(): string {
  return `async (page, reportProgress, bindings) => JSON.stringify(
    await bindings.execute(page, reportProgress)
  )`;
}

async function runProfile(
  config: VanguardSyncConfig,
  profile: VanguardSyncProfile,
  onProgress: VanguardProgressReporter,
): Promise<VanguardDownloadedArtifact[]> {
  const jobs = jobsForProfile(config, profile);
  const pending: ArtifactJob[] = [];
  for (const job of jobs) {
    if (!await isValid(job.targetPath, job.format, job.accountLast4)) pending.push(job);
  }
  if (pending.length === 0) {
    onProgress(`Vanguard ${profile.id}: no missing artifacts`);
    return [];
  }

  const result = await runInstitutionBrowserProgram<{
    saved: string[];
    unavailable: string[];
    accountCount: number;
  }>(
    { name: profile.session, startUrl: LOGIN_URL },
    browserProgram(),
    {
      completionDescription: `Vanguard ${profile.id} downloads are complete.`,
      isAuthenticated: isVanguardAuthenticatedPage,
      waitUntilAuthenticated: waitUntilVanguardAuthenticated,
      onProgress,
      programBindings: {
        execute: (page: Page, reportProgress: VanguardProgressReporter) =>
          executeVanguardProfile(page, profile, pending, config.through, reportProgress),
      },
    },
  );
  if (result.status === 'login-required') {
    throw new Error(`Vanguard ${profile.id}: interactive login is required`);
  }
  if (result.status !== 'complete') {
    throw new Error(`Vanguard ${profile.id}: ${result.message ?? 'sync failed'}`);
  }

  const byName = new Map(jobs.map(job => [job.fileName, job]));
  const downloaded: VanguardDownloadedArtifact[] = [];
  for (const fileName of result.saved ?? []) {
    const job = byName.get(fileName);
    if (!job) throw new Error(`Vanguard ${profile.id}: an unplanned artifact was returned`);
    await validateVanguardArtifact(job.targetPath, job.format, job.accountLast4);
    downloaded.push({
      fileName: job.fileName,
      accountId: job.accountId,
      institution: job.institution,
      profileId: job.profileId,
      accountKind: job.accountKind,
      accountLast4: job.accountLast4,
      artifactType: job.artifactType,
    });
  }
  return downloaded;
}

export async function runVanguardProfilesConcurrently<T>(
  profiles: readonly VanguardSyncProfile[],
  run: (profile: VanguardSyncProfile) => Promise<T>,
): Promise<T[]> {
  return Promise.all(profiles.map(profile => run(profile)));
}

export async function runVanguardSync(
  config: VanguardSyncConfig,
  onProgress: VanguardProgressReporter = () => {},
): Promise<VanguardDownloadedArtifact[]> {
  const normalizedConfig = {
    ...config,
    through: vanguardThroughDate(config.through),
  };
  validateIsoDate(normalizedConfig.through);
  await mkdir(normalizedConfig.outputDir, { recursive: true });
  onProgress(
    `Vanguard: starting ${normalizedConfig.profiles.length} cached profile${normalizedConfig.profiles.length === 1 ? '' : 's'}`,
  );
  const results = await runVanguardProfilesConcurrently(
    normalizedConfig.profiles,
    profile => runProfile(normalizedConfig, profile, onProgress),
  );
  const artifacts = results.flat();
  onProgress(`Vanguard: completed with ${artifacts.length} validated artifact${artifacts.length === 1 ? '' : 's'}`);
  return artifacts;
}
