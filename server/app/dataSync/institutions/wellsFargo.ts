import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

import { wellsFargoActivityParser } from '../../importParsers/wellsFargoActivity.ts';
import { wellsFargoStatementParser } from '../../importParsers/wellsFargoStatement.ts';
import {
  decodeInstitutionBrowserProgramResult,
  runInstitutionBrowserProgram,
} from '../browserSession.ts';
import {
  browserNativeResponseBody,
  browserNativeResponseOk,
  runBrowserNativeRequest,
  runBrowserNativeRouteRequest,
  safeBrowserRequestHeaders,
  type BrowserNativeResponse,
} from '../browserRequest.ts';
import type { Download, Page, Request, Response, Route } from 'playwright';

const LOGIN_URL = 'https://connect.secure.wellsfargo.com/auth/login/present';
const ACCOUNT_SUMMARY_URL = 'https://connect.secure.wellsfargo.com/accounts/start';
const DEFAULT_SESSION = 'wells-fargo-catchup';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVITY_FILENAME = /^wells-fargo-(checking|savings|credit-card)-(\d{4})-(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})\.csv$/i;
const STATEMENT_FILENAME = /^wells-fargo-(checking|savings|credit-card)-(\d{4})-(\d{4}-\d{2}-\d{2})\.pdf$/i;
const STATEMENT_PATH_PREFIX = '/edocs/documents/retrieve/';
const MAX_STATEMENT_BYTES = 25_000_000;
const AUTHENTICATION_PROBE_TIMEOUT_MS = 10_000;

export type WellsFargoAccountKind = 'checking' | 'savings' | 'credit-card';
export type WellsFargoArtifactKind = 'activity' | 'statement';
export type WellsFargoProgressStatus = 'started' | 'waiting' | 'completed' | 'skipped' | 'failed';

export interface WellsFargoAccountIdentity {
  kind: WellsFargoAccountKind;
  last4: string;
}

export type WellsFargoRemoteAccount = WellsFargoAccountIdentity;

export interface WellsFargoSyncAccount extends WellsFargoAccountIdentity {
  accountId: number;
  activityFrom: string;
  activityThrough: string;
  statementFrom: string;
  statementThrough: string;
}

export interface WellsFargoMappedAccount {
  remote: WellsFargoRemoteAccount;
  planned: WellsFargoSyncAccount;
}

export interface WellsFargoAccountCandidate {
  label: string;
  destination?: string;
  observedKind?: WellsFargoAccountKind;
}

export interface WellsFargoStatementCandidate {
  date: string;
  request: WellsFargoApiRequest;
  capturedResponse?: BrowserNativeResponse;
  verification?: 'observed-document-response';
}

export interface WellsFargoFormSnapshot {
  action: string;
  method: string;
  fields: Array<[string, string]>;
}

export interface WellsFargoApiRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  bodyBase64?: string;
  body?: string;
}

export interface WellsFargoValidatedArtifact {
  fileName: string;
  path: string;
  kind: WellsFargoArtifactKind;
  account: WellsFargoAccountIdentity;
  coveredFrom: string;
  coveredThrough: string;
  byteLength: number;
  transactionCount: number;
  balanceCount: number;
}

export interface WellsFargoDownloadedArtifact extends WellsFargoValidatedArtifact {
  accountId: number;
}

export interface WellsFargoUnavailableArtifact {
  accountId: number;
  kind: WellsFargoArtifactKind;
  account: WellsFargoAccountIdentity;
}

export interface WellsFargoSyncResult {
  accounts: WellsFargoAccountIdentity[];
  artifacts: WellsFargoDownloadedArtifact[];
  unavailable: WellsFargoUnavailableArtifact[];
}

export interface WellsFargoSyncConfig {
  outputDir: string;
  accounts: WellsFargoSyncAccount[];
  session?: string;
  profilePath?: string;
  headless?: boolean;
}

export interface WellsFargoProgressEvent {
  step:
    | 'sync'
    | 'authentication'
    | 'browser-window'
    | 'account-discovery'
    | 'capability-discovery'
    | 'activity-metadata'
    | 'activity-download'
    | 'activity-validation'
    | 'statement-metadata'
    | 'statement-download'
    | 'statement-validation';
  status: WellsFargoProgressStatus;
  timestamp: string;
  message: string;
  elapsedMs?: number;
  accountIndex?: number;
  accountCount?: number;
  discoveredAccountCount?: number;
  artifactIndex?: number;
  artifactCount?: number;
  accountKind?: WellsFargoAccountKind;
  artifactKind?: WellsFargoArtifactKind;
  byteLength?: number;
  transactionCount?: number;
  balanceCount?: number;
  parserValidated?: boolean;
  diagnostic?: string;
  unavailableArtifactCount?: number;
}

export type WellsFargoProgressReporter = (event: WellsFargoProgressEvent) => void;
export type WellsFargoProgressInput = Omit<WellsFargoProgressEvent, 'timestamp' | 'elapsedMs'>;

export function createWellsFargoProgress(
  onProgress: WellsFargoProgressReporter,
  clock: () => number = () => performance.now(),
  timestamp: () => string = () => new Date().toISOString(),
) {
  const started = new Map<string, number>();
  return (event: WellsFargoProgressInput): void => {
    const key = [
      event.step,
      event.accountIndex ?? 0,
      event.artifactIndex ?? 0,
    ].join(':');
    const now = clock();
    if (event.status === 'started') started.set(key, now);
    const began = started.get(key);
    onProgress({
      ...event,
      timestamp: timestamp(),
      ...(event.status !== 'started' && began !== undefined
        ? { elapsedMs: Math.round(now - began) }
        : {}),
    });
    if (event.status !== 'started') started.delete(key);
  };
}

type ArtifactIdentityPlan = {
  fileName: string;
  path: string;
  kind: WellsFargoArtifactKind;
  account: WellsFargoAccountIdentity;
  coveredFrom: string;
  coveredThrough: string;
};

type ArtifactPlan = ArtifactIdentityPlan & {
  accountId: number;
};

type ArtifactDownload = ArtifactPlan & {
  byteLength: number;
};

type AccountCapabilities = {
  activity: boolean;
  statements: boolean;
};

type BrowserResult = {
  accounts: WellsFargoAccountIdentity[];
  artifacts: WellsFargoDownloadedArtifact[];
  unavailable: WellsFargoUnavailableArtifact[];
};

function wellsFargoBrowserBindings(
  outputDir: string,
  onProgress: WellsFargoProgressReporter,
) {
  return {
    accountCapabilities: wellsFargoAccountCapabilities,
    discoverAccounts: discoverWellsFargoAccounts,
    discoverStatements: discoverWellsFargoStatements,
    downloadArtifact: (
      page: Page,
      plan: ArtifactPlan,
      request: WellsFargoApiRequest,
      capturedResponse?: BrowserNativeResponse,
    ) => downloadWellsFargoArtifact(page, outputDir, plan, request, capturedResponse),
    isAuthenticated: isWellsFargoAuthenticatedPage,
    mapAccounts: mapWellsFargoAccounts,
    openAccount: openWellsFargoAccount,
    prepareActivityRequest: prepareWellsFargoActivityRequest,
    report: createWellsFargoProgress(onProgress),
    safeError: safeWellsFargoDiagnostic,
    validateArtifact: validateDownloadedWellsFargoArtifact,
  };
}

function assertDate(value: string, label: string): void {
  if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
}

function assertDateRange(from: string, through: string): void {
  assertDate(from, 'Wells Fargo start date');
  assertDate(through, 'Wells Fargo end date');
  if (from > through) throw new Error('Wells Fargo start date must not follow its end date');
}

function asWellsFargoUrl(value: string, base?: string): URL {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password || !/(?:^|\.)wellsfargo\.com$/i.test(url.hostname)) {
    throw new Error('Wells Fargo supplied an invalid API destination');
  }
  return url;
}

export function wellsFargoStatementDocumentUrl(
  value: string,
  pageUrl: string,
): string | null {
  try {
    const pageOrigin = asWellsFargoUrl(pageUrl).origin;
    const destination = asWellsFargoUrl(value, pageUrl);
    return destination.origin === pageOrigin &&
        destination.pathname.startsWith(STATEMENT_PATH_PREFIX)
      ? destination.toString()
      : null;
  } catch {
    return null;
  }
}

export async function restoreWellsFargoStatementPage(
  page: Pick<Page, 'goBack' | 'goto' | 'isClosed' | 'url'>,
  statementPageUrl: string,
): Promise<boolean> {
  const expected = asWellsFargoUrl(statementPageUrl);
  const isExpectedPage = () => {
    try {
      const current = asWellsFargoUrl(page.url());
      return current.origin === expected.origin && current.pathname === expected.pathname;
    } catch {
      return false;
    }
  };
  if (page.isClosed()) return false;
  if (isExpectedPage()) return true;
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => null);
  if (page.isClosed()) return false;
  if (isExpectedPage()) return true;
  await page.goto(expected.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
    .catch(() => null);
  return !page.isClosed() && isExpectedPage();
}

function accountKindFromLabel(label: string): WellsFargoAccountKind | null {
  if (/\b(?:savings|money market)\b/i.test(label)) return 'savings';
  if (/\bchecking\b/i.test(label)) return 'checking';
  if (/\b(?:credit\s*card|card|visa|mastercard|american express|amex)\b/i.test(label)) return 'credit-card';
  return null;
}

export function wellsFargoAccountLast4FromLabel(label: string): string | null {
  return label.match(
    /(?:account(?: number)? ending in|ending in|[x*\u2022.\u2026-]{2,})[\s.\u2026\u2022*x-]*(\d{4})(?!\d)/i,
  )?.[1] ?? null;
}

export function parseWellsFargoAccountCandidates(
  candidates: WellsFargoAccountCandidate[],
  baseUrl = LOGIN_URL,
): WellsFargoRemoteAccount[] {
  const accounts = new Map<string, WellsFargoRemoteAccount>();
  for (const candidate of candidates) {
    const kind = candidate.observedKind ?? accountKindFromLabel(candidate.label);
    if (!kind) continue;
    const last4 = wellsFargoAccountLast4FromLabel(candidate.label);
    if (!last4) throw new Error('A supported Wells Fargo account did not expose its last four digits');
    if (candidate.destination) asWellsFargoUrl(candidate.destination, baseUrl);
    const identity = `${kind}:${last4}`;
    if (accounts.has(identity)) {
      throw new Error(`Multiple Wells Fargo ${kind} accounts have an ambiguous routing identity`);
    }
    accounts.set(identity, { kind, last4 });
  }
  if (accounts.size === 0) throw new Error('Wells Fargo did not expose a supported checking, savings, or card account');
  return [...accounts.values()];
}

export function validateWellsFargoSyncAccounts(plannedAccounts: WellsFargoSyncAccount[]): void {
  const identities = new Set<string>();
  const accountIds = new Set<number>();
  for (const account of plannedAccounts) {
    if (!Number.isInteger(account.accountId) || account.accountId <= 0) {
      throw new Error('A planned Wells Fargo account has an invalid local identity');
    }
    if (accountIds.has(account.accountId)) {
      throw new Error('Multiple planned Wells Fargo accounts use the same local identity');
    }
    accountIds.add(account.accountId);
    assertDateRange(account.activityFrom, account.activityThrough);
    assertDateRange(account.statementFrom, account.statementThrough);
    const identity = `${account.kind}:${account.last4}`;
    if (identities.has(identity)) {
      throw new Error('Multiple planned Wells Fargo accounts have an ambiguous routing identity');
    }
    identities.add(identity);
  }
}

export function mapWellsFargoAccounts(
  remoteAccounts: WellsFargoRemoteAccount[],
  plannedAccounts: WellsFargoSyncAccount[],
): WellsFargoMappedAccount[] {
  validateWellsFargoSyncAccounts(plannedAccounts);
  return plannedAccounts.map(planned => {
    const matches = remoteAccounts.filter(remote =>
      remote.kind === planned.kind && remote.last4 === planned.last4
    );
    if (matches.length !== 1) {
      throw new Error('A planned Wells Fargo account is unavailable in the authenticated login');
    }
    return { remote: matches[0]!, planned };
  });
}

export function wellsFargoActivityRequestFromForm(
  snapshot: WellsFargoFormSnapshot,
  baseUrl: string,
): WellsFargoApiRequest {
  const url = asWellsFargoUrl(snapshot.action, baseUrl);
  const method = snapshot.method.toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    throw new Error('Wells Fargo activity form did not use a supported HTTP method');
  }
  const params = new URLSearchParams();
  for (const [name, value] of snapshot.fields) {
    if (!name) throw new Error('Wells Fargo activity form contained an unnamed field');
    params.append(name, value);
  }
  if (method === 'GET') {
    for (const [name, value] of params) url.searchParams.append(name, value);
    return { url: url.toString(), method };
  }
  return { url: url.toString(), method, body: params.toString() };
}

export function isWellsFargoActivityDownloadRequest(
  request: Pick<Request, 'method' | 'postData' | 'resourceType' | 'url'>,
): boolean {
  if (request.method().toUpperCase() !== 'POST' ||
      !['fetch', 'xhr'].includes(request.resourceType())) return false;
  try {
    asWellsFargoUrl(request.url());
  } catch {
    return false;
  }
  return /\bdownloadAccountData\b/.test(request.postData() ?? '');
}

function isWellsFargoReplayableStatementRequest(
  request: Pick<Request, 'method' | 'resourceType' | 'url'>,
  pageUrl: string,
): boolean {
  const method = request.method().toUpperCase();
  if ((method !== 'GET' && method !== 'POST') ||
      !['document', 'fetch', 'xhr'].includes(request.resourceType())) return false;
  try {
    const destination = asWellsFargoUrl(request.url());
    return destination.origin === asWellsFargoUrl(pageUrl).origin;
  } catch {
    return false;
  }
}

export function isWellsFargoStatementDownloadRequest(
  request: Pick<Request, 'method' | 'resourceType' | 'url'>,
  pageUrl: string,
): boolean {
  return isWellsFargoReplayableStatementRequest(request, pageUrl) &&
    wellsFargoStatementDocumentUrl(request.url(), pageUrl) !== null;
}

function wellsFargoDocumentUrlsFromJson(body: Buffer, pageUrl: string): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return [];
  }
  const pageOrigin = asWellsFargoUrl(pageUrl).origin;
  const urls = new Set<string>();
  let visited = 0;
  const inspect = (value: unknown, depth: number): void => {
    if (depth > 12 || visited >= 10_000) return;
    visited += 1;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!/^https:\/\/|^\//i.test(trimmed)) return;
      try {
        const destination = asWellsFargoUrl(trimmed, pageUrl);
        if (destination.origin === pageOrigin &&
            /statement|document|edocs|retrieve|download|pdf/i.test(destination.pathname)) {
          urls.add(destination.toString());
        }
      } catch {
        // Ignore values that are not same-institution document URLs.
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) inspect(item, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) inspect(item, depth + 1);
    }
  };
  inspect(payload, 0);
  return [...urls];
}

function monthNumber(value: string): string | null {
  const month = value.slice(0, 3).toLowerCase();
  return ({
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  } as Record<string, string>)[month] ?? null;
}

export function wellsFargoDateFromText(value: string): string | null {
  const iso = value.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const numeric = value.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})\b/);
  if (numeric) {
    const year = numeric[3]!.length === 2 ? `20${numeric[3]}` : numeric[3]!;
    return `${year}-${numeric[1]!.padStart(2, '0')}-${numeric[2]!.padStart(2, '0')}`;
  }
  const named = value.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  const month = named ? monthNumber(named[1]!) : null;
  return named && month ? `${named[3]}-${month}-${named[2]!.padStart(2, '0')}` : null;
}

export function wellsFargoStatementDateTextVariants(value: string): string[] {
  assertDate(value, 'Wells Fargo statement date');
  const [year, month, day] = value.split('-') as [string, string, string];
  const monthIndex = Number(month) - 1;
  const dayNumber = Number(day);
  const fullMonth = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ][monthIndex]!;
  const shortMonth = fullMonth.slice(0, 3);
  return [...new Set([
    value,
    `${month}/${day}/${year}`,
    `${Number(month)}/${dayNumber}/${year}`,
    `${month}/${day}/${year.slice(-2)}`,
    `${Number(month)}/${dayNumber}/${year.slice(-2)}`,
    `${fullMonth} ${dayNumber}, ${year}`,
    `${fullMonth} ${dayNumber} ${year}`,
    `${shortMonth} ${dayNumber}, ${year}`,
    `${shortMonth} ${dayNumber} ${year}`,
  ].map(variant => variant.toLowerCase()))];
}

export function selectWellsFargoStatements(
  candidates: WellsFargoStatementCandidate[],
  from: string,
  through: string,
): WellsFargoStatementCandidate[] {
  assertDateRange(from, through);
  const byDate = new Map<string, WellsFargoStatementCandidate>();
  const requestIdentity = (request: WellsFargoApiRequest) => JSON.stringify({
    url: request.url,
    method: request.method,
    headers: Object.entries(request.headers ?? {})
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
    bodyBase64: request.bodyBase64 ?? null,
    body: request.body ?? null,
  });
  for (const candidate of candidates) {
    assertDate(candidate.date, 'Wells Fargo statement date');
    const destination = asWellsFargoUrl(candidate.request.url);
    if (!destination.pathname.startsWith(STATEMENT_PATH_PREFIX) &&
        candidate.verification !== 'observed-document-response') {
      throw new Error('Wells Fargo statement metadata did not expose the verified document API');
    }
    if (candidate.request.method !== 'GET' && candidate.request.method !== 'POST') {
      throw new Error('Wells Fargo statement metadata used an unsupported document method');
    }
    const normalized = {
      ...candidate,
      request: { ...candidate.request, url: destination.toString() },
    };
    const existing = byDate.get(candidate.date);
    if (existing && requestIdentity(existing.request) !== requestIdentity(normalized.request)) {
      throw new Error('Wells Fargo exposed multiple statement documents for one account and date');
    }
    byDate.set(candidate.date, existing ?? normalized);
  }
  return selectWellsFargoStatementWindow([...byDate.values()], from, through);
}

function selectWellsFargoStatementWindow<T extends { date: string }>(
  candidates: T[],
  from: string,
  through: string,
): T[] {
  assertDateRange(from, through);
  for (const candidate of candidates) assertDate(candidate.date, 'Wells Fargo statement date');
  const all = [...candidates].sort((left, right) => left.date.localeCompare(right.date));
  const selected = all.filter(candidate => candidate.date >= from && candidate.date <= through);
  const opening = all.filter(candidate => candidate.date < from).at(-1);
  if (opening) selected.unshift(opening);
  return selected;
}

export function wellsFargoArtifactPlanFromFilename(path: string): ArtifactIdentityPlan | null {
  const fileName = basename(path);
  const activity = fileName.match(ACTIVITY_FILENAME);
  if (activity) {
    return {
      fileName,
      path: resolve(path),
      kind: 'activity',
      account: { kind: activity[1]!.toLowerCase() as WellsFargoAccountKind, last4: activity[2]! },
      coveredFrom: activity[3]!,
      coveredThrough: activity[4]!,
    };
  }
  const statement = fileName.match(STATEMENT_FILENAME);
  if (statement) {
    return {
      fileName,
      path: resolve(path),
      kind: 'statement',
      account: { kind: statement[1]!.toLowerCase() as WellsFargoAccountKind, last4: statement[2]! },
      coveredFrom: statement[3]!,
      coveredThrough: statement[3]!,
    };
  }
  return null;
}

function parsedAccountLast4(account?: string | null): string | null {
  return account?.match(/(\d{4})(?!.*\d)/)?.[1] ?? null;
}

function assertParsedAccount(
  expected: WellsFargoAccountIdentity,
  records: Array<{ account?: string | null }>,
): void {
  const last4s = [...new Set(records.map(record => parsedAccountLast4(record.account)).filter((value): value is string => Boolean(value)))];
  if (records.length > 0 && (last4s.length !== 1 || last4s[0] !== expected.last4)) {
    throw new Error('Wells Fargo parser output did not match the artifact routing identity');
  }
}

export async function validateWellsFargoArtifact(path: string): Promise<WellsFargoValidatedArtifact> {
  const plan = wellsFargoArtifactPlanFromFilename(path);
  if (!plan) throw new Error('Wells Fargo artifact filename is not account-identifiable');
  if (extname(path).toLowerCase() !== (plan.kind === 'activity' ? '.csv' : '.pdf')) {
    throw new Error('Wells Fargo artifact extension does not match its artifact type');
  }
  const metadata = await stat(path);
  const minimumBytes = plan.kind === 'activity' ? 32 : 100;
  if (!metadata.isFile() || metadata.size < minimumBytes) {
    throw new Error('Wells Fargo artifact is empty or too small');
  }
  const bytes = await readFile(path);
  if (plan.kind === 'activity') {
    if (bytes.includes(0)) throw new Error('Wells Fargo activity contains binary data');
    const text = new TextDecoder().decode(bytes);
    if (!text.includes(',') || !/[\r\n]/.test(text)) throw new Error('Wells Fargo activity does not have CSV text magic');
    if (!wellsFargoActivityParser.matches({ fileName: plan.fileName, headers: [], sample: text.slice(0, 4096) })) {
      throw new Error('Wells Fargo activity did not match the EasyMoney parser');
    }
    const parsed = await wellsFargoActivityParser.parse({
      fileName: plan.fileName,
      filePath: path,
      headers: [],
      rows: [],
      text,
    });
    const transactions = parsed.transactions.filter((value): value is NonNullable<typeof value> => Boolean(value));
    assertParsedAccount(plan.account, transactions);
    return {
      ...plan,
      byteLength: metadata.size,
      transactionCount: transactions.length,
      balanceCount: parsed.balances.length,
    };
  }

  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('Wells Fargo statement does not have PDF magic');
  }
  if (!wellsFargoStatementParser.matches({ fileName: plan.fileName, headers: [], sample: '' })) {
    throw new Error('Wells Fargo statement did not match the EasyMoney parser');
  }
  const parsed = await wellsFargoStatementParser.parse({
    fileName: plan.fileName,
    filePath: path,
    headers: [],
    rows: [],
    text: '',
  });
  const transactions = parsed.transactions.filter((value): value is NonNullable<typeof value> => Boolean(value));
  const records = [...transactions, ...parsed.balances];
  assertParsedAccount(plan.account, records);
  if (parsed.balances.length === 0) throw new Error('Wells Fargo statement parser returned no balance anchor');
  return {
    ...plan,
    byteLength: metadata.size,
    transactionCount: transactions.length,
    balanceCount: parsed.balances.length,
  };
}

export async function isWellsFargoAuthenticatedPage(
  page: Page,
  timeoutMs = AUTHENTICATION_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (!isWellsFargoOrigin(page.url())) return false;

  const deadline = Date.now() + Math.max(1, timeoutMs);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const state = await page.waitForFunction(() => {
        const visible = (element: Element) => {
          const style = getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
        };
        const hasAuthenticationField = Array.from(document.querySelectorAll(
          'input[type="password"], input[autocomplete="username"]'
        )).some(visible);
        if (hasAuthenticationField) return 'login-required';
        if (!/(?:^|\.)wellsfargo\.com$/i.test(location.hostname)) return 'login-required';
        const hasAuthenticatedMarker = Array.from(document.querySelectorAll('h1, h2, a')).some(element => {
          const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
          return (/^Account Summary$/i.test(text) || /^(?:Sign Off|Sign Out)$/i.test(text)) && visible(element);
        });
        return hasAuthenticatedMarker ? 'authenticated' : null;
      }, undefined, { timeout: Math.max(1, deadline - Date.now()) });
      try {
        return await state.jsonValue() === 'authenticated';
      } finally {
        await state.dispose();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const navigationRace = /execution context was destroyed|cannot find context with specified id/i.test(message);
      if (!navigationRace || attempt >= 4 || Date.now() >= deadline || page.isClosed()) return false;
      await page.waitForLoadState('domcontentloaded', {
        timeout: Math.max(1, deadline - Date.now()),
      }).catch(() => {});
    }
  }
}

export async function waitUntilWellsFargoAuthenticated(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(() => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    const hasAuthenticationField = Array.from(document.querySelectorAll(
      'input[type="password"], input[autocomplete="username"]'
    )).some(visible);
    if (hasAuthenticationField || !/(?:^|\.)wellsfargo\.com$/i.test(location.hostname)) return false;
    return Array.from(document.querySelectorAll('h1, h2, a')).some(element => {
      const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return (/^Account Summary$/i.test(text) || /^(?:Sign Off|Sign Out)$/i.test(text)) && visible(element);
    });
  }, undefined, { timeout: timeoutMs });
}

export async function ensureWellsFargoAccountSummary(page: Page): Promise<void> {
  const heading = page.getByRole('heading', { name: /^Account Summary$/i }).first();
  if (await heading.isVisible().catch(() => false)) return;
  const link = page.getByRole('link', { name: /^Account Summary$/i }).first();
  if (await link.isVisible().catch(() => false)) {
    await link.click();
    await heading.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {
      throw new Error('Wells Fargo account summary did not load');
    });
    return;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null);
    if (!isWellsFargoOrigin(page.url())) break;
    if (await heading.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
      return;
    }
    if (await link.isVisible().catch(() => false)) {
      await link.click();
      await heading.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {
        throw new Error('Wells Fargo account summary did not load');
      });
      return;
    }
  }
  await page.goto(ACCOUNT_SUMMARY_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await heading.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {
    throw new Error('Wells Fargo account summary did not load');
  });
}

export async function discoverWellsFargoAccounts(page: Page): Promise<WellsFargoRemoteAccount[]> {
  await ensureWellsFargoAccountSummary(page);
  const controls = wellsFargoAccountControls(page);
  await controls.first().waitFor({ state: 'attached', timeout: 30_000 }).catch(() => {
    throw new Error('Wells Fargo account metadata did not load');
  });
  const count = await controls.count();
  const candidates: WellsFargoAccountCandidate[] = [];
  for (let index = 0; index < count; index += 1) {
    await ensureWellsFargoAccountSummary(page);
    const control = wellsFargoAccountControls(page).nth(index);
    const label = (await control.textContent())?.replace(/\s+/g, ' ').trim() ?? '';
    if (!wellsFargoAccountLast4FromLabel(label)) continue;
    if (!await clickWellsFargoAccountControl(page, control, {
      allowUnsupportedDestination: true,
    })) continue;
    if (!isWellsFargoOrigin(page.url())) continue;
    const capabilities = await probeWellsFargoAccountCapabilities(page);
    if (!capabilities.activity && !capabilities.statements) continue;
    const observedKind = await wellsFargoAccountKindFromDetailPage(page);
    if (!observedKind) {
      throw new Error('Wells Fargo did not expose a supported account kind on its account detail page');
    }
    candidates.push({ label, observedKind });
  }
  return parseWellsFargoAccountCandidates(candidates);
}

export async function openWellsFargoAccount(page: Page, account: WellsFargoRemoteAccount): Promise<void> {
  await ensureWellsFargoAccountSummary(page);
  const controls = wellsFargoAccountControls(page);
  const labels = await controls.allTextContents();
  const matchingIndices = labels.flatMap((label, index) =>
    wellsFargoAccountLast4FromLabel(label) === account.last4 ? [index] : []
  );
  if (matchingIndices.length !== 1) {
    throw new Error('A Wells Fargo account control has an ambiguous routing identity');
  }
  await clickWellsFargoAccountControl(page, controls.nth(matchingIndices[0]!));
  if (!isWellsFargoOrigin(page.url())) {
    throw new Error('Wells Fargo authentication expired while opening an account');
  }
  const observedKind = await wellsFargoAccountKindFromDetailPage(page);
  if (observedKind !== account.kind) {
    throw new Error('A Wells Fargo account detail page did not match its routing identity');
  }
}

function isWellsFargoOrigin(value: string): boolean {
  return /(?:^|\.)wellsfargo\.com$/i.test(new URL(value).hostname);
}

function wellsFargoAccountControls(page: Page) {
  return page.getByRole('link').filter({ hasText: /Account(?: number)? ending in/i });
}

export async function clickWellsFargoAccountControl(
  page: Page,
  control: ReturnType<Page['getByRole']>,
  options: { allowUnsupportedDestination?: boolean } = {},
): Promise<boolean> {
  const destinationAttribute = await control.getAttribute('href');
  if (destinationAttribute) {
    const destination = asWellsFargoUrl(destinationAttribute, page.url());
    const loginOrigin = new URL(LOGIN_URL).origin;
    const isPrimaryAccountDestination = destination.origin === loginOrigin &&
      !/^\/sso(?:\/|$)/i.test(destination.pathname);
    if (!isPrimaryAccountDestination) {
      if (options.allowUnsupportedDestination) return false;
      throw new Error('A Wells Fargo account control did not target an account detail page');
    }
  }
  await control.click();
  const revealedAccountDetails = await Promise.any([
    page.getByRole('button', { name: /^Download Account Activity$/i }).first()
      .waitFor({ state: 'visible', timeout: 30_000 }),
    page.getByRole('link', { name: /^View Statements$/i }).first()
      .waitFor({ state: 'visible', timeout: 30_000 }),
  ]).then(() => true).catch(() => false);
  if (!revealedAccountDetails) {
    if (options.allowUnsupportedDestination) return false;
    throw new Error('A Wells Fargo account control did not reveal account details');
  }
  return true;
}

async function wellsFargoAccountKindFromDetailPage(
  page: Page,
): Promise<WellsFargoAccountKind | null> {
  const headings = await page.getByRole('heading').allTextContents();
  const kinds = new Set(headings.map(accountKindFromLabel).filter(
    (kind): kind is WellsFargoAccountKind => kind !== null,
  ));
  if (kinds.size > 1) throw new Error('Wells Fargo exposed an ambiguous account kind');
  return [...kinds][0] ?? null;
}

async function probeWellsFargoAccountCapabilities(page: Page): Promise<AccountCapabilities> {
  const activity = page.getByRole('button', { name: /^Download Account Activity$/i }).first();
  const statements = page.getByRole('link', { name: /^View Statements$/i }).first();
  const [hasActivity, hasStatements] = await Promise.all([
    activity.waitFor({ state: 'visible', timeout: 12_000 }).then(() => true).catch(() => false),
    statements.waitFor({ state: 'visible', timeout: 12_000 }).then(() => true).catch(() => false),
  ]);
  return { activity: hasActivity, statements: hasStatements };
}

async function wellsFargoAccountCapabilities(page: Page): Promise<AccountCapabilities> {
  const capabilities = await probeWellsFargoAccountCapabilities(page);
  if (!capabilities.activity && !capabilities.statements) {
    throw new Error('Wells Fargo account exposed no supported artifact controls');
  }
  return capabilities;
}

async function prepareWellsFargoActivityRequest(
  page: Page,
  from: string,
  through: string,
): Promise<WellsFargoApiRequest> {
  const control = page.getByRole('button', { name: /^Download Account Activity$/i }).first();
  await control.click();
  await setWellsFargoActivityDates(page, from, through);
  const csv = page.getByRole('radio', { name: /CSV/i }).first();
  await csv.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {
    throw new Error('Wells Fargo CSV activity option did not load');
  });
  if (!await csv.isChecked()) await csv.check();
  const download = page.getByTestId('download-button').first();
  await download.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="download-button"]');
    return button instanceof HTMLButtonElement && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  }, undefined, { timeout: 30_000 });
  let settleRequest: ((request: WellsFargoApiRequest) => void) | undefined;
  let rejectRequest: ((error: Error) => void) | undefined;
  const observedRequest = new Promise<WellsFargoApiRequest>((resolve, reject) => {
    settleRequest = resolve;
    rejectRequest = reject;
  });
  const routeHandler = async (route: Route): Promise<void> => {
    const request = route.request();
    if (!isWellsFargoActivityDownloadRequest(request) || !settleRequest) {
      await route.continue();
      return;
    }
    const resolve = settleRequest;
    settleRequest = undefined;
    const reject = rejectRequest;
    rejectRequest = undefined;
    try {
      const body = request.postDataBuffer();
      if (!body?.length) throw new Error('Wells Fargo activity API request omitted its body');
      const headers = safeBrowserRequestHeaders(await request.allHeaders());
      const capturedRequest: WellsFargoApiRequest = {
        url: asWellsFargoUrl(request.url()).toString(),
        method: 'POST',
        headers,
        bodyBase64: body.toString('base64'),
      };
      await route.abort('blockedbyclient');
      resolve(capturedRequest);
    } catch (error) {
      reject?.(error instanceof Error ? error : new Error(String(error)));
      await route.abort('failed').catch(() => {});
    }
  };
  await page.route('**/*', routeHandler);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await download.click();
    return await Promise.race([
      observedRequest,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Wells Fargo activity API request was not observed')),
          30_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    await page.unroute('**/*', routeHandler);
  }
}

export async function setWellsFargoActivityDates(
  page: Page,
  from: string,
  through: string,
): Promise<void> {
  const fields = page.getByRole('textbox', { name: /MM\/DD\/YYYY/i });
  await fields.nth(1).waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {
    throw new Error('Wells Fargo activity date controls did not load');
  });
  if (await fields.count() !== 2) throw new Error('Wells Fargo activity date controls are ambiguous');
  const displayDate = (value: string) => {
    const [year, month, day] = value.split('-');
    return `${month}/${day}/${year}`;
  };
  const setValue = (element: Element, value: string) => {
    if (!(element instanceof HTMLInputElement)) {
      throw new Error('Wells Fargo activity date control was not an input');
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Wells Fargo activity date input setter was unavailable');
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  await fields.nth(0).evaluate(setValue, displayDate(from));
  await fields.nth(1).evaluate(setValue, displayDate(through));
}

type WellsFargoStatementRequestCapture = {
  request: WellsFargoApiRequest;
  capturedResponse: BrowserNativeResponse;
};

async function captureWellsFargoStatementRequest(
  page: Page,
  statementDate: string,
  statementControlShape: string,
  statementDestination?: string,
): Promise<WellsFargoStatementRequestCapture> {
  const context = page.context();
  const pageUrl = page.url();
  const pageOrigin = asWellsFargoUrl(pageUrl).origin;
  const existingPages = new Set(context.pages());
  let sameOriginRequestCount = 0;
  let otherWellsOriginRequestCount = 0;
  let documentRequestCount = 0;
  let fetchRequestCount = 0;
  let xhrRequestCount = 0;
  let pdfResponseCount = 0;
  let jsonResponseCount = 0;
  let jsonDocumentMarkerCount = 0;
  let jsonDocumentUrlCount = 0;
  let htmlResponseCount = 0;
  let binaryResponseCount = 0;
  let downloadEventCount = 0;
  let documentMarkerRequestCount = 0;
  let dateMatchedRequestCount = 0;
  const operationNames = new Set<string>();
  const requestPathShapes = new Set<string>();
  let directLinkCount = 0;
  let rejectedDirectLinkCount = 0;
  let postClickShape = 'not-inspected';
  let activationFailureReason = 'none';
  let settleRequest: ((capture: WellsFargoStatementRequestCapture) => void) | undefined;
  let rejectRequest: ((error: Error) => void) | undefined;
  const observedRequests = new Map<string, Request>();
  const observedRequest = new Promise<WellsFargoStatementRequestCapture>((resolve, reject) => {
    settleRequest = resolve;
    rejectRequest = reject;
  });
  const claimRequest = () => {
    if (!settleRequest || !rejectRequest) return null;
    const claim = { resolve: settleRequest, reject: rejectRequest };
    settleRequest = undefined;
    rejectRequest = undefined;
    return claim;
  };
  const captureRequest = async (request: Request): Promise<WellsFargoApiRequest> => {
    const method = request.method().toUpperCase() as 'GET' | 'POST';
    const body = request.postDataBuffer();
    const headers = safeBrowserRequestHeaders(await request.allHeaders());
    return {
      url: asWellsFargoUrl(request.url()).toString(),
      method,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(body?.length ? { bodyBase64: body.toString('base64') } : {}),
    };
  };
  const requestHandler = (request: Request): void => {
    const method = request.method().toUpperCase();
    const resourceType = request.resourceType();
    if ((method !== 'GET' && method !== 'POST') ||
        !['document', 'fetch', 'xhr'].includes(resourceType)) return;
    try {
      const destination = asWellsFargoUrl(request.url());
      const allowedPathSegments = new Set([
        'account', 'accounts', 'activity', 'api', 'auth', 'connect', 'credit-card',
        'document', 'documents', 'download', 'edocs', 'graphql', 'index', 'login',
        'oapi', 'online', 'pdf', 'present', 'retrieve', 'secure', 'statement',
        'statements', 'summary', 'view', 'web',
      ]);
      const pathShape = destination.pathname.split('/').map(segment => {
        const normalized = segment.toLowerCase();
        return !segment || allowedPathSegments.has(normalized) ||
            /^[a-z][a-z-]{0,39}$/i.test(segment)
          ? normalized
          : '*';
      }).join('/');
      requestPathShapes.add(`${method}:${resourceType}:${pathShape}`);
      if (destination.origin === pageOrigin) {
        sameOriginRequestCount += 1;
        observedRequests.set(destination.toString(), request);
        const postData = request.postData() ?? '';
        if (/statement|document|download|pdf/i.test(postData)) {
          documentMarkerRequestCount += 1;
        }
        const [year, month, day] = statementDate.split('-');
        const dateForms = [
          statementDate,
          `${month}/${day}/${year}`,
          `${month}/${day}/${year?.slice(-2)}`,
        ];
        if (dateForms.some(value => value && (
          postData.includes(value) || postData.includes(encodeURIComponent(value))
        ))) {
          dateMatchedRequestCount += 1;
        }
        try {
          const payload = JSON.parse(postData) as { operationName?: unknown };
          if (typeof payload.operationName === 'string' &&
              /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(payload.operationName)) {
            operationNames.add(payload.operationName);
          }
        } catch {
          // Non-JSON request bodies do not expose GraphQL operation metadata.
        }
      } else {
        otherWellsOriginRequestCount += 1;
      }
      if (resourceType === 'document') documentRequestCount += 1;
      if (resourceType === 'fetch') fetchRequestCount += 1;
      if (resourceType === 'xhr') xhrRequestCount += 1;
    } catch {
      // Ignore unrelated third-party requests.
    }
  };
  const pendingResponses = new Set<Promise<void>>();
  const inspectResponse = async (response: Response): Promise<void> => {
    if (!settleRequest || response.status() < 200 || response.status() >= 300) return;
    const request = response.request();
    if (!isWellsFargoReplayableStatementRequest(request, pageUrl)) return;
    const headers: Record<string, string> = await response.allHeaders().catch(() => ({}));
    const contentType = headers['content-type']?.toLowerCase() ?? '';
    const disposition = headers['content-disposition']?.toLowerCase() ?? '';
    if (contentType.includes('json')) jsonResponseCount += 1;
    if (contentType.includes('html')) htmlResponseCount += 1;
    if (contentType.includes('octet-stream')) binaryResponseCount += 1;
    const body = await response.body().catch(() => null);
    if (body && contentType.includes('json') &&
        /statement|document|download|pdf/i.test(body.toString('utf8'))) {
      jsonDocumentMarkerCount += 1;
    }
    const documentUrls = body && contentType.includes('json')
      ? wellsFargoDocumentUrlsFromJson(body, pageUrl)
      : [];
    jsonDocumentUrlCount += documentUrls.length;
    const capturedResponse = body
      ? wellsFargoCapturedStatementResponse({
          status: response.status(),
          url: response.url(),
          headers,
          redirected: request.redirectedFrom() !== null,
        }, body, pageUrl)
      : null;
    const hasPdf = Boolean(capturedResponse) ||
      contentType.includes('pdf') || /\.pdf(?:"|;|$)/i.test(disposition);
    if (!capturedResponse) return;
    if (hasPdf) pdfResponseCount += 1;
    const claim = claimRequest();
    if (!claim) return;
    try {
      claim.resolve({
        request: await captureRequest(request),
        capturedResponse,
      });
    } catch (error) {
      claim.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const responseHandler = (response: Response): void => {
    const task = inspectResponse(response);
    pendingResponses.add(task);
    void task.finally(() => pendingResponses.delete(task));
  };
  const pendingDownloads = new Set<Promise<void>>();
  const inspectDownload = async (download: Download): Promise<void> => {
    downloadEventCount += 1;
    const url = download.url();
    const observed = observedRequests.get(url);
    let captured: WellsFargoApiRequest | undefined;
    let capturedResponse: BrowserNativeResponse | null = null;
    try {
      if (observed && isWellsFargoReplayableStatementRequest(observed, pageUrl)) {
        captured = await captureRequest(observed);
      } else {
        const destination = asWellsFargoUrl(url);
        if (destination.origin === pageOrigin) {
          captured = { url: destination.toString(), method: 'GET' };
        }
      }
      const stream = await download.createReadStream();
      if (stream) {
        const chunks: Buffer[] = [];
        let byteLength = 0;
        for await (const chunk of stream) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          byteLength += bytes.length;
          if (byteLength > MAX_STATEMENT_BYTES) {
            throw new Error('Wells Fargo statement download exceeded the supported size');
          }
          chunks.push(bytes);
        }
        const body = Buffer.concat(chunks);
        capturedResponse = wellsFargoCapturedStatementResponse({
          status: 200,
          url,
          headers: { 'content-type': 'application/pdf' },
          redirected: false,
        }, body, pageUrl);
      }
    } catch {
      // Fail closed below if this is not a same-origin Wells document download.
    }
    await download.cancel().catch(() => {});
    await download.delete().catch(() => {});
    if (!captured || !capturedResponse) return;
    claimRequest()?.resolve({ request: captured, capturedResponse });
  };
  const downloadHandler = (download: Download): void => {
    const task = inspectDownload(download);
    pendingDownloads.add(task);
    void task.finally(() => pendingDownloads.delete(task));
  };
  const downloadPages = new Set<Page>();
  const attachDownloadHandler = (candidatePage: Page): void => {
    if (downloadPages.has(candidatePage)) return;
    downloadPages.add(candidatePage);
    candidatePage.on('download', downloadHandler);
  };
  const pageHandler = (candidatePage: Page): void => attachDownloadHandler(candidatePage);
  for (const candidatePage of context.pages()) attachDownloadHandler(candidatePage);
  context.on('page', pageHandler);
  const routeHandler = async (route: Route): Promise<void> => {
    const request = route.request();
    if (!isWellsFargoStatementDownloadRequest(request, pageUrl)) {
      await route.continue();
      return;
    }
    const claim = claimRequest();
    if (!claim) {
      await route.abort('blockedbyclient');
      return;
    }
    try {
      const capturedRequest = await captureRequest(request);
      const response = await runBrowserNativeRouteRequest(page, route, 30_000);
      const capturedResponse = wellsFargoCapturedStatementResponse({
        status: response.status,
        url: response.url,
        headers: response.headers,
        redirected: response.redirected,
      }, browserNativeResponseBody(response), pageUrl);
      await route.abort('blockedbyclient');
      if (!capturedResponse) {
        throw new Error(
          `Wells Fargo statement browser request did not return a PDF (status=${response.status})`,
        );
      }
      claim.resolve({ request: capturedRequest, capturedResponse });
    } catch (error) {
      claim.reject(error instanceof Error ? error : new Error(String(error)));
      await route.abort('failed').catch(() => {});
    }
  };
  context.on('request', requestHandler);
  context.on('response', responseHandler);
  await context.route('**/edocs/documents/retrieve/**', routeHandler);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const click = (async () => {
    const dateVariants = wellsFargoStatementDateTextVariants(statementDate);
    const datePattern = new RegExp(dateVariants.map(variant =>
      variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    ).join('|'), 'i');
    const resolutionDeadline = Date.now() + 5_000;
    let lastMatchingControlCount = 0;
    while (Date.now() < resolutionDeadline) {
      const matchingControlSets: Array<ReturnType<Page['locator']>> = [];
      let matchingControlCount = 0;
      for (const candidatePage of context.pages().filter(item => !item.isClosed())) {
        for (const frame of candidatePage.frames()) {
          if (statementDestination) {
            const links = frame.locator('a[href*="' + STATEMENT_PATH_PREFIX + '"]');
            const destinations = await links.evaluateAll(elements => elements.map(element =>
              element instanceof HTMLAnchorElement ? element.href : ''
            )).catch(() => []);
            for (let index = 0; index < destinations.length; index += 1) {
              if (wellsFargoStatementDocumentUrl(destinations[index] ?? '', pageUrl) !==
                  statementDestination) continue;
              matchingControlSets.push(links.nth(index));
              matchingControlCount += 1;
            }
          } else {
            const controls = frame.locator('a[role="link"][tabindex]').filter({ hasText: datePattern });
            const count = await controls.count().catch(() => 0);
            if (count > 0) matchingControlSets.push(controls);
            matchingControlCount += count;
          }
        }
      }
      lastMatchingControlCount = matchingControlCount;
      if (matchingControlCount > 1 || matchingControlSets.length > 1) {
        throw new Error(`Wells Fargo statement control could not be resolved (matches=${matchingControlCount})`);
      }
      if (matchingControlCount === 1 && matchingControlSets.length === 1) {
        const clicked = await matchingControlSets[0]!.first().click({
          force: true,
          noWaitAfter: true,
          timeout: 1_000,
        }).then(() => true).catch(() => false);
        if (clicked) return;
      }
      await page.waitForTimeout(100).catch(() => {});
    }
    throw new Error(
      `Wells Fargo statement control could not be resolved (matches=${lastMatchingControlCount})`,
    );
  })().catch(error => {
    const errorMessage = error instanceof Error ? error.message : '';
    const safeResolution = errorMessage.match(/\(matches=(\d+)\)$/)?.[1];
    activationFailureReason = safeResolution !== undefined
      ? `match-count-${safeResolution}`
      : error instanceof Error && error.name === 'TimeoutError'
        ? 'timeout'
        : 'rejected';
  });
  let directLinkActivated = false;
  const postClickProbe = (async () => {
    await click;
    await page.waitForTimeout(250).catch(() => {});
    const localShapes: string[] = [];
    let matchingDateControlCount = 0;
    let dialogCount = 0;
    let embeddedDocumentCount = 0;
    for (const candidatePage of context.pages().filter(item => !item.isClosed())) {
      for (const frame of candidatePage.frames()) {
        const dateControls = frame.locator('a[role="link"][tabindex]');
        const dateControlTexts = await dateControls.allTextContents().catch(() => []);
        for (let index = 0; index < dateControlTexts.length; index += 1) {
          if (wellsFargoDateFromText(dateControlTexts[index] ?? '') !== statementDate) continue;
          matchingDateControlCount += 1;
          const localShape = await dateControls.nth(index).evaluate(target => {
            const visible = (element: Element) => {
              if (!(element instanceof HTMLElement)) return false;
              const style = getComputedStyle(element);
              const box = element.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' &&
                box.width > 0 && box.height > 0;
            };
            const classShape = (element: Element) => [...element.classList]
              .filter(value => /^[A-Za-z_-]{1,40}$/.test(value))
              .slice(0, 3)
              .join('.') || 'none';
            const controlShape = (element: Element) => {
              const label = [
                element.textContent ?? '',
                element.getAttribute('aria-label') ?? '',
                element.getAttribute('title') ?? '',
              ].join(' ');
              const kind = /download/i.test(label) ? 'download'
                : /\bview\b/i.test(label) ? 'view'
                  : /pdf/i.test(label) ? 'pdf'
                    : /statement|document/i.test(label) ? 'document'
                      : 'other';
              return [
                element.tagName.toLowerCase(),
                element.getAttribute('role') ?? 'none',
                element instanceof HTMLInputElement ? element.type || 'text' : 'none',
                kind,
                classShape(element),
              ].join('.');
            };
            const ancestorShapes: string[] = [];
            let ancestor: Element | null = target;
            for (let depth = 0; ancestor && depth <= 6; depth += 1) {
              const controls = [
                ...(ancestor.matches('a, button, input, [role="button"], [role="link"], [tabindex]')
                  ? [ancestor]
                  : []),
                ...ancestor.querySelectorAll(
                  'a, button, input, [role="button"], [role="link"], [tabindex]',
                ),
              ].filter((element, controlIndex, all) =>
                all.indexOf(element) === controlIndex && visible(element)
              );
              ancestorShapes.push(
                `${depth}-${ancestor.tagName.toLowerCase()}.${classShape(ancestor)}` +
                `[${controls.slice(0, 6).map(controlShape).join('+') || 'none'}]`,
              );
              ancestor = ancestor.parentElement;
            }
            return [
              `expanded=${target.getAttribute('aria-expanded') ?? 'none'}`,
              `selected=${target.getAttribute('aria-selected') ?? 'none'}`,
              `ancestors=${ancestorShapes.join('>')}`,
            ].join(':');
          }).catch(() => 'resolved=false');
          localShapes.push(localShape);
        }
        dialogCount += await frame.locator('[role="dialog"], [aria-modal="true"]').count().catch(() => 0);
        embeddedDocumentCount += await frame.locator('iframe, embed[type*="pdf"], object[type*="pdf"]').count()
          .catch(() => 0);
      }
    }
    postClickShape = `matches=${matchingDateControlCount}:` +
      `${localShapes.join('|') || 'none'}:dialogs=${dialogCount}:embedded=${embeddedDocumentCount}`;
    const probeDeadline = Date.now() + 12_000;
    while (settleRequest && Date.now() < probeDeadline) {
      const observedLinks: Array<{
        value: string;
        destination: string;
        control: ReturnType<Page['locator']>;
      }> = [];
      for (const candidatePage of context.pages().filter(item => !item.isClosed())) {
        for (const frame of candidatePage.frames()) {
          const links = frame.locator('a[href*="' + STATEMENT_PATH_PREFIX + '"]');
          const linkMetadata = await links.evaluateAll(elements => elements.map(element => {
            const destination = element instanceof HTMLAnchorElement ? element.href : '';
            const parentText = element.parentElement?.textContent ?? '';
            return {
              value: (element.textContent ?? '') + ' ' + parentText + ' ' + destination,
              destination,
            };
          })).catch(() => []);
          observedLinks.push(...linkMetadata.map((metadata, index) => ({
            ...metadata,
            control: links.nth(index),
          })));
        }
      }
      directLinkCount = observedLinks.length;
      const dateMatchedLinks = observedLinks.filter(candidate =>
        wellsFargoDateFromText(candidate.value) === statementDate
      );
      const selectedLink = dateMatchedLinks.length === 1
        ? dateMatchedLinks[0]
        : observedLinks.length === 1 ? observedLinks[0] : undefined;
      if (selectedLink) {
        const destination = wellsFargoStatementDocumentUrl(selectedLink.destination, pageUrl);
        if (destination && !directLinkActivated) {
          directLinkActivated = true;
          const activated = await selectedLink.control.click({
            force: true,
            noWaitAfter: true,
            timeout: 1_000,
          }).then(() => true).catch(() => false);
          if (!activated) activationFailureReason = 'direct-link-rejected';
          continue;
        }
        if (!destination) rejectedDirectLinkCount += 1;
      }
      await page.waitForTimeout(250).catch(() => {});
    }
  })();
  try {
    return await Promise.race([
      observedRequest,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(
          'Wells Fargo statement API request was not observed ' +
          `(activation=${activationFailureReason} post-click=${postClickShape} ` +
          `control-shape=${statementControlShape} ` +
          `same-origin=${sameOriginRequestCount} other-wells-origin=${otherWellsOriginRequestCount} ` +
          `operations=${[...operationNames].sort().join(',') || 'none'} ` +
          `path-shapes=${[...requestPathShapes].sort().join(',') || 'none'} ` +
          `request-document-markers=${documentMarkerRequestCount} date-matched-requests=${dateMatchedRequestCount} ` +
          `document=${documentRequestCount} fetch=${fetchRequestCount} xhr=${xhrRequestCount} ` +
          `pdf-responses=${pdfResponseCount} json-responses=${jsonResponseCount} ` +
          `json-document-markers=${jsonDocumentMarkerCount} json-document-urls=${jsonDocumentUrlCount} ` +
          `html-responses=${htmlResponseCount} ` +
          `binary-responses=${binaryResponseCount} download-events=${downloadEventCount} ` +
          `direct-links=${directLinkCount} rejected-direct-links=${rejectedDirectLinkCount} ` +
          `new-pages=${context.pages().filter(candidate => !existingPages.has(candidate)).length})`,
        )), 12_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    settleRequest = undefined;
    rejectRequest = undefined;
    context.off('request', requestHandler);
    context.off('response', responseHandler);
    context.off('page', pageHandler);
    for (const candidatePage of downloadPages) candidatePage.off('download', downloadHandler);
    await context.unroute('**/edocs/documents/retrieve/**', routeHandler);
    await Promise.allSettled([...pendingResponses]);
    await Promise.allSettled([...pendingDownloads]);
    await Promise.race([
      click,
      new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, 2_000)),
    ]);
    await Promise.race([
      postClickProbe,
      new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, 2_000)),
    ]);
    await Promise.allSettled(context.pages()
      .filter(candidatePage => !existingPages.has(candidatePage) && !candidatePage.isClosed())
      .map(candidatePage => Promise.race([
        candidatePage.close({ runBeforeUnload: false }),
        new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, 2_000)),
      ])));
    if (!await restoreWellsFargoStatementPage(page, pageUrl)) {
      throw new Error('Wells Fargo statement page could not be restored after request capture');
    }
  }
}

async function discoverWellsFargoStatements(
  page: Page,
  account: WellsFargoAccountIdentity,
  from: string,
  through: string,
): Promise<WellsFargoStatementCandidate[]> {
  const control = page.getByRole('link', { name: /^View Statements$/i }).first();
  await control.click();
  const accountCombobox = page.getByRole('combobox', { name: /account/i }).first();
  await accountCombobox.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {
    throw new Error('Wells Fargo statement account selector did not load');
  });
  await accountCombobox.click();
  const accountOptions = page.getByRole('option');
  await accountOptions.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {
    throw new Error('Wells Fargo statement account options did not load');
  });
  const matchingAccountOptions = (await accountOptions.allTextContents())
    .map((label, index) => ({ label, index }))
    .filter(({ label }) => wellsFargoAccountLast4FromLabel(label) === account.last4);
  if (matchingAccountOptions.length !== 1) {
    throw new Error('Wells Fargo statement account selection was missing or ambiguous');
  }
  await accountOptions.nth(matchingAccountOptions[0]!.index).click();

  const accountOptionCount = await accountOptions.count();
  const accountSelectionConfirmed = (
    (await accountCombobox.textContent().catch(() => '')) ?? ''
  ).includes(account.last4);
  let periodOptionCount = 0;
  let periodChoice = 'not-selected';
  let periodSelectionConfirmed = false;
  const periodCombobox = page.getByRole('combobox', { name: /year|period|date|month/i }).first();
  if (await periodCombobox.isVisible()) {
    await periodCombobox.click();
    const periodOptions = page.getByRole('option');
    await periodOptions.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    periodOptionCount = await periodOptions.count();
    const throughYear = through.slice(0, 4);
    const ranked = (await periodOptions.allTextContents()).map((label, index) => {
      const normalized = label.replace(/\s+/g, ' ').trim();
      const months = normalized.match(/\b(?:last\s+)?(\d{1,2})\s+months?\b/i);
      const years = normalized.match(/\b(?:last\s+)?(\d{1,2})\s+years?\b/i);
      const score = /\ball\b/i.test(normalized) ? 10_000
        : months ? Number(months[1])
          : years ? Number(years[1]) * 12
            : new RegExp(`^${throughYear}$`).test(normalized) ? 12
              : 0;
      const kind = /\ball\b/i.test(normalized) ? 'all'
        : months ? 'months'
          : years ? 'years'
            : new RegExp(`^${throughYear}$`).test(normalized) ? 'year'
              : 'none';
      return { index, score, kind };
    }).filter(option => option.score > 0).sort((left, right) => right.score - left.score);
    if (ranked[0]) {
      await periodOptions.nth(ranked[0].index).click();
      periodChoice = ranked[0].kind;
      const selectedPeriodText = (await periodCombobox.textContent().catch(() => '')) ?? '';
      periodSelectionConfirmed = periodChoice === 'year'
        ? selectedPeriodText.includes(throughYear)
        : selectedPeriodText.trim().length > 0;
    } else {
      await page.keyboard.press('Escape');
    }
  }
  const applyControls = page.getByRole('button', { name: /^(?:Go|Apply|Search|View)$/i });
  const applyControlCount = await applyControls.count();
  if (applyControlCount === 1 && await applyControls.first().isVisible()) {
    await applyControls.first().click();
  }
  const deadline = Date.now() + 30_000;
  let candidates: Array<{ value: string; destination: string }> = [];
  let statementControls: Array<{ date: string; shape: string }> = [];
  let stableFingerprint = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    const observedCandidates: typeof candidates = [];
    const observedControls: typeof statementControls = [];
    for (const candidatePage of page.context().pages().filter(item => !item.isClosed())) {
      for (const frame of candidatePage.frames()) {
        const links = frame.locator(`a[href*="${STATEMENT_PATH_PREFIX}"]`);
        const frameCandidates = await links.evaluateAll(elements => elements.map(element => {
          const destination = element instanceof HTMLAnchorElement ? element.href : '';
          const value = `${element.textContent ?? ''} ${destination}`;
          return { value, destination };
        })).catch(() => []);
        observedCandidates.push(...frameCandidates.flatMap(candidate => {
          const destination = wellsFargoStatementDocumentUrl(
            candidate.destination,
            candidatePage.url(),
          );
          return destination ? [{ ...candidate, destination }] : [];
        }));
        const markedControls = await frame.locator('body').evaluate(body => {
          const datePattern = /\b(?:20\d{2}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-](?:\d{2}|\d{4})|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+20\d{2})\b/i;
          const statementIdentity = (element: Element) => [
            element.getAttribute('class') ?? '',
            element.getAttribute('data-testid') ?? '',
            element.getAttribute('id') ?? '',
          ].join(' ');
          const visible = (element: Element) => {
            if (!(element instanceof HTMLElement)) return false;
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' &&
              box.width > 0 && box.height > 0;
          };
          const results: Array<{ dateText: string; shape: string }> = [];
          const marked = new Set<Element>();
          const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node) {
            const match = node.nodeValue?.match(datePattern);
            const origin = node.parentElement;
            if (match && origin) {
              let container: Element | null = origin;
              let distance = 0;
              while (container && distance <= 6 &&
                  !/statement|document/i.test(statementIdentity(container))) {
                container = container.parentElement;
                distance += 1;
              }
              if (container && distance <= 6) {
                const nearest = origin.closest('a, button, [role="button"], [tabindex="0"]');
                const controls = [...container.querySelectorAll(
                  'a, button, [role="button"], [tabindex="0"]',
                )].filter(element => visible(element) &&
                  !/contact|support|customer service/i.test(element.textContent ?? ''));
                const documentControls = controls.filter(element =>
                  /download|view|statement|document|pdf/i.test([
                    element.textContent ?? '',
                    element.getAttribute('aria-label') ?? '',
                    element.getAttribute('title') ?? '',
                  ].join(' '))
                );
                const target = documentControls.length === 1
                  ? documentControls[0]
                  : nearest && container.contains(nearest) && visible(nearest) &&
                      !/contact|support|customer service/i.test(nearest.textContent ?? '')
                    ? nearest
                    : controls.length === 1 ? controls[0] : null;
                if (target && !marked.has(target)) {
                  marked.add(target);
                  const classShape = (element: Element) => [...element.classList]
                    .filter(value => /^[A-Za-z_-]{1,40}$/.test(value))
                    .slice(0, 4)
                    .join('.') || 'none';
                  const inputTypes = [...container.querySelectorAll('input')].map(input =>
                    input.type || 'text'
                  );
                  const ownPropertyNames = Object.getOwnPropertyNames(target);
                  const frameworkPropsKey = ownPropertyNames.find(name =>
                    name.startsWith('__reactProps$') || name.startsWith('__vueParentComponent')
                  );
                  const frameworkProps = frameworkPropsKey
                    ? (target as unknown as Record<string, unknown>)[frameworkPropsKey]
                    : undefined;
                  const frameworkRecord = frameworkProps && typeof frameworkProps === 'object'
                    ? frameworkProps as Record<string, unknown>
                    : undefined;
                  const targetStyle = getComputedStyle(target);
                  const targetBox = target.getBoundingClientRect();
                  results.push({
                    dateText: match[0],
                    shape: [
                      `target=${target.tagName.toLowerCase()}`,
                      `role=${target.getAttribute('role') ?? 'none'}`,
                      `href=${target.hasAttribute('href')}`,
                      `tabindex=${target.hasAttribute('tabindex')}`,
                      `attrs=${target.getAttributeNames().sort().slice(0, 8).join('.') || 'none'}`,
                      `classes=${classShape(target)}`,
                      `container=${container.tagName.toLowerCase()}.${classShape(container)}`,
                      `distance=${distance}`,
                      `controls=${controls.length}`,
                      `inputs=${inputTypes.length}`,
                      `checkboxes=${inputTypes.filter(value => value === 'checkbox').length}`,
                      `radios=${inputTypes.filter(value => value === 'radio').length}`,
                      `native-click=${target instanceof HTMLElement && typeof target.onclick === 'function'}`,
                      `framework-click=${typeof frameworkRecord?.onClick === 'function'}`,
                      `framework-keydown=${typeof frameworkRecord?.onKeyDown === 'function'}`,
                      `pointer=${targetStyle.pointerEvents}`,
                      `cursor=${targetStyle.cursor}`,
                      `box=${targetBox.width > 0 && targetBox.height > 0}`,
                    ].join(':'),
                  });
                }
              }
            }
            node = walker.nextNode();
          }
          return results;
        }).catch(() => []);
        for (const markedControl of markedControls) {
          const date = wellsFargoDateFromText(markedControl.dateText);
          if (date) {
            observedControls.push({
              date,
              shape: markedControl.shape,
            });
          }
        }
      }
    }
    const fingerprint = JSON.stringify({
      directDates: observedCandidates.map(candidate => wellsFargoDateFromText(candidate.value)).sort(),
      controlDates: observedControls.map(control => control.date).sort(),
    });
    if (observedCandidates.length === 0 && observedControls.length === 0) {
      stableFingerprint = '';
      stableSince = 0;
    } else if (fingerprint !== stableFingerprint) {
      stableFingerprint = fingerprint;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 2_000) {
      candidates = observedCandidates;
      statementControls = observedControls;
      break;
    }
    await page.waitForTimeout(250);
  }
  if (candidates.length === 0 && statementControls.length === 0) {
    let frameCount = 0;
    let linkCount = 0;
    let statementLikeLinkCount = 0;
    let buttonCount = 0;
    let statementControlCount = 0;
    let downloadControlCount = 0;
    let dateControlCount = 0;
    let comboboxCount = 0;
    let accountComboboxCount = 0;
    let periodComboboxCount = 0;
    const comboboxShapes: string[] = [];
    let dateBearingElementCount = 0;
    let statementDataElementCount = 0;
    let bodyDateCount = 0;
    let bodyHasNoDocuments = false;
    let bodyHasPdf = false;
    let bodyHasSelectionPrompt = false;
    let dateRowCount = 0;
    let dateRowButtonCount = 0;
    let dateRowLinkCount = 0;
    let dateRowClickableCount = 0;
    const openPages = page.context().pages().filter(item => !item.isClosed());
    for (const candidatePage of openPages) {
      for (const frame of candidatePage.frames()) {
        frameCount += 1;
        const counts = await frame.locator('a[href]').evaluateAll(elements => ({
          linkCount: elements.length,
          statementLikeLinkCount: elements.filter(element => {
            if (!(element instanceof HTMLAnchorElement)) return false;
            try {
              return /statement|document|edocs|\.pdf(?:$|[?#])/i.test(new URL(element.href).pathname);
            } catch {
              return false;
            }
          }).length,
        })).catch(() => ({ linkCount: 0, statementLikeLinkCount: 0 }));
        linkCount += counts.linkCount;
        statementLikeLinkCount += counts.statementLikeLinkCount;
        const controls = await frame.locator('button, [role="button"], input, select, [role="combobox"]')
          .evaluateAll(elements => {
            const labels = elements.map(element => [
              element.textContent ?? '',
              element.getAttribute('aria-label') ?? '',
              element.getAttribute('title') ?? '',
              element instanceof HTMLInputElement ? element.value : '',
            ].join(' ').replace(/\s+/g, ' ').trim());
            return {
              buttonCount: elements.filter(element =>
                element instanceof HTMLButtonElement || element.getAttribute('role') === 'button'
              ).length,
              statementControlCount: labels.filter(label => /statement|document/i.test(label)).length,
              downloadControlCount: labels.filter(label => /download|view|pdf/i.test(label)).length,
              dateControlCount: labels.filter(label =>
                /\b20\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(label)
              ).length,
              comboboxCount: elements.filter(element =>
                element instanceof HTMLSelectElement || element.getAttribute('role') === 'combobox'
              ).length,
            };
          }).catch(() => ({
            buttonCount: 0,
            statementControlCount: 0,
            downloadControlCount: 0,
            dateControlCount: 0,
            comboboxCount: 0,
          }));
        buttonCount += controls.buttonCount;
        statementControlCount += controls.statementControlCount;
        downloadControlCount += controls.downloadControlCount;
        dateControlCount += controls.dateControlCount;
        comboboxCount += controls.comboboxCount;
        accountComboboxCount += await frame.getByRole('combobox', { name: /account/i }).count();
        periodComboboxCount += await frame.getByRole('combobox', {
          name: /year|period|date|month/i,
        }).count();
        const shapes = await frame.locator('select, [role="combobox"]').evaluateAll(elements =>
          elements.map(element => {
            const options = element instanceof HTMLSelectElement
              ? [...element.options].map(option => option.textContent ?? '')
              : [];
            return [
              element instanceof HTMLSelectElement ? 'select' : 'custom',
              options.length,
              options.filter(value => /\b20\d{2}\b/.test(value)).length,
              options.filter(value => /\b\d{4}\b/.test(value)).length,
            ].join(':');
          })
        ).catch(() => []);
        comboboxShapes.push(...shapes);
        const bodyText = await frame.locator('body').innerText().catch(() => '');
        bodyDateCount += (bodyText.match(
          /\b(?:20\d{2}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-](?:\d{2}|\d{4})|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+20\d{2})\b/gi,
        )?.length ?? 0);
        bodyHasNoDocuments ||= /\bno\b.{0,40}\b(?:statement|document)s?\b/i.test(bodyText);
        bodyHasPdf ||= /\bpdf\b/i.test(bodyText);
        bodyHasSelectionPrompt ||= /\b(?:choose|select)\b.{0,40}\b(?:account|year|period|date)\b/i.test(bodyText);
        dateBearingElementCount += await frame.locator('button, a, [role="button"], [role="row"], tr, li')
          .evaluateAll(elements => elements.filter(element => {
            const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
            return /\b(?:20\d{2}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-](?:\d{2}|\d{4})|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+20\d{2})\b/i.test(text);
          }).length).catch(() => 0);
        statementDataElementCount += await frame.locator(
          '[data-testid*="statement" i], [data-testid*="document" i], [class*="statement" i], [class*="document" i]',
        ).count().catch(() => 0);
        const dateRows = await frame.locator('[role="row"], tr, li').evaluateAll(elements => {
          const datePattern = /\b(?:20\d{2}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-](?:\d{2}|\d{4})|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+20\d{2})\b/i;
          const rows = elements.filter(element => datePattern.test(
            element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          ));
          return {
            rowCount: rows.length,
            buttonCount: rows.reduce((count, row) => count + row.querySelectorAll('button, [role="button"]').length, 0),
            linkCount: rows.reduce((count, row) => count + row.querySelectorAll('a[href]').length, 0),
            clickableCount: rows.reduce((count, row) => count + row.querySelectorAll(
              'button, [role="button"], a[href], [tabindex="0"]',
            ).length, 0),
          };
        }).catch(() => ({ rowCount: 0, buttonCount: 0, linkCount: 0, clickableCount: 0 }));
        dateRowCount += dateRows.rowCount;
        dateRowButtonCount += dateRows.buttonCount;
        dateRowLinkCount += dateRows.linkCount;
        dateRowClickableCount += dateRows.clickableCount;
      }
    }
    throw new Error(
      'Wells Fargo statement metadata did not expose direct document links ' +
      `(pages=${openPages.length} frames=${frameCount} links=${linkCount} statement-like=${statementLikeLinkCount} ` +
      `buttons=${buttonCount} statement-controls=${statementControlCount} download-controls=${downloadControlCount} ` +
      `date-controls=${dateControlCount} comboboxes=${comboboxCount} account-comboboxes=${accountComboboxCount} ` +
      `period-comboboxes=${periodComboboxCount} account-options=${accountOptionCount} ` +
      `period-options=${periodOptionCount} period-choice=${periodChoice} apply-controls=${applyControlCount} ` +
      `account-selected=${accountSelectionConfirmed} period-selected=${periodSelectionConfirmed} ` +
      `body-dates=${bodyDateCount} date-elements=${dateBearingElementCount} statement-elements=${statementDataElementCount} ` +
      `date-rows=${dateRowCount} date-row-buttons=${dateRowButtonCount} date-row-links=${dateRowLinkCount} ` +
      `date-row-clickables=${dateRowClickableCount} ` +
      `no-documents=${bodyHasNoDocuments} pdf=${bodyHasPdf} selection-prompt=${bodyHasSelectionPrompt} ` +
      `combobox-shapes=${comboboxShapes.join(',') || 'none'})`,
    );
  }
  const directStatements = candidates.map(candidate => {
    const date = wellsFargoDateFromText(candidate.value);
    if (!date) throw new Error('Wells Fargo statement metadata omitted its date');
    return {
      date,
      destination: candidate.destination,
    };
  });
  const directDates = new Set(directStatements.map(candidate => candidate.date));

  const controlsByDate = new Map<string, { date: string; shape: string }>();
  for (const statementControl of statementControls) {
    if (directDates.has(statementControl.date)) continue;
    if (controlsByDate.has(statementControl.date)) {
      throw new Error('Wells Fargo exposed multiple statement controls for one account and date');
    }
    controlsByDate.set(statementControl.date, statementControl);
  }
  const selectedSources = selectWellsFargoStatementWindow(
    [
      ...directStatements.map(statement => ({ date: statement.date, statement })),
      ...[...controlsByDate.values()].map(statementControl => ({
        date: statementControl.date,
        statementControl,
      })),
    ],
    from,
    through,
  );
  const capturedStatements: WellsFargoStatementCandidate[] = [];
  for (const source of selectedSources) {
    const statementDate = 'statement' in source
      ? source.statement.date
      : source.statementControl.date;
    const capture = await captureWellsFargoStatementRequest(
      page,
      statementDate,
      'statement' in source ? 'verified-direct-link' : source.statementControl.shape,
      'statement' in source ? source.statement.destination : undefined,
    );
    capturedStatements.push({
      date: statementDate,
      request: capture.request,
      capturedResponse: capture.capturedResponse,
      verification: 'observed-document-response',
    });
  }
  return selectWellsFargoStatements(capturedStatements, from, through);
}

async function executeWellsFargoApiRequest(
  page: Page,
  request: WellsFargoApiRequest,
): Promise<BrowserNativeResponse> {
  asWellsFargoUrl(request.url);
  const encodedBody = request.bodyBase64 ?? (
    request.method === 'POST' && request.body !== undefined
      ? Buffer.from(request.body, 'utf8').toString('base64')
      : undefined
  );
  const response = await runBrowserNativeRequest(page, {
    url: request.url,
    method: request.method,
    ...(request.headers || request.body !== undefined ? {
      headers: {
        ...(request.body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...request.headers,
      },
    } : {}),
    ...(encodedBody !== undefined ? { bodyBase64: encodedBody } : {}),
  });
  asWellsFargoUrl(response.url);
  return response;
}

export function wellsFargoActivityBodyFromApiResponse(
  response: BrowserNativeResponse,
): Buffer {
  if (!browserNativeResponseOk(response)) {
    throw new Error(`Wells Fargo activity API returned status ${response.status}`);
  }
  const contentType = response.headers['content-type']?.toLowerCase() ?? '';
  if (!contentType.includes('json')) {
    throw new Error('Wells Fargo activity API did not return JSON');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(browserNativeResponseBody(response).toString('utf8'));
  } catch {
    throw new Error('Wells Fargo activity API returned invalid JSON');
  }
  const download = payload && typeof payload === 'object' && 'data' in payload &&
    payload.data && typeof payload.data === 'object' && 'downloadAccountData' in payload.data
    ? payload.data.downloadAccountData
    : null;
  if (!download || typeof download !== 'object' ||
      !('status' in download) || download.status !== true ||
      !('activities' in download) || typeof download.activities !== 'string') {
    throw new Error('Wells Fargo activity API response omitted a completed download');
  }
  const raw = download.activities;
  const csvBody = (value: string): Buffer | null => {
    const body = Buffer.from(value, 'utf8');
    const sample = body.subarray(0, Math.min(body.length, 4096));
    return !sample.includes(0) && sample.includes(44) && /[\r\n]/.test(sample.toString('utf8'))
      ? body
      : null;
  };
  const directCsv = csvBody(raw);
  if (directCsv) return directCsv;
  if (/%[0-9a-f]{2}/i.test(raw)) {
    try {
      const percentEncodedCsv = csvBody(decodeURIComponent(raw));
      if (percentEncodedCsv) return percentEncodedCsv;
    } catch {
      // Continue to the strict encoded-body validation below.
    }
  }
  const trimmed = raw.trim();
  const dataUri = /^data:(?:text\/csv|application\/(?:csv|octet-stream|vnd\.ms-excel))(?:;charset=[^;,]+)?;base64,([\s\S]*)$/i
    .exec(trimmed);
  const wrapper = dataUri ? 'data-uri' : /^data:/i.test(trimmed) ? 'other' : 'none';
  const compact = (dataUri?.[1] ?? trimmed).replace(/\s+/g, '');
  const unpadded = compact.replace(/=+$/, '');
  const paddingLength = compact.length - unpadded.length;
  const usesUrlSafeAlphabet = /[-_]/.test(unpadded);
  const hasInvalidPadding = /=/.test(unpadded) || paddingLength > 2;
  const hasInvalidAlphabet = !/^[A-Za-z0-9+/_-]+$/.test(unpadded);
  const remainder = unpadded.length % 4;
  const shape = [
    `wrapper=${wrapper}`,
    `alphabet=${hasInvalidAlphabet ? 'other' : usesUrlSafeAlphabet ? 'url-safe' : 'standard'}`,
    `padding=${compact.endsWith('=') ? 'present' : 'none'}`,
    `length-mod-4=${remainder}`,
  ].join(' ');
  if (wrapper === 'other' || !unpadded || hasInvalidPadding || hasInvalidAlphabet || remainder === 1) {
    throw new Error(`Wells Fargo activity API response contained invalid base64 (${shape})`);
  }
  const normalized = unpadded
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(unpadded.length + ((4 - remainder) % 4), '=');
  const body = Buffer.from(normalized, 'base64');
  if (body.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) {
    throw new Error(`Wells Fargo activity API response contained invalid base64 (${shape})`);
  }
  return body;
}

function wellsFargoPdfBodyFromBytes(body: Buffer): Buffer | null {
  if (body.subarray(0, 5).toString('ascii') === '%PDF-') return body;
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  const found: Buffer[] = [];
  let visited = 0;
  const inspect = (value: unknown, depth: number): void => {
    if (depth > 12 || visited >= 10_000) return;
    visited += 1;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (Buffer.byteLength(trimmed) > 25_000_000) return;
      if (trimmed.startsWith('%PDF-')) {
        found.push(Buffer.from(trimmed, 'binary'));
        return;
      }
      const dataUri = /^data:application\/pdf(?:;charset=[^;,]+)?;base64,([\s\S]*)$/i.exec(trimmed);
      const compact = (dataUri?.[1] ?? trimmed).replace(/\s+/g, '');
      const unpadded = compact.replace(/=+$/, '');
      const paddingLength = compact.length - unpadded.length;
      if (unpadded.length < 64 || /=/.test(unpadded) || paddingLength > 2 ||
          !/^[A-Za-z0-9+/_-]+$/.test(unpadded) || unpadded.length % 4 === 1) return;
      const normalized = unpadded
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(unpadded.length + ((4 - unpadded.length % 4) % 4), '=');
      const decoded = Buffer.from(normalized, 'base64');
      if (decoded.subarray(0, 5).toString('ascii') === '%PDF-') found.push(decoded);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) inspect(item, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) inspect(item, depth + 1);
    }
  };
  inspect(payload, 0);
  const unique = found.filter((candidate, index) =>
    found.findIndex(other => other.equals(candidate)) === index
  );
  return unique.length === 1 ? unique[0]! : null;
}

export function wellsFargoCapturedStatementResponse(
  response: Pick<BrowserNativeResponse, 'status' | 'url' | 'headers' | 'redirected'>,
  body: Buffer,
  statementPageUrl: string,
): BrowserNativeResponse | null {
  if (response.status < 200 || response.status >= 300 || body.length > MAX_STATEMENT_BYTES) {
    return null;
  }
  let destination: URL;
  try {
    destination = asWellsFargoUrl(response.url);
    if (destination.origin !== asWellsFargoUrl(statementPageUrl).origin) return null;
  } catch {
    return null;
  }
  if (!wellsFargoPdfBodyFromBytes(body)) return null;
  const headers = Object.fromEntries(Object.entries(response.headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .filter(([name]) => name === 'content-type' || name === 'content-disposition'));
  return {
    status: response.status,
    url: destination.toString(),
    headers,
    bodyBase64: body.toString('base64'),
    redirected: response.redirected,
  };
}

export function wellsFargoStatementBodyFromApiResponse(
  response: BrowserNativeResponse,
): Buffer {
  if (!browserNativeResponseOk(response)) {
    throw new Error(`Wells Fargo statement API returned status ${response.status}`);
  }
  const body = browserNativeResponseBody(response);
  const pdf = wellsFargoPdfBodyFromBytes(body);
  if (!pdf) throw new Error('Wells Fargo statement API response did not contain one PDF document');
  return pdf;
}

function assertArtifactResponse(
  response: BrowserNativeResponse,
  body: Buffer,
  kind: WellsFargoArtifactKind,
): void {
  if (!browserNativeResponseOk(response)) {
    throw new Error(`Wells Fargo ${kind} API returned status ${response.status}`);
  }
  if (kind === 'statement') {
    if (body.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('Wells Fargo statement API response did not have PDF magic');
    }
    return;
  }
  const sample = body.subarray(0, Math.min(body.length, 4096));
  if (sample.includes(0) || !sample.includes(44) || !/[\r\n]/.test(sample.toString('utf8'))) {
    throw new Error('Wells Fargo activity API response did not have CSV text magic');
  }
}

export async function wellsFargoArtifactResponse(
  page: Page,
  kind: WellsFargoArtifactKind,
  request: WellsFargoApiRequest,
  capturedResponse?: BrowserNativeResponse,
): Promise<BrowserNativeResponse> {
  if (!capturedResponse) return executeWellsFargoApiRequest(page, request);
  if (kind !== 'statement') {
    throw new Error('Wells Fargo captured response did not belong to a statement');
  }
  const requestDestination = asWellsFargoUrl(request.url);
  const responseDestination = asWellsFargoUrl(capturedResponse.url);
  if (requestDestination.origin !== responseDestination.origin) {
    throw new Error('Wells Fargo captured statement response changed origin');
  }
  return capturedResponse;
}

async function downloadWellsFargoArtifact(
  page: Page,
  outputDir: string,
  plan: ArtifactPlan,
  request: WellsFargoApiRequest,
  capturedResponse?: BrowserNativeResponse,
): Promise<ArtifactDownload> {
  if (basename(plan.fileName) !== plan.fileName || wellsFargoArtifactPlanFromFilename(plan.fileName) === null) {
    throw new Error('Wells Fargo artifact filename is invalid');
  }
  const response = await wellsFargoArtifactResponse(
    page,
    plan.kind,
    request,
    capturedResponse,
  );
  const body = plan.kind === 'activity'
    ? wellsFargoActivityBodyFromApiResponse(response)
    : wellsFargoStatementBodyFromApiResponse(response);
  assertArtifactResponse(response, body, plan.kind);
  const path = resolve(outputDir, plan.fileName);
  await writeFile(path, body, { mode: 0o600 });
  return { ...plan, path, byteLength: body.length };
}

async function validateDownloadedWellsFargoArtifact(download: ArtifactDownload): Promise<WellsFargoDownloadedArtifact> {
  try {
    const validated = await validateWellsFargoArtifact(download.path);
    if (validated.kind !== download.kind || validated.account.kind !== download.account.kind ||
        validated.account.last4 !== download.account.last4) {
      throw new Error('Wells Fargo artifact validation changed its routing identity');
    }
    return { ...validated, accountId: download.accountId };
  } catch (error) {
    await unlink(download.path).catch(() => {});
    throw error;
  }
}

export function safeWellsFargoDiagnostic(error: unknown): string {
  const sourceLines = error instanceof Error
    ? [...(error.stack?.matchAll(/wellsFargo\.ts:(\d+):\d+/g) ?? [])]
    : [];
  const sourceLine = sourceLines[1]?.[1] ?? sourceLines[0]?.[1];
  const message = String(error instanceof Error ? error.message : error);
  return `${message}${sourceLine ? ` (source-line=${sourceLine})` : ''}`
    .split('\n')[0]!
    .replace(/https?:\/\/\S+/gi, '<redacted-url>')
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '<redacted-email>')
    .replace(/\$[\d,]+(?:\.\d{2})?/g, '<redacted-amount>')
    .replace(/\b\d(?:[ -]?\d){3,}\b/g, '<redacted-digits>')
    .replace(/\b(?:bearer|cookie|csrf|session|token)\s*[:=]\s*\S+/gi, '<redacted-secret>')
    .slice(0, 500);
}

export function wellsFargoBrowserWindowProgress(message: string): WellsFargoProgressEvent {
  return {
    step: 'browser-window',
    status: message.startsWith('Authentication browser delivered:') ? 'completed' : 'waiting',
    timestamp: new Date().toISOString(),
    message: safeWellsFargoDiagnostic(message),
  };
}

export function buildWellsFargoBrowserProgram(config: Pick<WellsFargoSyncConfig, 'accounts'>): string {
  return `async (page, _reportProgress, bindings) => {
    const config = ${JSON.stringify({ accounts: config.accounts })};
    const artifacts = [];
    const unavailable = [];
    const report = event => bindings.report(event);
    try {
      report({ step: 'sync', status: 'started', message: 'Starting Wells Fargo sync' });
      report({ step: 'authentication', status: 'started', message: 'Checking Wells Fargo authentication' });
      if (!await bindings.isAuthenticated(page)) {
        report({ step: 'authentication', status: 'waiting', message: 'Wells Fargo authentication is required' });
        return JSON.stringify({
          status: 'login-required',
          action: 'Sign in to Wells Fargo and complete MFA. EasyMoney will continue automatically.',
        });
      }
      report({ step: 'authentication', status: 'completed', message: 'Wells Fargo authentication is ready' });

      report({ step: 'account-discovery', status: 'started', message: 'Discovering Wells Fargo accounts' });
      const discoveredAccounts = await bindings.discoverAccounts(page);
      const accounts = await bindings.mapAccounts(discoveredAccounts, config.accounts);
      report({
        step: 'account-discovery', status: 'completed', message: 'Wells Fargo account discovery complete',
        accountCount: accounts.length, discoveredAccountCount: discoveredAccounts.length,
      });

      for (let accountIndex = 0; accountIndex < accounts.length; accountIndex += 1) {
        const account = accounts[accountIndex].remote;
        const planned = accounts[accountIndex].planned;
        const accountDetails = {
          accountIndex: accountIndex + 1,
          accountCount: accounts.length,
          accountKind: account.kind,
        };
        report({
          step: 'capability-discovery', status: 'started',
          message: 'Discovering Wells Fargo account artifact types', ...accountDetails,
        });
        await bindings.openAccount(page, account);
        const capabilities = await bindings.accountCapabilities(page);
        report({
          step: 'capability-discovery', status: 'completed',
          message: 'Wells Fargo account artifact discovery complete', ...accountDetails,
        });

        if (capabilities.activity) {
          report({
            step: 'activity-metadata', status: 'started', message: 'Reading Wells Fargo activity request metadata',
            artifactKind: 'activity', ...accountDetails,
          });
          const request = await bindings.prepareActivityRequest(
            page,
            planned.activityFrom,
            planned.activityThrough,
          );
          report({
            step: 'activity-metadata', status: 'completed', message: 'Wells Fargo activity request metadata is ready',
            artifactKind: 'activity', ...accountDetails,
          });
          const fileName = 'wells-fargo-' + account.kind + '-' + account.last4 + '-' +
            planned.activityFrom + '-to-' + planned.activityThrough + '.csv';
          const plan = {
            accountId: planned.accountId,
            fileName,
            kind: 'activity',
            account: { kind: account.kind, last4: account.last4 },
            coveredFrom: planned.activityFrom,
            coveredThrough: planned.activityThrough,
          };
          report({
            step: 'activity-download', status: 'started', message: 'Downloading Wells Fargo activity through the authenticated API',
            artifactKind: 'activity', ...accountDetails,
          });
          const downloaded = await bindings.downloadArtifact(page, plan, request);
          report({
            step: 'activity-download', status: 'completed', message: 'Wells Fargo activity API download complete',
            artifactKind: 'activity', ...accountDetails,
          });
          report({
            step: 'activity-validation', status: 'started', message: 'Validating Wells Fargo activity with EasyMoney',
            artifactKind: 'activity', ...accountDetails,
          });
          const validated = await bindings.validateArtifact(downloaded);
          artifacts.push(validated);
          report({
            step: 'activity-validation', status: 'completed', message: 'Wells Fargo activity validation complete',
            artifactKind: 'activity',
            byteLength: validated.byteLength,
            transactionCount: validated.transactionCount,
            balanceCount: validated.balanceCount,
            parserValidated: true,
            ...accountDetails,
          });
        } else {
          unavailable.push({
            accountId: planned.accountId,
            kind: 'activity',
            account: { kind: account.kind, last4: account.last4 },
          });
          report({
            step: 'activity-metadata', status: 'skipped', message: 'Wells Fargo did not offer activity for this account',
            artifactKind: 'activity', ...accountDetails,
          });
        }

        if (capabilities.statements) {
          await bindings.openAccount(page, account);
          report({
            step: 'statement-metadata', status: 'started', message: 'Discovering Wells Fargo statement metadata',
            artifactKind: 'statement', ...accountDetails,
          });
          const statements = await bindings.discoverStatements(
            page,
            account,
            planned.statementFrom,
            planned.statementThrough,
          );
          report({
            step: 'statement-metadata', status: 'completed', message: 'Wells Fargo statement metadata discovery complete',
            artifactKind: 'statement', artifactCount: statements.length, ...accountDetails,
          });
          for (let artifactIndex = 0; artifactIndex < statements.length; artifactIndex += 1) {
            const statement = statements[artifactIndex];
            const artifactDetails = {
              artifactKind: 'statement',
              artifactIndex: artifactIndex + 1,
              artifactCount: statements.length,
              ...accountDetails,
            };
            const fileName = 'wells-fargo-' + account.kind + '-' + account.last4 + '-' + statement.date + '.pdf';
            const plan = {
              accountId: planned.accountId,
              fileName,
              kind: 'statement',
              account: { kind: account.kind, last4: account.last4 },
              coveredFrom: statement.date,
              coveredThrough: statement.date,
            };
            report({
              step: 'statement-download', status: 'started', message: 'Downloading a Wells Fargo statement through the authenticated API',
              ...artifactDetails,
            });
            const downloaded = await bindings.downloadArtifact(
              page,
              plan,
              statement.request,
              statement.capturedResponse,
            );
            report({
              step: 'statement-download', status: 'completed', message: 'Wells Fargo statement API download complete',
              ...artifactDetails,
            });
            report({
              step: 'statement-validation', status: 'started', message: 'Validating a Wells Fargo statement with EasyMoney',
              ...artifactDetails,
            });
            const validated = await bindings.validateArtifact(downloaded);
            artifacts.push(validated);
            report({
              step: 'statement-validation', status: 'completed', message: 'Wells Fargo statement validation complete',
              byteLength: validated.byteLength,
              transactionCount: validated.transactionCount,
              balanceCount: validated.balanceCount,
              parserValidated: true,
              ...artifactDetails,
            });
          }
        } else {
          unavailable.push({
            accountId: planned.accountId,
            kind: 'statement',
            account: { kind: account.kind, last4: account.last4 },
          });
          report({
            step: 'statement-metadata', status: 'skipped', message: 'Wells Fargo did not offer statements for this account',
            artifactKind: 'statement', ...accountDetails,
          });
        }
      }
      report({
        step: 'sync', status: 'completed', message: 'Wells Fargo downloads are ready for review',
        accountCount: accounts.length,
        artifactCount: artifacts.length,
        unavailableArtifactCount: unavailable.length,
      });
      return JSON.stringify({
        status: 'complete',
        accounts: accounts.map(({ remote }) => ({ kind: remote.kind, last4: remote.last4 })),
        artifacts,
        unavailable,
      });
    } catch (error) {
      const diagnostic = bindings.safeError(error);
      report({ step: 'sync', status: 'failed', message: 'Wells Fargo sync failed', diagnostic });
      return JSON.stringify({ status: 'error', message: diagnostic });
    }
  }`;
}

export async function runWellsFargoSyncInAuthenticatedPage(
  page: Page,
  config: Pick<WellsFargoSyncConfig, 'outputDir' | 'accounts'>,
  onProgress: WellsFargoProgressReporter = () => {},
): Promise<WellsFargoSyncResult> {
  if (config.accounts.length === 0) throw new Error('Wells Fargo sync requires at least one planned account');
  validateWellsFargoSyncAccounts(config.accounts);
  const outputDir = resolve(config.outputDir);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await ensureWellsFargoAccountSummary(page);
  const program = Function(
    `"use strict"; return (${buildWellsFargoBrowserProgram(config)});`,
  )() as (
    browserPage: Page,
    reportProgress: (message: string) => void,
    bindings: Record<string, unknown>,
  ) => Promise<unknown>;
  const result = decodeInstitutionBrowserProgramResult<BrowserResult>(await program(
    page,
    () => {},
    wellsFargoBrowserBindings(outputDir, onProgress),
  ));
  if (result.status === 'login-required') {
    throw new Error('Wells Fargo authentication is required');
  }
  if (result.status !== 'complete') {
    throw new Error(result.message ?? 'Wells Fargo sync did not complete');
  }
  return {
    accounts: result.accounts,
    artifacts: result.artifacts,
    unavailable: result.unavailable,
  };
}

export async function runWellsFargoSync(
  config: WellsFargoSyncConfig,
  onProgress: WellsFargoProgressReporter = () => {},
): Promise<WellsFargoSyncResult> {
  if (config.accounts.length === 0) throw new Error('Wells Fargo sync requires at least one planned account');
  validateWellsFargoSyncAccounts(config.accounts);
  const outputDir = resolve(config.outputDir);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const result = await runInstitutionBrowserProgram<BrowserResult>(
    {
      name: config.session ?? DEFAULT_SESSION,
      startUrl: LOGIN_URL,
      profilePath: config.profilePath,
      ...(config.headless === undefined ? {} : {
        contextOptions: { headless: config.headless },
      }),
    },
    buildWellsFargoBrowserProgram(config),
    {
      completionDescription: 'Wells Fargo downloads are ready for review.',
      isAuthenticated: isWellsFargoAuthenticatedPage,
      waitUntilAuthenticated: waitUntilWellsFargoAuthenticated,
      onProgress: message => onProgress(wellsFargoBrowserWindowProgress(message)),
      programBindings: wellsFargoBrowserBindings(outputDir, onProgress),
    },
  );
  if (result.status === 'login-required') {
    throw new Error('Wells Fargo authentication is required');
  }
  if (result.status !== 'complete') {
    throw new Error(result.message ?? 'Wells Fargo sync did not complete');
  }
  return {
    accounts: result.accounts,
    artifacts: result.artifacts,
    unavailable: result.unavailable,
  };
}
