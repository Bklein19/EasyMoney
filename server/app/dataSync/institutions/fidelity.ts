import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

import type { APIResponse, Download, Locator, Page, Request } from 'playwright';
import { extractText, getDocumentProxy } from 'unpdf';

import { fidelity401kParser } from '../../importParsers/fidelity401k.ts';
import { fidelityActivityParser } from '../../importParsers/fidelityActivity.ts';
import { fidelityInvestmentReportParser } from '../../importParsers/fidelityInvestmentReport.ts';
import { fidelityNetBenefitsStatementParser } from '../../importParsers/fidelityNetBenefitsStatement.ts';
import { fidelityPortfolioStatementParser } from '../../importParsers/fidelityPortfolioStatement.ts';
import type { AppImportParseResult, AppImportParser } from '../../importTypes.ts';
import { runInstitutionBrowserProgram } from '../browserSession.ts';

const FIDELITY_ACTIVITY_URL = 'https://digital.fidelity.com/ftgw/digital/portfolio/activity';
const FIDELITY_NETBENEFITS_URL = 'https://nb.fidelity.com/public/nb/default/home';
const FIDELITY_START_URL = 'data:text/html,<title>EasyMoney Fidelity connector</title>';
const DEFAULT_SESSION = 'fidelity-catchup';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DOM_AUTHENTICATION_FIELDS = [
  'input[type="password"]',
  'input[autocomplete="username"]',
  'input[autocomplete="current-password"]',
].join(',');
const VISIBLE_AUTHENTICATION_FIELDS = DOM_AUTHENTICATION_FIELDS
  .split(',')
  .map(selector => `${selector}:visible`)
  .join(',');

export type FidelitySurface = 'retail' | 'netbenefits';
export type FidelityAccountKind =
  | 'brokerage'
  | 'cash-management'
  | 'hsa'
  | 'ira'
  | 'retirement'
  | 'stock-plan'
  | 'other';
export type FidelityArtifactType = 'activity-csv' | 'statement-pdf' | 'statement-html';
export type FidelitySyncPhase =
  | 'authentication'
  | 'retail-discovery'
  | 'netbenefits-discovery'
  | 'artifact-discovery'
  | 'download'
  | 'validation';

export interface FidelitySyncConfig {
  outputDir: string;
  from: string;
  through: string;
  session?: string;
}

export interface FidelityAccountCandidate {
  surface: FidelitySurface;
  label: string;
  href?: string | null;
  value?: string | null;
  remoteId?: string | null;
  controlIndex?: number;
}

export interface FidelityAccountIdentity {
  surface: FidelitySurface;
  kind: FidelityAccountKind;
  accountKey: string;
  last4: string | null;
  label?: string;
}

export interface FidelityRemoteAccount extends FidelityAccountIdentity {
  selection: {
    controlIndex: number;
    href: string | null;
    label: string;
  };
}

export interface FidelityDocumentCandidate {
  surface: FidelitySurface;
  label: string;
  href: string;
  accountKey?: string | null;
}

export interface FidelityArtifactPlan {
  artifactType: FidelityArtifactType;
  fileName: string;
  account: FidelityAccountIdentity;
  coveredFrom: string | null;
  coveredThrough: string;
  requestUrl?: string;
  controlIndex?: number;
}

export interface FidelityDownloadedArtifact extends FidelityArtifactPlan {
  path: string;
  parserId: string;
  transactionCount: number;
  balanceCount: number;
  parsedAccountLast4s: string[];
}

export interface FidelityProgressEvent {
  phase: FidelitySyncPhase;
  step: string;
  status: 'started' | 'completed' | 'failed';
  message: string;
  timestamp: string;
  durationMs?: number;
  details?: Record<string, string | number | boolean | null>;
}

export type FidelityProgressReporter = (event: FidelityProgressEvent) => void;

export type FidelitySyncResult =
  | {
    status: 'complete';
    accountsDiscovered: number;
    artifacts: FidelityDownloadedArtifact[];
    skipped: string[];
  }
  | {
    status: 'authentication-required';
    accountsDiscovered: 0;
    artifacts: [];
    skipped: [];
  }
  | {
    status: 'institution-unavailable';
    accountsDiscovered: 0;
    artifacts: [];
    skipped: [];
  };

type FidelityValidationResult = Pick<
  FidelityDownloadedArtifact,
  'parserId' | 'transactionCount' | 'balanceCount' | 'parsedAccountLast4s'
>;

type FidelityReplayRequest = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  postData?: Buffer;
};

type FidelityBrowserResult = {
  status: 'complete';
  accountsDiscovered: number;
  artifacts: FidelityDownloadedArtifact[];
  skipped: string[];
};

export type FidelitySurfaceDiscovery =
  | {
    surface: FidelitySurface;
    status: 'accounts';
    accounts: FidelityRemoteAccount[];
  }
  | {
    surface: FidelitySurface;
    status: 'no-accounts' | 'authentication-required' | 'institution-unavailable';
    accounts: [];
  };

export interface FidelityResolvedSurfaces {
  retailAccounts: FidelityRemoteAccount[];
  netBenefitsAccounts: FidelityRemoteAccount[];
  skipped: string[];
}

class FidelityAuthenticationRequiredError extends Error {}
class FidelityInstitutionUnavailableError extends Error {}

function normalizedAccountLabel(value: string): string {
  return value
    .replace(/\$-?[\d,]+(?:\.\d{2})?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function accountLast4(value: string): string | null {
  const explicit = value.match(/(?:ending in|(?:x|\*|\u2022){2,}|-)\s*(\d{4})\b/i)?.[1];
  if (explicit) return explicit;
  const accountLike = value.match(/\b[A-Z]?[\d-]{6,}\b/gi)?.at(-1)?.replace(/\D/g, '');
  if (accountLike && accountLike.length >= 4) return accountLike.slice(-4);
  return value.match(/\b(?!19\d{2}\b|20\d{2}\b)(\d{4})\b/g)?.at(-1) ?? null;
}

function accountKind(value: string): FidelityAccountKind {
  if (/401\s*\(k\)|403\s*\(b\)|retirement|workplace|pension|savings plan/i.test(value)) return 'retirement';
  if (/stock plan|stock-plan|equity compensation|rsu|espp/i.test(value)) return 'stock-plan';
  if (/cash management/i.test(value)) return 'cash-management';
  if (/health savings|\bhsa\b/i.test(value)) return 'hsa';
  if (/\bira\b|roth|traditional/i.test(value)) return 'ira';
  if (/brokerage|individual|joint|trust|custodial/i.test(value)) return 'brokerage';
  return 'other';
}

function remoteIdentity(candidate: FidelityAccountCandidate, label: string): string {
  if (candidate.remoteId?.trim()) return candidate.remoteId.trim();
  if (candidate.value?.trim()) return candidate.value.trim();
  if (candidate.href) {
    try {
      const url = new URL(candidate.href, 'https://www.fidelity.com/');
      for (const name of ['account', 'accountId', 'accountNumber', 'acct', 'plan', 'planId']) {
        const value = url.searchParams.get(name);
        if (value) return `${name}:${value}`;
      }
      return `${url.hostname}${url.pathname}:${label}`;
    } catch {}
  }
  return label;
}

function opaqueAccountKey(surface: FidelitySurface, identity: string): string {
  return createHash('sha256').update(`${surface}\0${identity}`).digest('hex').slice(0, 12);
}

export function fidelityAccountsFromCandidates(candidates: FidelityAccountCandidate[]): FidelityRemoteAccount[] {
  const accounts = new Map<string, FidelityRemoteAccount>();
  for (const [candidateIndex, candidate] of candidates.entries()) {
    const label = normalizedAccountLabel(candidate.label);
    if (!label || /^(?:all accounts?|select an? account)$/i.test(label)) continue;
    const identity = remoteIdentity(candidate, label);
    const accountKey = opaqueAccountKey(candidate.surface, identity);
    if (accounts.has(accountKey)) continue;
    accounts.set(accountKey, {
      surface: candidate.surface,
      kind: accountKind(`${label} ${candidate.href ?? ''}`),
      accountKey,
      last4: accountLast4(`${label} ${candidate.value ?? ''}`),
      label,
      selection: {
        controlIndex: candidate.controlIndex ?? candidateIndex,
        href: candidate.href ?? null,
        label,
      },
    });
  }

  const routableIdentities = new Set<string>();
  for (const account of accounts.values()) {
    if (!account.last4) continue;
    const identity = `${account.surface}:${account.last4}`;
    if (routableIdentities.has(identity)) {
      throw new Error(`Multiple Fidelity ${account.surface} accounts share one routing suffix`);
    }
    routableIdentities.add(identity);
  }
  return [...accounts.values()];
}

function accountSlug(account: FidelityAccountIdentity): string {
  return `${account.surface}-${account.kind}-${account.last4 ?? account.accountKey}`;
}

export function fidelityArtifactFileName(
  account: FidelityAccountIdentity,
  artifactType: FidelityArtifactType,
  from: string,
  through: string,
): string {
  const slug = accountSlug(account);
  if (artifactType === 'activity-csv') return `fidelity-${slug}-${from}-to-${through}-activity.csv`;
  if (artifactType === 'statement-html') return `fidelity-401k-${account.last4 ?? account.accountKey}-${through.slice(0, 7)}.html`;
  return `fidelity-${slug}-${through}-statement.pdf`;
}

function isoDateFromDocumentLabel(value: string): string | null {
  const iso = value.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const numeric = value.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (numeric) return `${numeric[3]}-${numeric[1].padStart(2, '0')}-${numeric[2].padStart(2, '0')}`;
  const named = value.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/i,
  );
  if (!named) return null;
  const month = String([
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ].indexOf(named[1].toLowerCase()) + 1).padStart(2, '0');
  return `${named[3]}-${month}-${named[2].padStart(2, '0')}`;
}

export function fidelityDirectRequestUrl(value: string, baseUrl = 'https://www.fidelity.com/'): string {
  const url = new URL(value, baseUrl);
  if (url.protocol !== 'https:' || !/(?:^|\.)fidelity\.com$/i.test(url.hostname)) {
    throw new Error('Fidelity direct request destination is not trusted');
  }
  url.hash = '';
  return url.toString();
}

function accountForDocument(
  candidate: FidelityDocumentCandidate,
  accounts: FidelityRemoteAccount[],
): FidelityRemoteAccount {
  if (candidate.accountKey) {
    const exact = accounts.filter(account => account.accountKey === candidate.accountKey);
    if (exact.length === 1) return exact[0];
  }
  const suffixes = [...new Set(candidate.label.match(/\b\d{4}\b/g) ?? [])];
  const bySuffix = accounts.filter(account => account.last4 && suffixes.includes(account.last4));
  if (bySuffix.length === 1) return bySuffix[0];
  const sameSurface = accounts.filter(account => account.surface === candidate.surface);
  if (sameSurface.length === 1) return sameSurface[0];
  throw new Error('Fidelity document account identity is ambiguous');
}

export function fidelityStatementPlans(
  candidates: FidelityDocumentCandidate[],
  accounts: FidelityRemoteAccount[],
  from: string,
  through: string,
): FidelityArtifactPlan[] {
  const plans = new Map<string, FidelityArtifactPlan>();
  for (const candidate of candidates) {
    if (!/statement|investment report|retirement savings/i.test(candidate.label)) continue;
    const statementDate = isoDateFromDocumentLabel(candidate.label);
    if (!statementDate || statementDate < from || statementDate > through) continue;
    const requestUrl = fidelityDirectRequestUrl(candidate.href);
    if (plans.has(requestUrl)) continue;
    const account = accountForDocument(candidate, accounts);
    const artifactType: FidelityArtifactType = /\.html?(?:$|\?)/i.test(requestUrl)
      ? 'statement-html'
      : 'statement-pdf';
    plans.set(requestUrl, {
      artifactType,
      fileName: fidelityArtifactFileName(account, artifactType, statementDate, statementDate),
      account,
      coveredFrom: null,
      coveredThrough: statementDate,
      requestUrl,
    });
  }
  return [...plans.values()].sort((left, right) => left.fileName.localeCompare(right.fileName));
}

export function isFidelityInstitutionUnavailableText(value: string): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return /sorry,? we can['\u2019]?t complete this action right now\.? please try again\.?/i.test(normalized)
    || /(?:fidelity|this (?:site|service|action)).{0,80}(?:temporarily|currently) unavailable/i.test(normalized)
    || /scheduled maintenance/i.test(normalized);
}

async function pageShowsInstitutionUnavailable(page: Page): Promise<boolean> {
  return await page.getByText(
    /sorry,? we can['\u2019]?t complete this action right now|temporarily unavailable|scheduled maintenance/i,
  ).count() > 0;
}

function parserAccounts(parsed: AppImportParseResult): string[] {
  return [...new Set([
    ...parsed.transactions.flatMap(transaction => transaction?.account ? [transaction.account] : []),
    ...parsed.balances.flatMap(balance => balance.account ? [balance.account] : []),
  ])];
}

function parserAccountLast4s(parsed: AppImportParseResult): string[] {
  return [...new Set(parserAccounts(parsed).flatMap(account => {
    const digits = account.replace(/\D/g, '');
    return digits.length >= 4 ? [digits.slice(-4)] : [];
  }))];
}

async function pdfSample(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf);
  return text.join('\n').slice(0, 8_192);
}

function parserForArtifact(
  artifactType: FidelityArtifactType,
  fileName: string,
  sample: string,
): AppImportParser {
  if (artifactType === 'activity-csv') {
    if (!fidelityActivityParser.matches({ fileName, headers: [], sample })) {
      throw new Error('Fidelity activity artifact did not match the EasyMoney parser');
    }
    return fidelityActivityParser;
  }
  if (artifactType === 'statement-html') {
    if (!fidelity401kParser.matches({ fileName, headers: [], sample })) {
      throw new Error('Fidelity HTML statement did not match the EasyMoney parser');
    }
    return fidelity401kParser;
  }
  const parsers = [
    fidelityInvestmentReportParser,
    fidelityNetBenefitsStatementParser,
    fidelityPortfolioStatementParser,
  ].filter(parser => parser.matches({ fileName, headers: [], sample }));
  if (parsers.length !== 1) {
    throw new Error(`Fidelity PDF matched ${parsers.length} EasyMoney parsers`);
  }
  return parsers[0];
}

export async function validateFidelityArtifact(
  path: string,
  plan: Pick<FidelityArtifactPlan, 'artifactType' | 'fileName' | 'account'>,
): Promise<FidelityValidationResult> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size < 16) throw new Error('Fidelity artifact is empty or too small');
  const expectedExtension = plan.artifactType === 'activity-csv'
    ? '.csv'
    : plan.artifactType === 'statement-pdf' ? '.pdf' : '.html';
  if (extname(plan.fileName).toLowerCase() !== expectedExtension) {
    throw new Error('Fidelity artifact has the wrong extension');
  }
  const bytes = new Uint8Array(await readFile(path));
  if (plan.artifactType === 'statement-pdf' && new TextDecoder('ascii').decode(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new Error('Fidelity PDF magic is missing');
  }
  if (plan.artifactType !== 'statement-pdf' && bytes.includes(0)) {
    throw new Error('Fidelity text artifact contains binary NUL bytes');
  }
  const text = plan.artifactType === 'statement-pdf'
    ? await pdfSample(bytes)
    : new TextDecoder().decode(bytes);
  const parser = parserForArtifact(plan.artifactType, plan.fileName, text);
  const parsed = await parser.parse({
    fileName: plan.fileName,
    headers: [],
    rows: [],
    text,
    filePath: path,
    fileBytes: bytes,
  });
  if (plan.artifactType !== 'activity-csv' && parsed.balances.length === 0) {
    throw new Error('Fidelity statement parser produced no balance');
  }
  const parsedAccountLast4s = parserAccountLast4s(parsed);
  if (plan.account.last4 && parsedAccountLast4s.length > 0 && (
    parsedAccountLast4s.length !== 1 || parsedAccountLast4s[0] !== plan.account.last4
  )) {
    throw new Error('Fidelity parser account does not match the discovered remote account');
  }
  return {
    parserId: parser.id,
    transactionCount: parsed.transactions.filter(Boolean).length,
    balanceCount: parsed.balances.length,
    parsedAccountLast4s,
  };
}

function safeConfig(config: FidelitySyncConfig): Required<FidelitySyncConfig> {
  if (!DATE_PATTERN.test(config.from) || !DATE_PATTERN.test(config.through) || config.from > config.through) {
    throw new Error('Fidelity sync dates must be an ordered YYYY-MM-DD range');
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.session ?? DEFAULT_SESSION)) {
    throw new Error('Fidelity session must be a PII-free kebab-case label');
  }
  return {
    ...config,
    outputDir: resolve(config.outputDir),
    session: config.session ?? DEFAULT_SESSION,
  };
}

async function reportStep<T>(
  report: FidelityProgressReporter,
  phase: FidelitySyncPhase,
  step: string,
  message: string,
  operation: () => Promise<T>,
  details?: FidelityProgressEvent['details'],
): Promise<T> {
  const startedAt = performance.now();
  report({ phase, step, status: 'started', message, timestamp: new Date().toISOString(), details });
  try {
    const result = await operation();
    report({
      phase,
      step,
      status: 'completed',
      message: `${message} complete`,
      timestamp: new Date().toISOString(),
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      details,
    });
    return result;
  } catch (error) {
    report({
      phase,
      step,
      status: 'failed',
      message: `${message} failed`,
      timestamp: new Date().toISOString(),
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      details,
    });
    throw error;
  }
}

function fidelityAuthenticationRoute(url: URL): boolean {
  return /(?:login|logon|sign[-_]?in|authenticate|authorization|oauth|sso|auth)/i.test(
    `${url.hostname}${url.pathname}`,
  );
}

function fidelityAuthenticatedRoute(url: URL): boolean {
  if (!/(?:^|\.)fidelity\.com$/i.test(url.hostname)) return false;
  return /\/ftgw\/digital\/portfolio(?:\/|$)/i.test(url.pathname)
    || /\/mybenefits(?:\/|$)/i.test(url.pathname)
    || /\/public\/nb\//i.test(url.pathname);
}

export async function isFidelityAuthenticatedPage(page: Page): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(page.url());
  } catch {
    return false;
  }
  if (!fidelityAuthenticatedRoute(url) || fidelityAuthenticationRoute(url)) return false;
  if (await pageShowsInstitutionUnavailable(page)) return false;
  return await page.locator(VISIBLE_AUTHENTICATION_FIELDS).count() === 0;
}

export async function waitUntilFidelityAuthenticated(page: Page, timeoutMs: number): Promise<void> {
  const handle = await page.waitForFunction((selector: string) => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    const hasAuthenticationField = Array.from(document.querySelectorAll(selector)).some(visible);
    const fidelityHost = /(?:^|\.)fidelity\.com$/i.test(location.hostname);
    const authenticatedPath = /\/ftgw\/digital\/portfolio(?:\/|$)|\/mybenefits(?:\/|$)|\/public\/nb\//i.test(location.pathname);
    const authenticationPath = /(?:login|logon|sign[-_]?in|authenticate|authorization|oauth|sso|auth)/i.test(
      location.hostname + location.pathname,
    );
    if (authenticationPath || hasAuthenticationField) return null;
    const bodyText = document.body?.innerText ?? '';
    if (/sorry,? we can['\u2019]?t complete this action right now|temporarily unavailable|scheduled maintenance/i.test(bodyText)) {
      return 'institution-unavailable';
    }
    return fidelityHost && authenticatedPath && !authenticationPath && !hasAuthenticationField
      ? 'authenticated'
      : null;
  }, DOM_AUTHENTICATION_FIELDS, { timeout: timeoutMs });
  const state = await handle.jsonValue();
  if (state === 'institution-unavailable') throw new FidelityInstitutionUnavailableError('institution-unavailable');
}

type PageGate = 'ready' | 'no-accounts' | 'authentication-required' | 'institution-unavailable';

async function navigateToFidelityPage(
  page: Page,
  url: string,
  readySelector: string,
  options: { missingControlsMeanNoAccounts?: boolean } = {},
): Promise<PageGate> {
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
  } catch {}
  let currentUrl: URL;
  try {
    currentUrl = new URL(page.url());
  } catch {
    return 'authentication-required';
  }
  if (fidelityAuthenticationRoute(currentUrl) || await page.locator(VISIBLE_AUTHENTICATION_FIELDS).count() > 0) {
    return 'authentication-required';
  }
  if (await pageShowsInstitutionUnavailable(page)) return 'institution-unavailable';
  try {
    await page.locator(readySelector).first().waitFor({ state: 'attached', timeout: 30_000 });
  } catch {
    try {
      currentUrl = new URL(page.url());
    } catch {
      return 'authentication-required';
    }
    if (fidelityAuthenticationRoute(currentUrl) || await page.locator(VISIBLE_AUTHENTICATION_FIELDS).count() > 0) {
      return 'authentication-required';
    }
    if (await pageShowsInstitutionUnavailable(page)) return 'institution-unavailable';
    if (!fidelityAuthenticatedRoute(currentUrl)) return 'authentication-required';
    if (options.missingControlsMeanNoAccounts) return 'no-accounts';
    throw new Error('Fidelity page controls did not become available');
  }
  return 'ready';
}

function assertGate(gate: PageGate): void {
  if (gate === 'authentication-required') throw new FidelityAuthenticationRequiredError('authentication-required');
  if (gate === 'institution-unavailable') throw new FidelityInstitutionUnavailableError('institution-unavailable');
  if (gate === 'no-accounts') throw new Error('Fidelity account surface has no accounts');
}

async function accountCandidatesFromLocator(
  locator: Locator,
  surface: FidelitySurface,
): Promise<FidelityAccountCandidate[]> {
  return locator.evaluateAll((elements, targetSurface) => elements.map((element, controlIndex) => {
    const htmlElement = element as HTMLElement;
    const anchor = element instanceof HTMLAnchorElement ? element : element.closest('a');
    return {
      surface: targetSurface,
      label: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
      href: anchor?.href ?? null,
      value: htmlElement.getAttribute('value') ?? htmlElement.dataset.value ?? null,
      remoteId: htmlElement.dataset.accountId
        ?? htmlElement.dataset.account
        ?? htmlElement.dataset.planId
        ?? null,
      controlIndex,
    };
  }), surface);
}

const retailAccountControlSelector = [
  '#account-selector:visible a',
  '#account-selector:visible button',
  '[role="listbox"]:visible [role="option"]',
].join(',');

async function openRetailAccountSelector(page: Page): Promise<Locator> {
  let controls = page.locator(retailAccountControlSelector);
  if (await controls.count() === 0) {
    const opener = page.locator('button[aria-label="account selector"]:visible').first();
    await opener.waitFor({ state: 'visible', timeout: 30_000 });
    await opener.click();
    controls = page.locator(retailAccountControlSelector);
    await controls.first().waitFor({ state: 'attached', timeout: 30_000 });
  }
  return controls;
}

export async function discoverFidelityRetailAccounts(page: Page): Promise<FidelityRemoteAccount[]> {
  const gate = await navigateToFidelityPage(page, FIDELITY_ACTIVITY_URL, [
    '#account-selector',
    'button[aria-label="account selector"]',
  ].join(','), { missingControlsMeanNoAccounts: true });
  if (gate === 'no-accounts') return [];
  assertGate(gate);
  const accounts = fidelityAccountsFromCandidates(
    await accountCandidatesFromLocator(await openRetailAccountSelector(page), 'retail'),
  );
  return accounts;
}

const netBenefitsAccountControlSelector = [
  '[data-plan-id]',
  'a[href*="/mybenefits/"]',
  'a[href*="netbenefits"]',
].join(',');

export async function discoverFidelityNetBenefitsAccounts(page: Page): Promise<FidelityRemoteAccount[]> {
  const gate = await navigateToFidelityPage(
    page,
    FIDELITY_NETBENEFITS_URL,
    netBenefitsAccountControlSelector,
    { missingControlsMeanNoAccounts: true },
  );
  if (gate === 'no-accounts') return [];
  assertGate(gate);
  const raw = await accountCandidatesFromLocator(page.locator(netBenefitsAccountControlSelector), 'netbenefits');
  const candidates = raw.filter(candidate => (
    /401\s*\(k\)|403\s*\(b\)|retirement|pension|savings plan|workplace/i.test(candidate.label)
    || Boolean(candidate.remoteId)
  ));
  return fidelityAccountsFromCandidates(candidates);
}

async function discoverFidelitySurface(
  surface: FidelitySurface,
  operation: () => Promise<FidelityRemoteAccount[]>,
): Promise<FidelitySurfaceDiscovery> {
  try {
    const accounts = await operation();
    return accounts.length > 0
      ? { surface, status: 'accounts', accounts }
      : { surface, status: 'no-accounts', accounts: [] };
  } catch (error) {
    if (error instanceof FidelityAuthenticationRequiredError) {
      return { surface, status: 'authentication-required', accounts: [] };
    }
    if (error instanceof FidelityInstitutionUnavailableError) {
      return { surface, status: 'institution-unavailable', accounts: [] };
    }
    throw error;
  }
}

export function resolveFidelitySurfaceDiscoveries(
  discoveries: readonly FidelitySurfaceDiscovery[],
): FidelityResolvedSurfaces {
  const bySurface = new Map(discoveries.map(discovery => [discovery.surface, discovery]));
  if (discoveries.length !== 2 || bySurface.size !== 2 || !bySurface.has('retail') || !bySurface.has('netbenefits')) {
    throw new Error('Fidelity surface discovery must report retail and NetBenefits exactly once');
  }
  const retail = bySurface.get('retail')!;
  const netBenefits = bySurface.get('netbenefits')!;
  const results = [retail, netBenefits];

  if (results.every(result => result.status === 'authentication-required')) {
    throw new FidelityAuthenticationRequiredError('authentication-required');
  }
  if (results.every(result => result.status === 'institution-unavailable')) {
    throw new FidelityInstitutionUnavailableError('institution-unavailable');
  }

  const retailAccounts = retail.status === 'accounts' ? retail.accounts : [];
  const netBenefitsAccounts = netBenefits.status === 'accounts' ? netBenefits.accounts : [];
  if (retailAccounts.length + netBenefitsAccounts.length === 0) {
    throw new Error('Fidelity did not expose accounts on an available surface');
  }

  const skipped = results.flatMap(result => {
    if (result.status === 'accounts') return [];
    const name = result.surface === 'retail' ? 'retail' : 'NetBenefits';
    if (result.status === 'no-accounts') return [`Fidelity ${name} has no accounts`];
    if (result.status === 'authentication-required') {
      return [`Fidelity ${name} is not available to this login`];
    }
    return [`Fidelity ${name} is temporarily unavailable`];
  });

  return { retailAccounts, netBenefitsAccounts, skipped };
}

function safeReplayHeaders(headers: Record<string, string>): Record<string, string> {
  const excluded = new Set([
    'cookie', 'content-length', 'host', 'connection', 'accept-encoding', 'sec-fetch-dest',
    'sec-fetch-mode', 'sec-fetch-site', 'user-agent',
  ]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())));
}

function replayRequestFromBrowserRequest(request: Request): FidelityReplayRequest {
  return {
    url: fidelityDirectRequestUrl(request.url()),
    method: request.method(),
    headers: safeReplayHeaders(request.headers()),
    postData: request.postDataBuffer() ?? undefined,
  };
}

async function replayRequestFromControl(control: Locator, pageUrl: string): Promise<FidelityReplayRequest | null> {
  const metadata = await control.evaluate((element, baseUrl) => {
    const htmlElement = element as HTMLElement;
    const anchor = element instanceof HTMLAnchorElement ? element : element.closest('a');
    const directUrl = anchor?.href
      ?? htmlElement.dataset.downloadUrl
      ?? htmlElement.dataset.url
      ?? htmlElement.getAttribute('formaction');
    if (directUrl && !directUrl.startsWith('javascript:') && !directUrl.startsWith('blob:')) {
      return { url: new URL(directUrl, baseUrl).toString(), method: 'GET', body: null, contentType: null };
    }
    const form = element.closest('form') as HTMLFormElement | null;
    if (!form) return null;
    const params = new URLSearchParams();
    for (const [name, value] of new FormData(form).entries()) {
      if (typeof value === 'string') params.append(name, value);
    }
    return {
      url: new URL(form.action || baseUrl, baseUrl).toString(),
      method: (form.method || 'GET').toUpperCase(),
      body: params.toString(),
      contentType: form.enctype === 'multipart/form-data' ? null : 'application/x-www-form-urlencoded',
    };
  }, pageUrl);
  if (!metadata) return null;
  const request: FidelityReplayRequest = {
    url: fidelityDirectRequestUrl(metadata.url, pageUrl),
    method: metadata.method,
  };
  if (metadata.body && metadata.method !== 'GET') request.postData = Buffer.from(metadata.body);
  if (metadata.contentType) request.headers = { 'content-type': metadata.contentType };
  if (metadata.body && metadata.method === 'GET') {
    const url = new URL(request.url);
    for (const [name, value] of new URLSearchParams(metadata.body)) url.searchParams.append(name, value);
    request.url = fidelityDirectRequestUrl(url.toString());
  }
  return request;
}

async function captureCanceledDownloadRequest(
  page: Page,
  trigger: () => Promise<void>,
): Promise<FidelityReplayRequest> {
  const observed: Request[] = [];
  const observe = (request: Request) => observed.push(request);
  page.on('request', observe);
  let download: Download | null = null;
  try {
    const downloadEvent = page.waitForEvent('download', { timeout: 30_000 });
    await trigger();
    download = await downloadEvent;
    const request = [...observed].reverse().find(candidate => candidate.url() === download?.url());
    await download.cancel();
    return request ? replayRequestFromBrowserRequest(request) : {
      url: fidelityDirectRequestUrl(download.url()),
      method: 'GET',
    };
  } catch {
    if (download) await download.cancel().catch(() => {});
    throw new Error('Fidelity download request metadata was unavailable');
  } finally {
    page.off('request', observe);
  }
}

async function executeFidelityRequest(page: Page, request: FidelityReplayRequest): Promise<APIResponse> {
  try {
    return await page.context().request.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      data: request.postData,
      failOnStatusCode: false,
      timeout: 60_000,
    });
  } catch {
    throw new Error('Fidelity direct request failed before receiving a response');
  }
}

function responseMatchesArtifact(response: APIResponse, artifactType: FidelityArtifactType): boolean {
  const contentType = response.headers()['content-type']?.toLowerCase() ?? '';
  if (artifactType === 'activity-csv') {
    return contentType.includes('csv') || contentType.includes('excel') || contentType.includes('octet-stream');
  }
  if (artifactType === 'statement-pdf') {
    return contentType.includes('pdf') || contentType.includes('octet-stream');
  }
  return contentType.includes('html') || contentType.includes('text/plain');
}

async function downloadAndValidatePlan(
  page: Page,
  outputDir: string,
  plan: FidelityArtifactPlan,
  request: FidelityReplayRequest,
): Promise<FidelityDownloadedArtifact> {
  const targetPath = join(outputDir, plan.fileName);
  try {
    const existing = await validateFidelityArtifact(targetPath, plan);
    return { ...plan, path: targetPath, ...existing };
  } catch {}

  const response = await executeFidelityRequest(page, request);
  if (!response.ok()) throw new Error(`Fidelity direct request returned status ${response.status()}`);
  if (!responseMatchesArtifact(response, plan.artifactType)) {
    throw new Error('Fidelity direct response has the wrong content type');
  }
  const temporaryPath = join(outputDir, `.${plan.fileName}.${randomUUID()}.partial`);
  try {
    await writeFile(temporaryPath, await response.body(), { mode: 0o600 });
    const validated = await validateFidelityArtifact(temporaryPath, plan);
    await rename(temporaryPath, targetPath);
    return { ...plan, path: targetPath, ...validated };
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function selectRetailAccount(page: Page, account: FidelityRemoteAccount): Promise<void> {
  const controls = await openRetailAccountSelector(page);
  const control = controls.nth(account.selection.controlIndex);
  await control.waitFor({ state: 'attached', timeout: 30_000 });
  await control.click();
  await page.getByRole('button', { name: /Open time filter/i }).waitFor({ state: 'visible', timeout: 30_000 });
}

async function setRetailActivityRange(page: Page, from: string, through: string): Promise<void> {
  await page.getByRole('button', { name: /Open time filter/i }).click();
  await page.getByText('Custom', { exact: true }).click();
  await page.locator('#input-from-date').fill(from);
  await page.locator('#input-to-date').fill(through);
  const apply = page.getByRole('button', { name: 'Apply', exact: true });
  await apply.click();
  await page.locator('#input-from-date:visible').waitFor({ state: 'hidden', timeout: 30_000 });
}

async function activityRequest(page: Page): Promise<FidelityReplayRequest> {
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const csv = page.getByRole('button', { name: 'Download as CSV', exact: true })
    .or(page.getByRole('link', { name: 'Download as CSV', exact: true }))
    .first();
  await csv.waitFor({ state: 'visible', timeout: 30_000 });
  const direct = await replayRequestFromControl(csv, page.url());
  return direct ?? captureCanceledDownloadRequest(page, () => csv.click());
}

async function downloadRetailActivity(
  page: Page,
  config: Required<FidelitySyncConfig>,
  accounts: FidelityRemoteAccount[],
  report: FidelityProgressReporter,
): Promise<FidelityDownloadedArtifact[]> {
  const artifacts: FidelityDownloadedArtifact[] = [];
  for (const [index, account] of accounts.entries()) {
    const gate = await navigateToFidelityPage(page, FIDELITY_ACTIVITY_URL, [
      '#account-selector',
      'button[aria-label="account selector"]',
    ].join(','));
    assertGate(gate);
    const plan: FidelityArtifactPlan = {
      artifactType: 'activity-csv',
      fileName: fidelityArtifactFileName(account, 'activity-csv', config.from, config.through),
      account,
      coveredFrom: config.from,
      coveredThrough: config.through,
    };
    const artifact = await reportStep(
      report,
      'download',
      `activity-${index + 1}`,
      'Downloading Fidelity activity',
      async () => {
        await selectRetailAccount(page, account);
        await setRetailActivityRange(page, config.from, config.through);
        return downloadAndValidatePlan(page, config.outputDir, plan, await activityRequest(page));
      },
      { surface: account.surface, artifactType: plan.artifactType, index: index + 1, total: accounts.length },
    );
    artifacts.push(artifact);
  }
  return artifacts;
}

async function collectDocumentCandidates(
  page: Page,
  surface: FidelitySurface,
  accountKey?: string,
): Promise<FidelityDocumentCandidate[]> {
  const links = page.locator([
    'a[aria-label*="Download Document"]',
    'a[download]',
    'a[href*=".pdf"]',
    'a[href*="statement"]',
  ].join(','));
  return links.evaluateAll((elements, metadata) => elements.map(element => {
    const anchor = element as HTMLAnchorElement;
    const row = element.closest('tr,li,article,[role="row"]');
    return {
      surface: metadata.surface,
      label: `${row?.textContent ?? ''} ${element.textContent ?? ''}`.replace(/\s+/g, ' ').trim(),
      href: anchor.href,
      accountKey: metadata.accountKey,
    };
  }), { surface, accountKey });
}

async function discoverRetailDocumentPlans(
  page: Page,
  accounts: FidelityRemoteAccount[],
  from: string,
  through: string,
): Promise<FidelityArtifactPlan[]> {
  const gate = await navigateToFidelityPage(page, FIDELITY_ACTIVITY_URL, 'a,button');
  assertGate(gate);
  const documents = page.locator('a,button').filter({ hasText: /^Documents$/i }).first();
  await documents.waitFor({ state: 'visible', timeout: 30_000 });
  await documents.click();
  if (await pageShowsInstitutionUnavailable(page)) throw new FidelityInstitutionUnavailableError('institution-unavailable');
  await page.locator('a[aria-label*="Download Document"], a[href*=".pdf"]').first()
    .waitFor({ state: 'attached', timeout: 30_000 });
  return fidelityStatementPlans(await collectDocumentCandidates(page, 'retail'), accounts, from, through);
}

async function discoverNetBenefitsDocumentPlans(
  page: Page,
  accounts: FidelityRemoteAccount[],
  from: string,
  through: string,
): Promise<FidelityArtifactPlan[]> {
  const plans: FidelityArtifactPlan[] = [];
  for (const account of accounts) {
    if (!account.selection.href) continue;
    const gate = await navigateToFidelityPage(page, fidelityDirectRequestUrl(account.selection.href), 'a,button');
    assertGate(gate);
    const statements = page.locator('a,button').filter({ hasText: /statements?|documents?/i }).first();
    if (await statements.count() === 0) continue;
    await statements.click();
    if (await pageShowsInstitutionUnavailable(page)) throw new FidelityInstitutionUnavailableError('institution-unavailable');
    const candidates = await collectDocumentCandidates(page, 'netbenefits', account.accountKey);
    plans.push(...fidelityStatementPlans(candidates, accounts, from, through));
  }
  return plans;
}

async function downloadStatementPlans(
  page: Page,
  outputDir: string,
  plans: FidelityArtifactPlan[],
  report: FidelityProgressReporter,
): Promise<FidelityDownloadedArtifact[]> {
  const artifacts: FidelityDownloadedArtifact[] = [];
  for (const [index, plan] of plans.entries()) {
    if (!plan.requestUrl) throw new Error('Fidelity statement request metadata is missing');
    const artifact = await reportStep(
      report,
      'download',
      `statement-${index + 1}`,
      'Downloading Fidelity statement',
      () => downloadAndValidatePlan(page, outputDir, plan, { url: plan.requestUrl!, method: 'GET' }),
      { surface: plan.account.surface, artifactType: plan.artifactType, index: index + 1, total: plans.length },
    );
    artifacts.push(artifact);
  }
  return artifacts;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/\S+/g, '[redacted-url]')
    .replace(/\$[\d,]+(?:\.\d{2})?/g, '[amount]')
    .replace(/\b[a-f0-9]{20,}\b/gi, '[redacted-id]')
    .replace(/\b\d{4,}\b/g, '[digits]')
    .slice(0, 500);
}

export function normalizeFidelityHeadlessUserAgent(userAgent: string): string {
  return userAgent.replace('HeadlessChrome/', 'Chrome/');
}

export async function runWithFidelityUserAgent<T>(
  page: Page,
  operation: () => Promise<T>,
): Promise<T> {
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const normalizedUserAgent = normalizeFidelityHeadlessUserAgent(userAgent);
  if (normalizedUserAgent === userAgent) return operation();

  const session = await page.context().newCDPSession(page);
  await session.send('Network.setUserAgentOverride', { userAgent: normalizedUserAgent });
  try {
    return await operation();
  } finally {
    await session.detach().catch(() => {});
  }
}

async function runAuthenticatedFidelity(
  page: Page,
  config: Required<FidelitySyncConfig>,
  report: FidelityProgressReporter,
): Promise<FidelityBrowserResult> {
  const retailDiscovery = await reportStep(
    report,
    'retail-discovery',
    'retail-accounts',
    'Discovering Fidelity retail accounts',
    () => discoverFidelitySurface('retail', () => discoverFidelityRetailAccounts(page)),
  );
  const netBenefitsDiscovery = await reportStep(
    report,
    'netbenefits-discovery',
    'netbenefits-accounts',
    'Discovering Fidelity retirement accounts',
    () => discoverFidelitySurface('netbenefits', () => discoverFidelityNetBenefitsAccounts(page)),
  );
  const { retailAccounts, netBenefitsAccounts, skipped } = resolveFidelitySurfaceDiscoveries([
    retailDiscovery,
    netBenefitsDiscovery,
  ]);
  const accounts = [...retailAccounts, ...netBenefitsAccounts];
  const artifacts = retailAccounts.length > 0
    ? await downloadRetailActivity(page, config, retailAccounts, report)
    : [];
  const statementPlans = await reportStep(
    report,
    'artifact-discovery',
    'statements',
    'Discovering Fidelity statements',
    async () => [
      ...(retailAccounts.length > 0
        ? await discoverRetailDocumentPlans(page, retailAccounts, config.from, config.through)
        : []),
      ...(netBenefitsAccounts.length > 0
        ? await discoverNetBenefitsDocumentPlans(page, netBenefitsAccounts, config.from, config.through)
        : []),
    ],
  );
  artifacts.push(...await downloadStatementPlans(page, config.outputDir, statementPlans, report));
  return { status: 'complete', accountsDiscovered: accounts.length, artifacts, skipped };
}

const fidelityBrowserProgram = `async (page, _reportProgress, bindings) => {
  try {
    return JSON.stringify(await bindings.run(page));
  } catch (error) {
    return JSON.stringify(await bindings.classify(error));
  }
}`;

export async function runFidelitySync(
  input: FidelitySyncConfig,
  report: FidelityProgressReporter = () => {},
): Promise<FidelitySyncResult> {
  const config = safeConfig(input);
  await mkdir(config.outputDir, { recursive: true, mode: 0o700 });
  report({
    phase: 'authentication',
    step: 'session',
    status: 'started',
    message: 'Checking Fidelity authentication',
    timestamp: new Date().toISOString(),
  });

  let result;
  try {
    result = await runInstitutionBrowserProgram<FidelityBrowserResult>(
      {
        name: config.session,
        startUrl: FIDELITY_START_URL,
        contextOptions: {
          downloadsPath: config.outputDir,
        },
      },
      fidelityBrowserProgram,
      {
        completionDescription: 'Fidelity downloads are ready for review.',
        isAuthenticated: isFidelityAuthenticatedPage,
        waitUntilAuthenticated: waitUntilFidelityAuthenticated,
        onProgress: message => report({
          phase: 'authentication',
          step: 'session',
          status: 'started',
          message,
          timestamp: new Date().toISOString(),
        }),
        programBindings: {
          run: (page: Page) => runWithFidelityUserAgent(
            page,
            () => runAuthenticatedFidelity(page, config, report),
          ),
          classify: (error: unknown) => {
            if (error instanceof FidelityAuthenticationRequiredError) {
              return {
                status: 'login-required',
                action: 'Sign in to Fidelity and complete MFA. EasyMoney will continue automatically.',
              };
            }
            if (error instanceof FidelityInstitutionUnavailableError) {
              return { status: 'error', message: 'institution-unavailable' };
            }
            return { status: 'error', message: safeErrorMessage(error) };
          },
        },
      },
    );
  } catch (error) {
    if (error instanceof FidelityInstitutionUnavailableError || safeErrorMessage(error) === 'institution-unavailable') {
      return { status: 'institution-unavailable', accountsDiscovered: 0, artifacts: [], skipped: [] };
    }
    throw new Error(safeErrorMessage(error));
  }

  if (result.status === 'login-required') {
    return { status: 'authentication-required', accountsDiscovered: 0, artifacts: [], skipped: [] };
  }
  if (result.status === 'error') {
    if (result.message === 'institution-unavailable') {
      return { status: 'institution-unavailable', accountsDiscovered: 0, artifacts: [], skipped: [] };
    }
    throw new Error(result.message ?? 'Fidelity connector failed');
  }
  report({
    phase: 'authentication',
    step: 'session',
    status: 'completed',
    message: 'Fidelity authentication check complete',
    timestamp: new Date().toISOString(),
  });
  return {
    status: 'complete',
    accountsDiscovered: result.accountsDiscovered,
    artifacts: result.artifacts,
    skipped: result.skipped,
  };
}
