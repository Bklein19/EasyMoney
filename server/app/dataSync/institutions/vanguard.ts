import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

import type { Page } from 'playwright';

import { vanguardActivityCsvParser } from '../../importParsers/vanguardActivityCsv.ts';
import { parseCsvRows } from '../../importParsers/csvRows.ts';
import { vanguardStatementParser } from '../../importParsers/vanguardStatement.ts';
import {
  playwrightAuthStatePath,
  playwrightHasSavedAuthentication,
  playwrightProfilePath,
  playwrightSessionStoragePath,
  runInstitutionBrowserProgram,
} from '../browserSession.ts';

const LOGIN_URL = 'https://investor.vanguard.com/my-account/log-on';
const STATEMENTS_URL = 'https://statements.web.vanguard.com/';
const ACCOUNTS_API_URL = 'https://personal1.vanguard.com/ofu-open-fin-exchange-webapp/ofu-accounts';
const ACTIVITY_API_URL =
  'https://personal1.vanguard.com/ofu-open-fin-exchange-webapp/ofu-accounts-transactions';
const ACTIVITY_REFERER_URL =
  'https://personal1.vanguard.com/ofu-open-fin-exchange-webapp/ofx-welcome';
const STATEMENTS_API_URL =
  'https://personal1.vanguard.com/usa/api/lah-statements-consumer/statements/consumer';
const STATEMENT_PDF_API_URL =
  'https://personal1.vanguard.com/usa/api/lah-statements-consumer/statements/pdf';
const AUTHENTICATED_PATH_PATTERN = '^/en/investor/portfolio(?:/|$)';
const AUTHENTICATION_REQUIRED = 'VANGUARD_AUTHENTICATION_REQUIRED';
const AUTHENTICATION_FIELD_SELECTOR = [
  'input[type="password"]:visible',
  'input[autocomplete="username"]:visible',
].join(', ');

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
  apiAccount: VanguardAccountApiRecord;
}

export interface VanguardAccountApiRecord {
  accountId: string;
  accountName: string;
  balance: string;
  fundAccountNumber: string;
  fundName: string;
  isManaged: boolean;
  nickname: string;
  productType: string;
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

export interface VanguardBrowserApiResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  bodyBase64: string;
  redirected: boolean;
}

export type VanguardProgressPhase =
  | 'sync'
  | 'authentication'
  | 'discovery'
  | 'activity-request'
  | 'activity-download'
  | 'statement-discovery'
  | 'statement-download';

export interface VanguardProgressEvent {
  profileId?: string;
  phase: VanguardProgressPhase;
  state: 'start' | 'waiting' | 'complete' | 'error';
  timestamp: string;
  message: string;
  elapsedMs?: number;
  data?: Record<string, number | string | boolean>;
}

export type VanguardProgressReporter = (event: VanguardProgressEvent) => void;

type ArtifactFormat = 'csv' | 'pdf';
type VanguardProgress = ReturnType<typeof createVanguardProgress>;

interface ArtifactJob extends VanguardDownloadedArtifact {
  format: ArtifactFormat;
  targetPath: string;
  startDate?: string;
  statementDate?: string;
  validationAccountLast4s?: string[];
}

export interface VanguardRemoteStatement {
  accountKind: VanguardAccountKind;
  accountLast4: string;
  validationAccountLast4s: string[];
  statementDate: string;
  request: VanguardApiRequest;
}

export interface VanguardStatementAccountRoute {
  account: VanguardSyncAccount;
  identityLast4s: string[];
}

interface VanguardProfileProgramResult {
  status: 'complete' | 'login-required' | 'error';
  saved?: string[];
  unavailable?: string[];
  accountCount?: number;
  action?: string;
  message?: string;
}

export function createVanguardProgress(
  onProgress: VanguardProgressReporter,
  profileId?: string,
  clock: () => number = () => performance.now(),
  timestamp: () => string = () => new Date().toISOString(),
) {
  const started = new Map<string, number>();
  return (
    key: string,
    phase: VanguardProgressPhase,
    state: VanguardProgressEvent['state'],
    message: string,
    data?: Record<string, number | string | boolean>,
  ): void => {
    const now = clock();
    if (state === 'start') started.set(key, now);
    const began = started.get(key);
    onProgress({
      ...(profileId ? { profileId } : {}),
      phase,
      state,
      timestamp: timestamp(),
      message,
      ...((state === 'complete' || state === 'error') && began !== undefined
        ? { elapsedMs: Math.round(now - began) }
        : {}),
      ...(data ? { data } : {}),
    });
  };
}

function isVanguardHost(hostname: string): boolean {
  return /(?:^|\.)vanguard\.com$/i.test(hostname);
}

function isVanguardLoginUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /^(?:login|log[-_]?on)\.vanguard\.com$/i.test(url.hostname) ||
      /\/(?:login|log[-_]?on|sign[-_]?in|authenticate|authorize)(?:\/|$)/i.test(url.pathname);
  } catch {
    return true;
  }
}

export function isVanguardAuthenticatedPath(pathname: string): boolean {
  return new RegExp(AUTHENTICATED_PATH_PATTERN, 'i').test(pathname);
}

export async function isVanguardAuthenticatedPage(page: Page): Promise<boolean> {
  const authenticationFields = await page.locator(AUTHENTICATION_FIELD_SELECTOR).count() > 0;
  if (authenticationFields) return false;
  const url = new URL(page.url());
  if (isVanguardAuthenticatedPath(url.pathname)) return true;
  if (!isVanguardHost(url.hostname) || isVanguardLoginUrl(url.toString())) return false;
  return await page.getByRole('link', { name: /^Log off$/i }).count() > 0;
}

async function prepareVanguardInteractiveAuthentication(
  page: Page,
  profile: Pick<VanguardSyncProfile, 'session'> & { profilePath?: string },
): Promise<void> {
  validateProfileLabel(profile.session);
  const profilePath = resolve(profile.profilePath ?? playwrightProfilePath(profile.session));
  await Promise.all([
    rm(playwrightAuthStatePath(profilePath), { force: true }),
    rm(playwrightSessionStoragePath(profilePath), { force: true }),
  ]);
  await page.context().clearCookies();
  try {
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  } catch {
    // Cookie removal is authoritative; storage may be inaccessible during navigation.
  }
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  const hasAuthenticationFields = await page.locator(AUTHENTICATION_FIELD_SELECTOR).count() > 0;
  if (!isVanguardLoginUrl(page.url()) && !hasAuthenticationFields) {
    throw new Error('Vanguard did not open a fresh sign-in page after authentication expired');
  }
}

export async function transitionVanguardToInteractiveAuthentication(
  page: Page,
  profile: Pick<VanguardSyncProfile, 'session' | 'accountHolder'> & { profilePath?: string },
): Promise<{ status: 'login-required'; action: string }> {
  await prepareVanguardInteractiveAuthentication(page, profile);
  return {
    status: 'login-required',
    action: vanguardAuthenticationAction(profile),
  };
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

export function vanguardAuthenticationAction(
  profile: Pick<VanguardSyncProfile, 'accountHolder'>,
): string {
  const accountHolder = profile.accountHolder.trim();
  if (!accountHolder) throw new Error('Vanguard login profiles require an account holder');
  return `Sign in to Vanguard for ${accountHolder} and complete MFA. EasyMoney will continue automatically.`;
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
  if (/\bira\b/i.test(text)) return 'traditional-ira';
  if (/brokerage|individual|joint|trust|custodial/i.test(text)) return 'brokerage';
  return null;
}

export function vanguardAccountLast4FromText(text: string): string | null {
  const match = text.match(
    /(?:ending\s+in|account(?:\s+number)?|[x*\u2022]{2,}|-{2,})\D{0,12}(\d{4})(?!\d)/i,
  );
  return match?.[1] ?? null;
}

function apiString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

export function parseVanguardAccountApiResponse(value: unknown): VanguardRemoteAccount[] {
  if (!value || typeof value !== 'object' || !('accounts' in value) ||
      !Array.isArray(value.accounts)) {
    throw new Error('Vanguard account API returned an invalid account collection');
  }
  const accounts = value.accounts.map((record, index) => {
    if (!record || typeof record !== 'object') {
      throw new Error(`Vanguard account API record ${index + 1} is invalid`);
    }
    const apiRecord = record as Record<string, unknown>;
    const apiAccount: VanguardAccountApiRecord = {
      accountId: apiString(apiRecord, 'accountId'),
      accountName: apiString(apiRecord, 'accountName'),
      balance: apiString(apiRecord, 'balance'),
      fundAccountNumber: apiString(apiRecord, 'fundAccountNumber'),
      fundName: apiString(apiRecord, 'fundName'),
      isManaged: typeof apiRecord.isManaged === 'boolean' ? apiRecord.isManaged : false,
      nickname: apiString(apiRecord, 'nickname'),
      productType: apiString(apiRecord, 'productType'),
    };
    const accountNumber = apiAccount.fundAccountNumber.replace(/\D/g, '');
    if (accountNumber.length < 4 || !apiAccount.accountId || !apiAccount.accountName) {
      throw new Error(`Vanguard account API record ${index + 1} has no usable identity`);
    }
    return {
      accountKind: vanguardAccountKindFromText([
        apiAccount.accountName,
        apiAccount.nickname,
        apiAccount.productType,
      ].join(' ')),
      accountLast4: accountNumber.slice(-4),
      apiAccount,
    };
  });
  const last4s = new Set<string>();
  for (const account of accounts) {
    if (last4s.has(account.accountLast4)) {
      throw new Error('Vanguard account API returned ambiguous account identities');
    }
    last4s.add(account.accountLast4);
  }
  return accounts;
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
  const plannedForRemote = new Map<VanguardRemoteAccount, VanguardSyncAccount>();
  const usedPlannedAccounts = new Set<VanguardSyncAccount>();
  const unresolvedRemoteAccounts: VanguardRemoteAccount[] = [];
  for (const remote of remoteAccounts) {
    const matches = plannedAccounts.filter(planned => planned.accountLast4 === remote.accountLast4);
    if (matches.length === 0) {
      unresolvedRemoteAccounts.push(remote);
      continue;
    }
    if (matches.length !== 1) throw new Error('Vanguard local account routing is ambiguous');
    const planned = matches[0]!;
    if (remote.accountKind && remote.accountKind !== planned.accountKind) {
      throw new Error('A Vanguard remote account conflicts with its planned local account kind');
    }
    plannedForRemote.set(remote, planned);
    usedPlannedAccounts.add(planned);
  }

  for (const remote of unresolvedRemoteAccounts) {
    if (!remote.accountKind) {
      throw new Error('A Vanguard remote account has no unambiguous local account route');
    }
    const remoteKindCount = unresolvedRemoteAccounts.filter(candidate =>
      candidate.accountKind === remote.accountKind,
    ).length;
    const candidates = plannedAccounts.filter(planned =>
      !usedPlannedAccounts.has(planned) && planned.accountKind === remote.accountKind,
    );
    if (remoteKindCount !== 1 || candidates.length !== 1) {
      throw new Error('A Vanguard remote account has no unambiguous local account route');
    }
    const planned = candidates[0]!;
    plannedForRemote.set(remote, planned);
    usedPlannedAccounts.add(planned);
  }

  return remoteAccounts.map(remote => ({ remote, planned: plannedForRemote.get(remote)! }));
}

export function vanguardStatementAccountRoutes(
  plannedAccounts: readonly VanguardSyncAccount[],
  mappedAccounts: readonly VanguardMappedAccount[],
): VanguardStatementAccountRoute[] {
  return plannedAccounts.map(account => ({
    account,
    identityLast4s: [...new Set([
      account.accountLast4,
      ...mappedAccounts
        .filter(mapped => mapped.planned.accountId === account.accountId)
        .map(mapped => mapped.remote.accountLast4),
    ])],
  }));
}

export function vanguardCsvAccountLast4s(text: string): string[] {
  const accountNumbers = parseCsvRows(text)
    .filter(row => row[0]?.trim().toLowerCase() !== 'account number')
    .map(row => row[0]?.replace(/\D/g, '') ?? '')
    .filter(value => value.length >= 4)
    .map(value => value.slice(-4));
  return [...new Set(accountNumbers)];
}

export function assertVanguardArtifactAccount(
  expectedLast4: string | readonly string[],
  actualLast4s: string[],
): void {
  const expectedLast4s = typeof expectedLast4 === 'string' ? [expectedLast4] : expectedLast4;
  if (actualLast4s.length !== 1 || !expectedLast4s.includes(actualLast4s[0]!)) {
    throw new Error('Vanguard artifact does not match its planned EasyMoney account');
  }
}

async function validateCsv(path: string, expectedLast4: string | readonly string[]): Promise<void> {
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

async function validatePdf(path: string, expectedLast4: string | readonly string[]): Promise<void> {
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
  expectedLast4: string | readonly string[],
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

function vanguardActivityDate(value: string): string {
  validateIsoDate(value);
  const [year, month, day] = value.split('-');
  return `${month}/${day}/${year}`;
}

export function vanguardActivityApiRequest(
  account: VanguardAccountApiRecord,
  from: string,
  through: string,
  userAgent: string,
  xsrfToken: string,
): VanguardApiRequest {
  validateIsoDate(from);
  validateIsoDate(through);
  if (from > through) throw new Error('Vanguard activity start date cannot be after its end date');
  if (!account.accountId || !account.accountName || !account.fundAccountNumber) {
    throw new Error('Vanguard activity account is missing its API identity');
  }
  if (!userAgent.trim()) throw new Error('Vanguard activity request requires a browser user agent');
  if (!xsrfToken.trim()) throw new Error('Vanguard activity request requires an XSRF token');

  return {
    url: ACTIVITY_API_URL,
    method: 'POST',
    body: JSON.stringify({
      downloadOptionSelect: '2',
      downloadDateSelect: '5',
      fromDate: vanguardActivityDate(from),
      toDate: vanguardActivityDate(through),
      selectedAccounts: [account],
      userAgent,
      isSingle: false,
    }),
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      referer: ACTIVITY_REFERER_URL,
      'x-xsrf-token': xsrfToken,
    },
  };
}

function vanguardEnvelopeHeader(
  headers: Record<string, unknown>,
  expectedName: string,
): string {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === expectedName);
  if (!entry) return '';
  const value = entry[1];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string').join(', ');
  return '';
}

export function vanguardActivityCsvFromEnvelope(value: unknown): string {
  if (!value || typeof value !== 'object') {
    throw new Error('Vanguard activity API returned an invalid download envelope');
  }
  const envelope = value as Record<string, unknown>;
  if (typeof envelope.body !== 'string' || !envelope.headers ||
      typeof envelope.headers !== 'object' || Array.isArray(envelope.headers)) {
    throw new Error('Vanguard activity API returned an invalid download envelope');
  }
  const contentType = vanguardEnvelopeHeader(
    envelope.headers as Record<string, unknown>,
    'content-type',
  ).toLowerCase();
  if (!contentType.includes('csv') && !contentType.includes('text/plain') &&
      !contentType.includes('octet-stream')) {
    throw new Error('Vanguard activity download has an unexpected content type');
  }
  if (!vanguardActivityCsvParser.matches({
    fileName: 'vanguard-activity.csv',
    headers: [],
    sample: envelope.body,
  })) {
    throw new Error('Vanguard activity download does not match the expected CSV format');
  }
  return envelope.body;
}

export function vanguardStatementListRequest(year: string): VanguardApiRequest {
  if (!/^\d{4}$/.test(year)) throw new Error('Vanguard statement year must use YYYY');
  const url = new URL(STATEMENTS_API_URL);
  url.searchParams.set('year', year);
  return {
    url: url.toString(),
    method: 'GET',
    headers: {
      accept: 'application/json, text/plain, */*',
      referer: STATEMENTS_URL,
      urlflag: 'getStatements',
    },
  };
}

export function vanguardStatementPdfRequest(statementId: string): VanguardApiRequest {
  const normalizedId = statementId.trim();
  if (!normalizedId || /[\r\n]/.test(normalizedId)) {
    throw new Error('Vanguard statement is missing a usable document identity');
  }
  return {
    url: STATEMENT_PDF_API_URL,
    method: 'GET',
    headers: {
      accept: 'application/pdf, */*',
      referer: STATEMENTS_URL,
      statementid: normalizedId,
      urlflag: 'getPdf',
    },
  };
}

function vanguardStatementIdentityValues(record: Record<string, unknown>): string[] {
  return [
    'accountId',
    'accountNumber',
    'productAccountData',
    'statementDescription',
    'statementNumber',
  ].map(field => apiString(record, field)).filter(Boolean);
}

function vanguardIdentityIncludesLast4(value: string, last4: string): boolean {
  return new RegExp(`${last4}(?!\\d)`).test(value);
}

export function parseVanguardStatementApiResponse(
  value: unknown,
  accountRoutes: readonly VanguardStatementAccountRoute[],
): VanguardRemoteStatement[] {
  if (!value || typeof value !== 'object' || !('statements' in value) ||
      !Array.isArray(value.statements)) {
    throw new Error('Vanguard statement API returned an invalid statement collection');
  }
  const statementIds = new Set<string>();
  const statements: VanguardRemoteStatement[] = [];
  for (const [index, statement] of value.statements.entries()) {
    if (!statement || typeof statement !== 'object') {
      throw new Error(`Vanguard statement API record ${index + 1} is invalid`);
    }
    const record = statement as Record<string, unknown>;
    const identityValues = vanguardStatementIdentityValues(record);
    const matches = accountRoutes.filter(route => route.identityLast4s.some(last4 =>
      identityValues.some(identity => vanguardIdentityIncludesLast4(identity, last4)),
    ));
    if (matches.length > 1) {
      throw new Error('Vanguard statement metadata is ambiguous across local accounts');
    }
    if (matches.length === 0) continue;

    const statementId = apiString(record, 'statementId');
    const endDate = apiString(record, 'endDate').slice(0, 10);
    if (!statementId) {
      throw new Error(`Vanguard statement API record ${index + 1} has no document identity`);
    }
    validateIsoDate(endDate);
    if (statementIds.has(statementId)) {
      throw new Error('Vanguard statement API returned duplicate document identities');
    }
    statementIds.add(statementId);
    const route = matches[0]!;
    statements.push({
      accountKind: route.account.accountKind,
      accountLast4: route.account.accountLast4,
      validationAccountLast4s: route.identityLast4s,
      statementDate: endDate,
      request: vanguardStatementPdfRequest(statementId),
    });
  }
  return statements;
}

function vanguardAuthenticationResponse(value: string): boolean {
  try {
    const url = new URL(value);
    return isVanguardLoginUrl(url.toString()) || !isVanguardHost(url.hostname);
  } catch {
    return true;
  }
}

export function vanguardApiResponseRequiresAuthentication(
  response: Pick<VanguardBrowserApiResponse, 'headers' | 'redirected' | 'status' | 'url'>,
): boolean {
  const status = response.status;
  if (response.redirected || status === 0) return true;
  if (status === 401 || status === 403) return true;
  if (status >= 300 && status < 400) {
    const location = response.headers.location;
    if (!location) return true;
    try {
      const redirect = new URL(location, response.url);
      return isVanguardLoginUrl(redirect.toString()) || !isVanguardHost(redirect.hostname);
    } catch {
      return true;
    }
  }
  return vanguardAuthenticationResponse(response.url);
}

export async function vanguardBrowserFetchInPage(
  request: VanguardApiRequest,
): Promise<VanguardBrowserApiResponse> {
  const headers = new Headers(request.headers ?? {});
  const requestedReferrer = headers.get('referer');
  headers.delete('referer');
  let referrer: string | undefined;
  if (requestedReferrer) {
    try {
      const parsedReferrer = new URL(requestedReferrer, location.href);
      if (parsedReferrer.origin === location.origin) referrer = parsedReferrer.toString();
    } catch {
      // Browser fetch will provide the current document as the safe referrer.
    }
  }

  const response = await fetch(request.url, {
    method: request.method,
    headers,
    ...(request.body ? { body: request.body } : {}),
    ...(referrer ? { referrer } : {}),
    credentials: 'include',
    redirect: 'manual',
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    responseHeaders[name.toLowerCase()] = value;
  });
  return {
    status: response.status,
    url: response.url || request.url,
    headers: responseHeaders,
    bodyBase64: btoa(binary),
    redirected: response.redirected || response.type === 'opaqueredirect' || response.status === 0,
  };
}

function vanguardApiPageUrl(request: VanguardApiRequest): string {
  const referer = Object.entries(request.headers ?? {})
    .find(([name]) => name.toLowerCase() === 'referer')?.[1];
  return referer ?? ACTIVITY_REFERER_URL;
}

async function fetchVanguardApiResponse(
  page: Page,
  request: VanguardApiRequest,
): Promise<VanguardBrowserApiResponse> {
  const target = new URL(request.url);
  if (target.protocol !== 'https:' || !isVanguardHost(target.hostname)) {
    throw new Error('Vanguard API request targeted an unapproved host');
  }
  const apiPage = new URL(vanguardApiPageUrl(request));
  if (apiPage.protocol !== 'https:' || !isVanguardHost(apiPage.hostname)) {
    throw new Error('Vanguard API request has an unapproved application origin');
  }

  let current: URL | null = null;
  try {
    current = new URL(page.url());
  } catch {
    // A new or replaced page is navigated to the approved application below.
  }
  if (page.isClosed()) throw new Error(AUTHENTICATION_REQUIRED);
  if (current?.origin !== apiPage.origin) {
    await page.goto(apiPage.toString(), { waitUntil: 'domcontentloaded' });
    current = new URL(page.url());
  }
  if (isVanguardLoginUrl(current.toString())) throw new Error(AUTHENTICATION_REQUIRED);
  if (!isVanguardHost(current.hostname) ||
      (current.origin !== apiPage.origin && current.origin !== target.origin)) {
    throw new Error('Vanguard did not open the approved API application');
  }

  try {
    const response = await page.evaluate(vanguardBrowserFetchInPage, request);
    return {
      ...response,
      url: new URL(response.url, request.url).toString(),
    };
  } catch (error) {
    if (page.isClosed() || isVanguardLoginUrl(page.url())) {
      throw new Error(AUTHENTICATION_REQUIRED);
    }
    throw new Error('Vanguard browser API request could not be completed', { cause: error });
  }
}

function vanguardApiResponseBody(response: VanguardBrowserApiResponse): Buffer {
  return Buffer.from(response.bodyBase64, 'base64');
}

function vanguardApiResponseJson(response: VanguardBrowserApiResponse): unknown {
  try {
    return JSON.parse(vanguardApiResponseBody(response).toString('utf8')) as unknown;
  } catch {
    throw new Error('Vanguard API response did not contain valid JSON');
  }
}

async function saveVanguardArtifact(
  page: Page,
  request: VanguardApiRequest,
  job: ArtifactJob,
): Promise<void> {
  const response = await fetchVanguardApiResponse(page, request);
  if (vanguardApiResponseRequiresAuthentication(response)) {
    throw new Error(AUTHENTICATION_REQUIRED);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Vanguard ${job.format.toUpperCase()} request failed with status ${response.status}`);
  }
  const contentType = response.headers['content-type']?.toLowerCase() ?? '';
  const validContentType = job.format === 'pdf'
    ? contentType.includes('pdf') || contentType.includes('octet-stream')
    : contentType.includes('csv') || contentType.includes('excel') ||
      contentType.includes('text/plain') || contentType.includes('octet-stream');
  if (!validContentType) {
    if (contentType.includes('html')) throw new Error(AUTHENTICATION_REQUIRED);
    throw new Error(`Vanguard ${job.format.toUpperCase()} response has an unexpected content type`);
  }
  await writeFile(job.targetPath, vanguardApiResponseBody(response));
  try {
    await validateVanguardArtifact(
      job.targetPath,
      job.format,
      job.validationAccountLast4s ?? job.accountLast4,
    );
  } catch (error) {
    await rm(job.targetPath, { force: true });
    throw error;
  }
}

async function saveVanguardActivityArtifact(
  page: Page,
  request: VanguardApiRequest,
  job: ArtifactJob,
): Promise<void> {
  const response = await fetchVanguardApiResponse(page, request);
  if (vanguardApiResponseRequiresAuthentication(response)) {
    throw new Error(AUTHENTICATION_REQUIRED);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Vanguard CSV request failed with status ${response.status}`);
  }
  const responseContentType = response.headers['content-type']?.toLowerCase() ?? '';
  if (!responseContentType.includes('json')) {
    if (responseContentType.includes('html')) throw new Error(AUTHENTICATION_REQUIRED);
    throw new Error('Vanguard activity API response has an unexpected content type');
  }
  const csv = vanguardActivityCsvFromEnvelope(vanguardApiResponseJson(response));
  await writeFile(job.targetPath, csv);
  try {
    await validateVanguardArtifact(
      job.targetPath,
      'csv',
      job.validationAccountLast4s ?? job.accountLast4,
    );
  } catch (error) {
    await rm(job.targetPath, { force: true });
    throw error;
  }
}

export async function discoverVanguardAccounts(page: Page): Promise<VanguardRemoteAccount[]> {
  const response = await fetchVanguardApiResponse(page, {
    url: ACCOUNTS_API_URL,
    method: 'GET',
  });
  if (vanguardApiResponseRequiresAuthentication(response)) {
    throw new Error(AUTHENTICATION_REQUIRED);
  }
  if (response.status < 200 || response.status >= 300 ||
      !/json/i.test(response.headers['content-type'] ?? '')) {
    throw new Error(`Vanguard account API request failed with status ${response.status}`);
  }
  return parseVanguardAccountApiResponse(vanguardApiResponseJson(response));
}

async function activityRequestForAccount(
  page: Page,
  account: VanguardRemoteAccount,
  from: string,
  through: string,
): Promise<VanguardApiRequest> {
  const cookies = await page.context().cookies(ACTIVITY_REFERER_URL);
  const xsrfCookie = cookies.find(cookie => cookie.name.toLowerCase() === 'xsrf-token');
  if (!xsrfCookie?.value) throw new Error(AUTHENTICATION_REQUIRED);
  const userAgent = await page.evaluate(() => navigator.userAgent);
  return vanguardActivityApiRequest(
    account.apiAccount,
    from,
    through,
    userAgent,
    decodeURIComponent(xsrfCookie.value),
  );
}

async function discoverVanguardStatements(
  page: Page,
  years: string[],
  accountRoutes: VanguardStatementAccountRoute[],
): Promise<VanguardRemoteStatement[]> {
  const statements: VanguardRemoteStatement[] = [];
  for (const year of years) {
    const request = vanguardStatementListRequest(year);
    const response = await fetchVanguardApiResponse(page, request);
    if (vanguardApiResponseRequiresAuthentication(response)) {
      throw new Error(AUTHENTICATION_REQUIRED);
    }
    if (response.status < 200 || response.status >= 300 ||
        !/json/i.test(response.headers['content-type'] ?? '')) {
      throw new Error(`Vanguard statement API request failed with status ${response.status}`);
    }
    statements.push(...parseVanguardStatementApiResponse(vanguardApiResponseJson(response), accountRoutes));
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
  return exact[0] ?? null;
}

export function safeVanguardError(error: unknown): string {
  const raw = String(error instanceof Error ? error.message : error)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const summary = raw.split(/\bCall log:/i, 1)[0]?.trim() || 'Vanguard request failed';
  if (/timeout \d+ms exceeded/i.test(summary)) return 'Vanguard request timed out';
  if (/(?:^|\s)(?:cookie|set-cookie|authorization|x-xsrf-token)\s*:/i.test(summary)) {
    return 'Vanguard request failed';
  }
  return summary
    .replace(/https?:\/\/\S+/g, '<redacted-url>')
    .replace(/\b[a-f0-9]{16,}\b/gi, '<redacted-id>')
    .replace(/\b\d{4,}\b/g, '<digits>')
    .slice(0, 500);
}

async function executeVanguardProfile(
  page: Page,
  profile: VanguardSyncProfile,
  profilePath: string,
  pending: ArtifactJob[],
  through: string,
  progress: VanguardProgress,
): Promise<VanguardProfileProgramResult> {
  const authenticationAction = vanguardAuthenticationAction(profile);
  try {
    if (!await isVanguardAuthenticatedPage(page)) {
      progress(
        'authentication',
        'authentication',
        'waiting',
        `Waiting for Vanguard authentication for ${profile.accountHolder}`,
      );
      return {
        status: 'login-required',
        action: authenticationAction,
      };
    }
    progress(
      'authentication',
      'authentication',
      'complete',
      `Vanguard authentication is ready for ${profile.accountHolder}`,
    );
    progress('discovery', 'discovery', 'start', 'Discovering Vanguard accounts');
    const remoteAccounts = await discoverVanguardAccounts(page);
    const mappedAccounts = mapVanguardRemoteAccounts(remoteAccounts, profile.accounts);
    progress(
      'discovery',
      'discovery',
      'complete',
      `Discovered ${mappedAccounts.length} Vanguard account${mappedAccounts.length === 1 ? '' : 's'}`,
      { accountCount: mappedAccounts.length },
    );

    const saved: string[] = [];
    const unavailable: string[] = [];
    const activityJobs = pending.filter(job => job.artifactType === 'activity');
    for (let index = 0; index < activityJobs.length; index += 1) {
      const job = activityJobs[index]!;
      const mapped = mappedAccounts.find(account => account.planned.accountId === job.accountId);
      const requestKey = `activity-request-${index}`;
      if (!mapped) {
        unavailable.push(job.fileName);
        progress(
          requestKey,
          'activity-request',
          'complete',
          `Vanguard activity ${index + 1} of ${activityJobs.length} is unavailable`,
          {
            artifactIndex: index + 1,
            artifactCount: activityJobs.length,
            unavailable: true,
          },
        );
        continue;
      }
      progress(
        requestKey,
        'activity-request',
        'start',
        `Preparing Vanguard activity API request ${index + 1} of ${activityJobs.length}`,
        { artifactIndex: index + 1, artifactCount: activityJobs.length },
      );
      job.validationAccountLast4s = [mapped.remote.accountLast4];
      const request = await activityRequestForAccount(page, mapped.remote, job.startDate!, through);
      progress(
        requestKey,
        'activity-request',
        'complete',
        `Prepared Vanguard activity API request ${index + 1} of ${activityJobs.length}`,
        { artifactIndex: index + 1, artifactCount: activityJobs.length },
      );
      const downloadKey = `activity-download-${index}`;
      progress(
        downloadKey,
        'activity-download',
        'start',
        `Downloading Vanguard activity ${index + 1} of ${activityJobs.length}`,
        { artifactIndex: index + 1, artifactCount: activityJobs.length },
      );
      await saveVanguardActivityArtifact(page, request, job);
      progress(
        downloadKey,
        'activity-download',
        'complete',
        `Downloaded and parser-validated Vanguard activity ${index + 1} of ${activityJobs.length}`,
        {
          artifactIndex: index + 1,
          artifactCount: activityJobs.length,
          parserValidated: true,
        },
      );
      saved.push(job.fileName);
    }

    const statementJobs = pending.filter(job => job.artifactType === 'statement');
    if (statementJobs.length > 0) {
      progress(
        'statement-discovery',
        'statement-discovery',
        'start',
        'Discovering Vanguard statements through the API',
        { requestedStatementCount: statementJobs.length },
      );
      const years = [...new Set(statementJobs.map(job => job.statementDate!.slice(0, 4)))].sort();
      const statements = await discoverVanguardStatements(
        page,
        years,
        vanguardStatementAccountRoutes(profile.accounts, mappedAccounts),
      );
      progress(
        'statement-discovery',
        'statement-discovery',
        'complete',
        `Discovered ${statements.length} Vanguard statement artifact${statements.length === 1 ? '' : 's'}`,
        { discoveredStatementCount: statements.length, yearCount: years.length },
      );
      let unavailableStatementCount = 0;
      for (let index = 0; index < statementJobs.length; index += 1) {
        const job = statementJobs[index]!;
        const statement = statementForJob(job, statements);
        if (!statement) {
          unavailable.push(job.fileName);
          unavailableStatementCount += 1;
          continue;
        }
        job.validationAccountLast4s = statement.validationAccountLast4s;
        const downloadKey = `statement-download-${index}`;
        progress(
          downloadKey,
          'statement-download',
          'start',
          `Downloading Vanguard statement ${index + 1} of ${statementJobs.length}`,
          { artifactIndex: index + 1, artifactCount: statementJobs.length },
        );
        await saveVanguardArtifact(page, statement.request, job);
        progress(
          downloadKey,
          'statement-download',
          'complete',
          `Downloaded and parser-validated Vanguard statement ${index + 1} of ${statementJobs.length}`,
          {
            artifactIndex: index + 1,
            artifactCount: statementJobs.length,
            parserValidated: true,
          },
        );
        saved.push(job.fileName);
      }
      if (unavailableStatementCount > 0) {
        progress(
          'statement-unavailable',
          'statement-download',
          'complete',
          `${unavailableStatementCount} requested Vanguard statement artifact${unavailableStatementCount === 1 ? ' was' : 's were'} unavailable`,
          { unavailableStatementCount },
        );
      }
    }

    return {
      status: 'complete',
      saved,
      unavailable,
      accountCount: mappedAccounts.length,
    };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    if (message.includes(AUTHENTICATION_REQUIRED) || isVanguardLoginUrl(page.url())) {
      let authenticationRequired: { status: 'login-required'; action: string };
      try {
        authenticationRequired = await transitionVanguardToInteractiveAuthentication(page, {
          session: profile.session,
          accountHolder: profile.accountHolder,
          profilePath,
        });
      } catch (resetError) {
        progress(
          'profile',
          'sync',
          'error',
          `Vanguard sync failed for ${profile.accountHolder}`,
        );
        return { status: 'error', message: safeVanguardError(resetError) };
      }
      progress(
        'authentication',
        'authentication',
        'waiting',
        `Waiting for Vanguard authentication for ${profile.accountHolder}`,
      );
      return authenticationRequired;
    }
    progress(
      'profile',
      'sync',
      'error',
      `Vanguard sync failed for ${profile.accountHolder}`,
    );
    return { status: 'error', message: safeVanguardError(error) };
  }
}

function browserProgram(): string {
  return `async (page, _reportProgress, bindings) => JSON.stringify(
    await bindings.execute(page)
  )`;
}

async function runProfile(
  config: VanguardSyncConfig,
  profile: VanguardSyncProfile,
  onProgress: VanguardProgressReporter,
): Promise<VanguardDownloadedArtifact[]> {
  const progress = createVanguardProgress(onProgress, profile.id);
  progress('profile', 'sync', 'start', `Starting Vanguard sync for ${profile.accountHolder}`, {
    plannedAccountCount: profile.accounts.length,
  });
  const jobs = jobsForProfile(config, profile);
  const pending: ArtifactJob[] = [];
  for (const job of jobs) {
    if (!await isValid(job.targetPath, job.format, job.accountLast4)) pending.push(job);
  }
  if (pending.length === 0) {
    progress('profile', 'sync', 'complete', `Vanguard data is already current for ${profile.accountHolder}`, {
      artifactCount: 0,
    });
    return [];
  }

  const profilePath = playwrightProfilePath(profile.session);
  const hasSavedAuthentication = await playwrightHasSavedAuthentication(profile.session, profilePath);
  progress(
    'authentication',
    'authentication',
    'start',
    `Checking Vanguard authentication for ${profile.accountHolder}`,
    {
      cachedAuthentication: hasSavedAuthentication,
      initialMode: hasSavedAuthentication ? 'headless' : 'interactive',
    },
  );
  let authenticationWaiting = false;

  const result = await runInstitutionBrowserProgram<{
    saved: string[];
    unavailable: string[];
    accountCount: number;
  }>(
    { name: profile.session, startUrl: LOGIN_URL, profilePath },
    browserProgram(),
    {
      completionDescription: `Vanguard (${profile.accountHolder}) downloads are complete.`,
      isAuthenticated: isVanguardAuthenticatedPage,
      waitUntilAuthenticated: waitUntilVanguardAuthenticated,
      onProgress: message => {
        if (!authenticationWaiting && /waiting|authentication required|needs attention/i.test(message)) {
          authenticationWaiting = true;
          progress(
            'authentication',
            'authentication',
            'waiting',
            `Waiting for Vanguard authentication for ${profile.accountHolder}`,
          );
        }
      },
      programBindings: {
        execute: (page: Page) =>
          executeVanguardProfile(page, profile, profilePath, pending, config.through, progress),
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
    const validationAccountLast4s = job.validationAccountLast4s ?? [job.accountLast4];
    await validateVanguardArtifact(job.targetPath, job.format, validationAccountLast4s);
    downloaded.push({
      fileName: job.fileName,
      accountId: job.accountId,
      institution: job.institution,
      profileId: job.profileId,
      accountKind: job.accountKind,
      accountLast4: validationAccountLast4s[0]!,
      artifactType: job.artifactType,
    });
  }
  progress('profile', 'sync', 'complete', `Vanguard downloads are ready for ${profile.accountHolder}`, {
    artifactCount: downloaded.length,
    unavailableArtifactCount: result.unavailable?.length ?? 0,
  });
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
  const progress = createVanguardProgress(onProgress);
  progress(
    'sync',
    'sync',
    'start',
    `Starting ${normalizedConfig.profiles.length} Vanguard profile${normalizedConfig.profiles.length === 1 ? '' : 's'}`,
    { profileCount: normalizedConfig.profiles.length },
  );
  const results = await runVanguardProfilesConcurrently(
    normalizedConfig.profiles,
    profile => runProfile(normalizedConfig, profile, onProgress),
  );
  const artifacts = results.flat();
  progress(
    'sync',
    'sync',
    'complete',
    `Vanguard downloads are ready for review`,
    { artifactCount: artifacts.length, profileCount: normalizedConfig.profiles.length },
  );
  return artifacts;
}
