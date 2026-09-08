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
  type BrowserNativeResponse,
} from '../browserRequest.ts';
import type { Page } from 'playwright';

const LOGIN_URL = 'https://connect.secure.wellsfargo.com/auth/login/present';
const DEFAULT_SESSION = 'wells-fargo-catchup';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVITY_FILENAME = /^wells-fargo-(checking|savings|credit-card)-(\d{4})-(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})\.csv$/i;
const STATEMENT_FILENAME = /^wells-fargo-(checking|savings|credit-card)-(\d{4})-(\d{4}-\d{2}-\d{2})\.pdf$/i;
const STATEMENT_PATH_PREFIX = '/edocs/documents/retrieve/';

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
  destination: string;
}

export interface WellsFargoFormSnapshot {
  action: string;
  method: string;
  fields: Array<[string, string]>;
}

export interface WellsFargoApiRequest {
  url: string;
  method: 'GET' | 'POST';
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
    ) => downloadWellsFargoArtifact(page, outputDir, plan, request),
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

export function selectWellsFargoStatements(
  candidates: WellsFargoStatementCandidate[],
  from: string,
  through: string,
): WellsFargoStatementCandidate[] {
  assertDateRange(from, through);
  const byDate = new Map<string, WellsFargoStatementCandidate>();
  for (const candidate of candidates) {
    assertDate(candidate.date, 'Wells Fargo statement date');
    const destination = asWellsFargoUrl(candidate.destination);
    if (!destination.pathname.startsWith(STATEMENT_PATH_PREFIX)) {
      throw new Error('Wells Fargo statement metadata did not expose the verified document API');
    }
    const normalized = { ...candidate, destination: destination.toString() };
    const existing = byDate.get(candidate.date);
    if (existing && existing.destination !== normalized.destination) {
      throw new Error('Wells Fargo exposed multiple statement documents for one account and date');
    }
    byDate.set(candidate.date, existing ?? normalized);
  }
  const all = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
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

export async function isWellsFargoAuthenticatedPage(page: Page): Promise<boolean> {
  const hostname = new URL(page.url()).hostname;
  if (!/(?:^|\.)wellsfargo\.com$/i.test(hostname)) return false;
  if (await page.locator('input[type="password"]:visible, input[autocomplete="username"]:visible').count()) {
    return false;
  }
  return await page.getByRole('heading', { name: /^Account Summary$/i }).count() > 0 ||
    await page.getByRole('link', { name: /^Account Summary$/i }).count() > 0 ||
    await page.getByRole('link', { name: /^(?:Sign Off|Sign Out)$/i }).count() > 0;
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
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
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
    await clickWellsFargoAccountControl(page, control);
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
  if (!await isWellsFargoAuthenticatedPage(page)) {
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
): Promise<void> {
  await control.click();
  await Promise.race([
    page.getByRole('button', { name: /^Download Account Activity$/i }).first()
      .waitFor({ state: 'visible', timeout: 30_000 }),
    page.getByRole('link', { name: /^View Statements$/i }).first()
      .waitFor({ state: 'visible', timeout: 30_000 }),
  ]).catch(() => {
    throw new Error('A Wells Fargo account control did not reveal account details');
  });
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
  const snapshot = await download.evaluate((element): WellsFargoFormSnapshot | null => {
    const form = element.closest('form');
    if (!(form instanceof HTMLFormElement)) return null;
    const data = new FormData(form);
    if ((element instanceof HTMLButtonElement || element instanceof HTMLInputElement) && element.name) {
      data.append(element.name, element.value);
    }
    return {
      action: form.action || location.href,
      method: form.method || 'GET',
      fields: [...data.entries()].filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    };
  });
  if (!snapshot) {
    throw new Error('Wells Fargo activity page did not expose a direct HTTP form contract');
  }
  return wellsFargoActivityRequestFromForm(snapshot, page.url());
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

async function discoverWellsFargoStatements(
  page: Page,
  from: string,
  through: string,
): Promise<WellsFargoStatementCandidate[]> {
  const control = page.getByRole('link', { name: /^View Statements$/i }).first();
  await control.click();
  const links = page.locator(`a[href*="${STATEMENT_PATH_PREFIX}"]`);
  await links.first().waitFor({ state: 'attached', timeout: 30_000 }).catch(() => {
    throw new Error('Wells Fargo statement metadata did not expose direct document links');
  });
  const candidates = await links.evaluateAll(elements => elements.map(element => {
    const destination = element instanceof HTMLAnchorElement ? element.href : '';
    const value = `${element.textContent ?? ''} ${destination}`;
    return { value, destination };
  }));
  return selectWellsFargoStatements(candidates.map(candidate => {
    const date = wellsFargoDateFromText(candidate.value);
    if (!date) throw new Error('Wells Fargo statement metadata omitted its date');
    return { date, destination: candidate.destination };
  }), from, through);
}

async function executeWellsFargoApiRequest(
  page: Page,
  request: WellsFargoApiRequest,
): Promise<BrowserNativeResponse> {
  asWellsFargoUrl(request.url);
  const response = await runBrowserNativeRequest(page, {
    url: request.url,
    method: request.method,
    ...(request.method === 'POST' ? {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      bodyBase64: Buffer.from(request.body ?? '', 'utf8').toString('base64'),
    } : {}),
  });
  asWellsFargoUrl(response.url);
  return response;
}

function assertArtifactResponse(
  response: BrowserNativeResponse,
  body: Buffer,
  kind: WellsFargoArtifactKind,
): void {
  if (!browserNativeResponseOk(response)) {
    throw new Error(`Wells Fargo ${kind} API returned status ${response.status}`);
  }
  const contentType = response.headers['content-type']?.toLowerCase() ?? '';
  if (kind === 'statement') {
    if (!contentType.includes('pdf') && !contentType.includes('octet-stream')) {
      throw new Error('Wells Fargo statement API did not return a PDF content type');
    }
    if (body.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('Wells Fargo statement API response did not have PDF magic');
    }
    return;
  }
  if (!contentType.includes('csv') && !contentType.includes('text/plain') &&
      !contentType.includes('octet-stream') && !contentType.includes('excel')) {
    throw new Error('Wells Fargo activity API did not return a CSV-compatible content type');
  }
  const sample = body.subarray(0, Math.min(body.length, 4096));
  if (sample.includes(0) || !sample.includes(44) || !/[\r\n]/.test(sample.toString('utf8'))) {
    throw new Error('Wells Fargo activity API response did not have CSV text magic');
  }
}

async function downloadWellsFargoArtifact(
  page: Page,
  outputDir: string,
  plan: ArtifactPlan,
  request: WellsFargoApiRequest,
): Promise<ArtifactDownload> {
  if (basename(plan.fileName) !== plan.fileName || wellsFargoArtifactPlanFromFilename(plan.fileName) === null) {
    throw new Error('Wells Fargo artifact filename is invalid');
  }
  const response = await executeWellsFargoApiRequest(page, request);
  const body = browserNativeResponseBody(response);
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
  return String(error instanceof Error ? error.message : error)
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
            const downloaded = await bindings.downloadArtifact(page, plan, {
              url: statement.destination,
              method: 'GET',
            });
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
