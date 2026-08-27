import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import type { APIResponse, Download, Locator, Page, Request } from 'playwright';
import { extractText, getDocumentProxy } from 'unpdf';

import { fidelity401kParser } from '../../importParsers/fidelity401k.ts';
import {
  fidelityRemoteAccountId,
  fidelityRetailActivityRemoteAccountId,
} from '../../importParsers/fidelityAccountIdentity.ts';
import { fidelityActivityParser } from '../../importParsers/fidelityActivity.ts';
import { fidelityActivityApiParser } from '../../importParsers/fidelityActivityApi.ts';
import { fidelityInvestmentReportParser } from '../../importParsers/fidelityInvestmentReport.ts';
import { fidelityNetBenefitsStatementParser } from '../../importParsers/fidelityNetBenefitsStatement.ts';
import { fidelityPortfolioStatementParser } from '../../importParsers/fidelityPortfolioStatement.ts';
import type { AppImportParseResult, AppImportParser } from '../../importTypes.ts';
import { runInstitutionBrowserProgram } from '../browserSession.ts';

const FIDELITY_ACTIVITY_URL = 'https://digital.fidelity.com/ftgw/digital/portfolio/activity';
const FIDELITY_NETBENEFITS_URL = 'https://nb.fidelity.com/public/nb/default/home';
const FIDELITY_START_URL = 'data:text/html,<title>EasyMoney Fidelity connector</title>';
const DEFAULT_SESSION = 'fidelity-catchup';
export const FIDELITY_AUTHENTICATION_TIMEOUT_MS = 30 * 60_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FIDELITY_TIME_ZONE = 'America/New_York';
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
export type FidelityArtifactType = 'activity-csv' | 'activity-json' | 'statement-pdf' | 'statement-html';
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
  elementId?: string | null;
  controlIndex?: number;
}

export interface FidelityAccountIdentity {
  surface: FidelitySurface;
  kind: FidelityAccountKind;
  accountKey: string;
  remoteAccountId: string;
  last4: string | null;
  label?: string;
}

export interface FidelityRemoteAccount extends FidelityAccountIdentity {
  siteAccountId: string;
  selection: {
    controlIndex: number;
    href: string | null;
    label: string;
  };
}

export interface FidelityArtifactPlan {
  artifactType: FidelityArtifactType;
  fileName: string;
  account: FidelityAccountIdentity;
  coveredFrom: string | null;
  coveredThrough: string;
}

export interface FidelitySourceAccountClaim {
  remoteAccountId: string;
  sourceAccountName: string;
}

export interface FidelityDownloadedArtifact extends FidelityArtifactPlan {
  path: string;
  parserId: string;
  transactionCount: number;
  balanceCount: number;
  contentHash: string;
  sourceAccounts: FidelitySourceAccountClaim[];
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
  | 'parserId'
  | 'transactionCount'
  | 'balanceCount'
  | 'contentHash'
  | 'sourceAccounts'
  | 'coveredFrom'
  | 'coveredThrough'
>;

export interface FidelityVerifiedActivityAccount {
  account: FidelityRemoteAccount;
  sourceAccount: FidelitySourceAccountClaim;
}

export interface FidelityStatementDocument {
  id: string;
  remoteAccountId: string;
  periodStart: string | null;
  periodEnd: string | null;
  pdfAvailable: boolean;
  householded: boolean;
}

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

function fidelityRuntimeDiagnostic(
  step: string,
  details: Record<string, string | number | boolean | null>,
): void {
  if (process.env.EASYMONEY_FIDELITY_DIAGNOSTICS !== '1') return;
  console.log(JSON.stringify({ connector: 'fidelity', step, ...details }));
}

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

function siteIdentity(candidate: FidelityAccountCandidate): string | null {
  if (candidate.remoteId?.trim()) return candidate.remoteId.trim();
  if (candidate.value?.trim()) return candidate.value.trim();
  if (candidate.href) {
    try {
      const url = new URL(candidate.href, 'https://www.fidelity.com/');
      for (const name of ['account', 'accountId', 'accountNumber', 'acct', 'plan', 'planId']) {
        const value = url.searchParams.get(name);
        if (value) return value;
      }
    } catch {}
  }
  return candidate.elementId?.trim() || null;
}

function candidateRemoteIdentity(candidate: FidelityAccountCandidate): {
  siteAccountId: string;
  remoteAccountId: string;
} {
  const siteAccountId = siteIdentity(candidate);
  if (!siteAccountId || !/^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$/.test(siteAccountId)) {
    throw new Error('Fidelity control is missing a stable site account identity');
  }
  const exactRetailIdentity = fidelityRetailActivityRemoteAccountId(siteAccountId);
  const remoteAccountId = exactRetailIdentity
    ?? `fidelity:${candidate.surface === 'retail' ? 'retail-control' : 'netbenefits'}:${siteAccountId}`;
  return { siteAccountId, remoteAccountId };
}

function opaqueAccountKey(surface: FidelitySurface, identity: string): string {
  return createHash('sha256').update(`${surface}\0${identity}`).digest('hex').slice(0, 12);
}

export function fidelityAccountsFromCandidates(candidates: FidelityAccountCandidate[]): FidelityRemoteAccount[] {
  const accounts = new Map<string, FidelityRemoteAccount>();
  for (const [candidateIndex, candidate] of candidates.entries()) {
    const label = normalizedAccountLabel(candidate.label);
    if (!label || /^(?:all accounts?|select an? account)$/i.test(label)) continue;
    const identity = candidateRemoteIdentity(candidate);
    const accountKey = opaqueAccountKey(candidate.surface, identity.remoteAccountId);
    const account: FidelityRemoteAccount = {
      surface: candidate.surface,
      kind: accountKind(`${label} ${candidate.href ?? ''}`),
      accountKey,
      remoteAccountId: identity.remoteAccountId,
      siteAccountId: identity.siteAccountId,
      last4: accountLast4(`${label} ${candidate.value ?? ''}`),
      label,
      selection: {
        controlIndex: candidate.controlIndex ?? candidateIndex,
        href: candidate.href ?? null,
        label,
      },
    };
    const existing = accounts.get(accountKey);
    if (existing) {
      if (existing.surface !== account.surface || existing.kind !== account.kind
          || existing.remoteAccountId !== account.remoteAccountId
          || existing.siteAccountId !== account.siteAccountId
          || existing.last4 !== account.last4) {
        throw new Error('Fidelity controls expose conflicting account identity');
      }
      continue;
    }
    accounts.set(accountKey, account);
  }

  return [...accounts.values()];
}

export function assertUniqueFidelityRoutingSuffixes(
  accounts: readonly FidelityRemoteAccount[],
): void {
  const routableIdentities = new Set<string>();
  for (const account of accounts) {
    const identity = account.remoteAccountId;
    if (routableIdentities.has(identity)) {
      throw new Error(`Multiple Fidelity ${account.surface} accounts share one remote identity`);
    }
    routableIdentities.add(identity);
  }
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
  if (artifactType === 'activity-json') {
    return `fidelity-${account.surface}-${account.kind}-${account.accountKey}-activity-${from}-to-${through}.json`;
  }
  if (artifactType === 'statement-html') return `fidelity-401k-${account.last4 ?? account.accountKey}-${through.slice(0, 7)}.html`;
  return `fidelity-${slug}-${through}-statement.pdf`;
}

export function fidelityDirectRequestUrl(value: string, baseUrl = 'https://www.fidelity.com/'): string {
  const url = new URL(value, baseUrl);
  if (url.protocol !== 'https:' || !/(?:^|\.)fidelity\.com$/i.test(url.hostname)) {
    throw new Error('Fidelity direct request destination is not trusted');
  }
  url.hash = '';
  return url.toString();
}

export function isFidelityStatementDownloadRequestUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && /(?:^|\.)fidelity\.com$/i.test(url.hostname)
      && /\/accounts\/communications\/financial-documents\/download\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function isFidelityStatementListRequestUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && /(?:^|\.)fidelity\.com$/i.test(url.hostname)
      && /\/accounts\/communications\/financial-documents\/statements\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function isFidelityActivityHistoryRequestUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'digital.fidelity.com'
      && url.pathname === '/ftgw/digital/activityapi/api/v1/transactions/history'
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function isValidIsoDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString().slice(0, 10) === value;
}

function isFidelityActivityDayBoundary(value: unknown, expectedDate: string): boolean {
  if (!isValidIsoDate(expectedDate) || typeof value !== 'number' || !Number.isInteger(value)) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: FIDELITY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value * 1_000)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}` === expectedDate
    && parts.hour === '00'
    && parts.minute === '00'
    && parts.second === '00';
}

function fidelityActivityHistoryRequestAccountId(request: {
  url: string;
  method: string;
  postData?: string | Uint8Array | null;
}): string | null {
  if (request.method.toUpperCase() !== 'POST' || !isFidelityActivityHistoryRequestUrl(request.url)) return null;
  try {
    const text = typeof request.postData === 'string'
      ? request.postData
      : request.postData ? Buffer.from(request.postData).toString('utf8') : '';
    const value = JSON.parse(text) as unknown;
    const root = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    const filter = root?.filter && typeof root.filter === 'object' && !Array.isArray(root.filter)
      ? root.filter as Record<string, unknown>
      : null;
    const accounts = filter?.accounts;
    if (!Array.isArray(accounts) || accounts.length !== 1
        || !accounts[0] || typeof accounts[0] !== 'object' || Array.isArray(accounts[0])) return null;
    const accountId = (accounts[0] as Record<string, unknown>).acctNum;
    return typeof accountId === 'string' && accountId.trim() ? accountId.trim() : null;
  } catch {
    return null;
  }
}

export function assertFidelityActivityHistoryRequest(
  request: {
    url: string;
    method: string;
    postData?: string | Uint8Array | null;
  },
  expected: {
    siteAccountId: string;
    from: string;
    through: string;
  },
): void {
  if (request.method.toUpperCase() !== 'POST'
      || !isFidelityActivityHistoryRequestUrl(request.url)) {
    throw new Error('Fidelity activity history request endpoint is invalid');
  }
  let value: unknown;
  try {
    const text = typeof request.postData === 'string'
      ? request.postData
      : request.postData ? Buffer.from(request.postData).toString('utf8') : '';
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Fidelity activity history request body is invalid');
  }
  const root = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const filter = root?.filter && typeof root.filter === 'object' && !Array.isArray(root.filter)
    ? root.filter as Record<string, unknown>
    : null;
  const accounts = filter?.accounts;
  const criteria = filter?.searchCriteriaDetail && typeof filter.searchCriteriaDetail === 'object'
    && !Array.isArray(filter.searchCriteriaDetail)
    ? filter.searchCriteriaDetail as Record<string, unknown>
    : null;
  const account = Array.isArray(accounts) && accounts.length === 1
    && accounts[0] && typeof accounts[0] === 'object' && !Array.isArray(accounts[0])
    ? accounts[0] as Record<string, unknown>
    : null;
  if (!account || account.acctNum !== expected.siteAccountId
      || typeof account.acctName !== 'string' || !account.acctName.trim()
      || typeof account.acctType !== 'string' || !account.acctType.trim()
      || !criteria
      || !isFidelityActivityDayBoundary(criteria.txnFromDate, expected.from)
      || !isFidelityActivityDayBoundary(criteria.txnToDate, expected.through)
      || typeof criteria.includeBasketNames !== 'boolean'
      || typeof criteria.includeCoreFundSettlementTransactions !== 'boolean') {
    throw new Error('Fidelity activity history request does not match the selected account and date range');
  }
}

export function fidelityStatementDocumentIdFromRequestBody(value: string | Buffer): string {
  let body: unknown;
  try {
    body = JSON.parse(typeof value === 'string' ? value : value.toString('utf8')) as unknown;
  } catch {
    throw new Error('Fidelity statement download request body is invalid');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Fidelity statement download request body is invalid');
  }
  const record = body as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id || typeof record.acctType !== 'string' || typeof record.docType !== 'string'
      || typeof record.formatType !== 'string') {
    throw new Error('Fidelity statement download request metadata is missing');
  }
  return id;
}

export function decodeFidelityStatementDocument(value: unknown): Uint8Array {
  const detail = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { document?: unknown }).document
    : null;
  const documentDetail = detail && typeof detail === 'object' && !Array.isArray(detail)
    ? (detail as { docDetail?: unknown }).docDetail
    : null;
  if (!documentDetail || typeof documentDetail !== 'object' || Array.isArray(documentDetail)) {
    throw new Error('Fidelity statement response metadata is missing');
  }
  const { content, contentType, encoding } = documentDetail as Record<string, unknown>;
  if (typeof content !== 'string' ||
      typeof contentType !== 'string' || !/^application\/pdf$/i.test(contentType.trim()) ||
      typeof encoding !== 'string' || !/^base64$/i.test(encoding.trim())) {
    throw new Error('Fidelity statement response does not contain a base64 PDF');
  }
  const normalized = content.replace(/\s+/g, '');
  if (normalized.length < 8 || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error('Fidelity statement response contains invalid base64');
  }
  const bytes = new Uint8Array(Buffer.from(normalized, 'base64'));
  if (new TextDecoder('ascii').decode(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new Error('Fidelity statement response PDF magic is missing');
  }
  return bytes;
}

function isoDateFromEpoch(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value < 1_000_000_000_000 ? value * 1_000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export function parseFidelityStatementList(value: unknown): FidelityStatementDocument[] {
  const root = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const statement = root?.statement && typeof root.statement === 'object' && !Array.isArray(root.statement)
    ? root.statement as Record<string, unknown>
    : null;
  const docDetails = statement?.docDetails && typeof statement.docDetails === 'object'
    && !Array.isArray(statement.docDetails)
    ? statement.docDetails as Record<string, unknown>
    : null;
  const documents = docDetails?.docDetail;
  if (!Array.isArray(documents)) throw new Error('Fidelity statement list metadata is missing');

  const result: FidelityStatementDocument[] = [];
  const ids = new Set<string>();
  for (const raw of documents) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Fidelity statement list contains invalid document metadata');
    }
    const document = raw as Record<string, unknown>;
    const id = typeof document.id === 'string' ? document.id.trim() : '';
    const remoteAccountId = typeof document.acctNum === 'string'
      ? fidelityRemoteAccountId(document.acctNum)
      : null;
    const formatTypes = document.formatTypes && typeof document.formatTypes === 'object'
      && !Array.isArray(document.formatTypes)
      ? (document.formatTypes as Record<string, unknown>).formatType
      : null;
    const formats = formatTypes && typeof formatTypes === 'object' && !Array.isArray(formatTypes)
      ? formatTypes as Record<string, unknown>
      : null;
    if (!id || !remoteAccountId || ids.has(id)) {
      throw new Error('Fidelity statement list account or document identity is ambiguous');
    }
    ids.add(id);
    result.push({
      id,
      remoteAccountId,
      periodStart: isoDateFromEpoch(document.periodStartDate),
      periodEnd: isoDateFromEpoch(document.periodEndDate),
      pdfAvailable: formats?.isPDF === true,
      householded: document.isHouseholded === true,
    });
  }
  return result;
}

export function verifyFidelityActivityAccounts(
  artifacts: readonly FidelityDownloadedArtifact[],
  accounts: readonly FidelityRemoteAccount[],
): FidelityVerifiedActivityAccount[] {
  const accountByKey = new Map(accounts.map(account => [account.accountKey, account]));
  if (accountByKey.size !== accounts.length) {
    throw new Error('Fidelity discovered account identity is ambiguous');
  }
  const verified: FidelityVerifiedActivityAccount[] = [];
  const seenAccountKeys = new Set<string>();
  const seenRemoteAccountIds = new Set<string>();
  for (const artifact of artifacts.filter(item => (
    item.artifactType === 'activity-csv' || item.artifactType === 'activity-json'
  ))) {
    const account = accountByKey.get(artifact.account.accountKey);
    if (!account || seenAccountKeys.has(account.accountKey) || artifact.sourceAccounts.length > 1) {
      throw new Error('Fidelity activity artifact account identity is ambiguous');
    }
    seenAccountKeys.add(account.accountKey);
    if (artifact.transactionCount === 0 && artifact.balanceCount === 0
        && artifact.sourceAccounts.length === 0) continue;
    if (artifact.sourceAccounts.length !== 1) {
      throw new Error('Fidelity activity artifact account identity is ambiguous');
    }
    const sourceAccount = artifact.sourceAccounts[0]!;
    if (sourceAccount.remoteAccountId !== account.remoteAccountId) {
      throw new Error('Fidelity activity parser identity does not match the selected account');
    }
    const parserLast4 = sourceAccount.remoteAccountId.replace(/^fidelity:/, '').replace(/\D/g, '').slice(-4);
    if (account.last4 && parserLast4 !== account.last4) {
      throw new Error('Fidelity activity parser identity does not match the selected account');
    }
    if (seenRemoteAccountIds.has(sourceAccount.remoteAccountId)) {
      throw new Error('Multiple Fidelity activity accounts expose the same parser identity');
    }
    seenRemoteAccountIds.add(sourceAccount.remoteAccountId);
    verified.push({ account, sourceAccount });
  }
  if (seenAccountKeys.size !== accounts.length) {
    throw new Error('Fidelity activity did not verify every discovered account identity');
  }
  return verified;
}

function statementDocumentMayIntersect(
  document: FidelityStatementDocument,
  from: string,
  through: string,
): boolean {
  if (!document.periodStart || !document.periodEnd) return true;
  return document.periodEnd >= from && document.periodStart <= through;
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

function parserSourceAccountClaims(parsed: AppImportParseResult): FidelitySourceAccountClaim[] {
  const claims = new Map<string, FidelitySourceAccountClaim>();
  const facts = [
    ...parsed.transactions.filter((item): item is NonNullable<typeof item> => Boolean(item)),
    ...parsed.balances,
  ];
  for (const fact of facts) {
    const remoteAccountId = fact.remoteAccountId?.trim();
    const sourceAccountName = fact.account?.replace(/\s+/g, ' ').trim();
    if (!remoteAccountId || !sourceAccountName) {
      throw new Error('Fidelity parser fact is missing a stable account identity');
    }
    const existing = claims.get(remoteAccountId);
    if (existing && existing.sourceAccountName !== sourceAccountName) {
      throw new Error('Fidelity parser account identity is ambiguous');
    }
    claims.set(remoteAccountId, { remoteAccountId, sourceAccountName });
  }
  return [...claims.values()].sort((left, right) => (
    left.remoteAccountId.localeCompare(right.remoteAccountId)
  ));
}

function parsedCoverage(
  parsed: AppImportParseResult,
  plan: Pick<FidelityArtifactPlan, 'artifactType' | 'coveredFrom' | 'coveredThrough'>,
): Pick<FidelityArtifactPlan, 'coveredFrom' | 'coveredThrough'> {
  if (plan.artifactType === 'activity-csv' || plan.artifactType === 'activity-json') {
    return { coveredFrom: plan.coveredFrom, coveredThrough: plan.coveredThrough };
  }
  const dates = [
    ...parsed.transactions.flatMap(transaction => transaction?.date ? [transaction.date.slice(0, 10)] : []),
    ...parsed.balances.flatMap(balance => balance.date ? [balance.date.slice(0, 10)] : []),
  ].sort();
  const coveredFrom = parsed.coveredFrom?.slice(0, 10) ?? dates[0] ?? null;
  const coveredThrough = parsed.coveredTo?.slice(0, 10) ?? dates.at(-1) ?? null;
  if (!coveredFrom || !coveredThrough || coveredFrom > coveredThrough) {
    throw new Error('Fidelity statement parser produced no valid coverage');
  }
  return { coveredFrom, coveredThrough };
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
  if (artifactType === 'activity-json') {
    if (!fidelityActivityApiParser.matches({ fileName, headers: [], sample })) {
      throw new Error('Fidelity activity API artifact did not match the EasyMoney parser');
    }
    return fidelityActivityApiParser;
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
  plan: Pick<
    FidelityArtifactPlan,
    'artifactType' | 'fileName' | 'account' | 'coveredFrom' | 'coveredThrough'
  >,
): Promise<FidelityValidationResult> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size < 16) throw new Error('Fidelity artifact is empty or too small');
  const expectedExtension = plan.artifactType === 'activity-csv'
    ? '.csv'
    : plan.artifactType === 'activity-json'
      ? '.json'
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
  if (plan.artifactType !== 'activity-csv' && plan.artifactType !== 'activity-json'
      && parsed.balances.length === 0) {
    throw new Error('Fidelity statement parser produced no balance');
  }
  const sourceAccounts = parserSourceAccountClaims(parsed);
  const transactionCount = parsed.transactions.filter(Boolean).length;
  if (sourceAccounts.length === 0
      && !((plan.artifactType === 'activity-csv' || plan.artifactType === 'activity-json')
        && transactionCount === 0 && parsed.balances.length === 0)) {
    throw new Error('Fidelity parser produced no stable account identity');
  }
  const coverage = parsedCoverage(parsed, plan);
  return {
    parserId: parser.id,
    transactionCount,
    balanceCount: parsed.balances.length,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    sourceAccounts,
    ...coverage,
  };
}

function safeConfig(config: FidelitySyncConfig): Required<FidelitySyncConfig> {
  if (!isValidIsoDate(config.from) || !isValidIsoDate(config.through) || config.from > config.through) {
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
    || /\/navigate\/ent-documentcenter\//i.test(url.pathname);
}

export function isFidelityRetailActivityUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /(?:^|\.)fidelity\.com$/i.test(url.hostname)
      && /\/ftgw\/digital\/portfolio\/activity(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
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
    const authenticatedPath = /\/ftgw\/digital\/portfolio(?:\/|$)|\/mybenefits(?:\/|$)/i.test(location.pathname);
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

export async function navigateToFidelityPage(
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
    const ready = page.locator(readySelector).first()
      .waitFor({ state: 'attached', timeout: 30_000 })
      .then(() => 'ready' as const);
    const outcome = options.missingControlsMeanNoAccounts
      ? await Promise.race([
        ready,
        page.waitForURL(url => (
          /(?:^|\.)fidelity\.com$/i.test(url.hostname)
          && !fidelityAuthenticationRoute(url)
          && !fidelityAuthenticatedRoute(url)
        ), { waitUntil: 'commit', timeout: 30_000 }).then(() => 'no-accounts' as const),
      ])
      : await ready;
    if (outcome === 'no-accounts') return outcome;
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
    if (options.missingControlsMeanNoAccounts) return 'no-accounts';
    if (!fidelityAuthenticatedRoute(currentUrl)) return 'authentication-required';
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
      elementId: htmlElement.id || null,
      controlIndex,
    };
  }), surface);
}

const retailAccountControlSelector = [
  '#account-selector:visible section[aria-label] a',
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

async function retailAccountSupportsActivity(
  page: Page,
  account: FidelityRemoteAccount,
): Promise<boolean> {
  const startedAt = performance.now();
  fidelityRuntimeDiagnostic('retail-capability-start', {
    controlIndex: account.selection.controlIndex,
    accountKind: account.kind,
  });
  const gate = await navigateToFidelityPage(page, FIDELITY_ACTIVITY_URL, [
    '#account-selector',
    'button[aria-label="account selector"]',
  ].join(','), { missingControlsMeanNoAccounts: true });
  fidelityRuntimeDiagnostic('retail-capability-gate', {
    controlIndex: account.selection.controlIndex,
    gate,
    elapsedMs: Math.round(performance.now() - startedAt),
  });
  if (gate === 'no-accounts') return false;
  assertGate(gate);

  const controls = await openRetailAccountSelector(page);
  const control = controls.nth(account.selection.controlIndex);
  await control.waitFor({ state: 'attached', timeout: 30_000 });
  await control.click();
  if (fidelityAuthenticationRoute(new URL(page.url())) ||
      await page.locator(VISIBLE_AUTHENTICATION_FIELDS).count() > 0) {
    fidelityRuntimeDiagnostic('retail-capability-authentication', {
      controlIndex: account.selection.controlIndex,
      phase: 'after-control',
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    throw new FidelityAuthenticationRequiredError('authentication-required');
  }
  if (await pageShowsInstitutionUnavailable(page)) {
    throw new FidelityInstitutionUnavailableError('institution-unavailable');
  }
  if (!isFidelityRetailActivityUrl(page.url())) {
    fidelityRuntimeDiagnostic('retail-capability-unsupported', {
      controlIndex: account.selection.controlIndex,
      phase: 'after-control',
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    return false;
  }

  try {
    await page.getByRole('button', { name: /Open time filter/i })
      .waitFor({ state: 'visible', timeout: 30_000 });
  } catch {
    if (fidelityAuthenticationRoute(new URL(page.url())) ||
        await page.locator(VISIBLE_AUTHENTICATION_FIELDS).count() > 0) {
      fidelityRuntimeDiagnostic('retail-capability-authentication', {
        controlIndex: account.selection.controlIndex,
        phase: 'activity-controls-timeout',
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      throw new FidelityAuthenticationRequiredError('authentication-required');
    }
    if (await pageShowsInstitutionUnavailable(page)) {
      throw new FidelityInstitutionUnavailableError('institution-unavailable');
    }
    if (!isFidelityRetailActivityUrl(page.url())) {
      fidelityRuntimeDiagnostic('retail-capability-unsupported', {
        controlIndex: account.selection.controlIndex,
        phase: 'activity-controls-timeout',
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      return false;
    }
    throw new Error('Fidelity activity controls did not become available');
  }
  fidelityRuntimeDiagnostic('retail-capability-ready', {
    controlIndex: account.selection.controlIndex,
    elapsedMs: Math.round(performance.now() - startedAt),
  });
  return true;
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
  fidelityRuntimeDiagnostic('retail-candidates', {
    candidateCount: accounts.length,
  });
  return filterFidelityRetailActivityAccounts(
    accounts,
    account => retailAccountSupportsActivity(page, account),
  );
}

export async function filterFidelityRetailActivityAccounts(
  accounts: readonly FidelityRemoteAccount[],
  supportsActivity: (account: FidelityRemoteAccount) => Promise<boolean>,
): Promise<FidelityRemoteAccount[]> {
  const supported: FidelityRemoteAccount[] = [];
  for (const account of accounts) {
    if (await supportsActivity(account)) supported.push(account);
  }
  assertUniqueFidelityRoutingSuffixes(supported);
  return supported;
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
  const accounts = fidelityAccountsFromCandidates(candidates);
  assertUniqueFidelityRoutingSuffixes(accounts);
  return accounts;
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

  if (results.every(result => result.status === 'institution-unavailable')) {
    throw new FidelityInstitutionUnavailableError('institution-unavailable');
  }

  const retailAccounts = retail.status === 'accounts' ? retail.accounts : [];
  const netBenefitsAccounts = netBenefits.status === 'accounts' ? netBenefits.accounts : [];
  if (retailAccounts.length + netBenefitsAccounts.length === 0) {
    if (results.some(result => result.status === 'authentication-required')) {
      throw new FidelityAuthenticationRequiredError('authentication-required');
    }
    throw new Error('Fidelity did not expose accounts on an available surface');
  }

  const skipped = results.flatMap(result => {
    if (result.status === 'accounts') {
      return result.surface === 'netbenefits'
        ? ['Fidelity NetBenefits accounts were discovered, but their downloads are not yet parser-verified']
        : [];
    }
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

export function fidelityResponseRequiresAuthentication(response: {
  status: number;
  url: string;
  headers?: Record<string, string>;
  bodyText?: string | null;
}): boolean {
  if (response.status === 401 || response.status === 403) return true;
  try {
    if (fidelityAuthenticationRoute(new URL(response.url))) return true;
  } catch {
    return true;
  }
  const location = Object.entries(response.headers ?? {})
    .find(([name]) => name.toLowerCase() === 'location')?.[1];
  if (location) {
    try {
      if (fidelityAuthenticationRoute(new URL(location, response.url))) return true;
    } catch {
      return true;
    }
  }
  if (response.status >= 300 && response.status < 400) return true;
  const bodyText = response.bodyText ?? '';
  return /<input[^>]+type=["']?password\b|(?:sign|log)\s*in\s+to\s+fidelity|<title>[^<]*(?:sign|log)\s*in/i
    .test(bodyText);
}

function replayRequestFromBrowserRequest(request: Request): FidelityReplayRequest {
  return {
    url: fidelityDirectRequestUrl(request.url()),
    method: request.method(),
    headers: safeReplayHeaders(request.headers()),
    postData: request.postDataBuffer() ?? undefined,
  };
}

async function executeFidelityRequest(page: Page, request: FidelityReplayRequest): Promise<APIResponse> {
  try {
    const response = await page.context().request.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      data: request.postData,
      failOnStatusCode: false,
      timeout: 60_000,
    });
    const headers = response.headers();
    const bodyText = headers['content-type']?.toLowerCase().includes('html')
      ? await response.text().catch(() => '')
      : null;
    if (fidelityResponseRequiresAuthentication({
      status: response.status(),
      url: response.url(),
      headers,
      bodyText,
    })) {
      throw new FidelityAuthenticationRequiredError('authentication-required');
    }
    return response;
  } catch (error) {
    if (error instanceof FidelityAuthenticationRequiredError) throw error;
    throw new Error('Fidelity direct request failed before receiving a response');
  }
}

function responseMatchesArtifact(response: APIResponse, artifactType: FidelityArtifactType): boolean {
  const contentType = response.headers()['content-type']?.toLowerCase() ?? '';
  if (artifactType === 'activity-csv') {
    return contentType.includes('csv') || contentType.includes('excel') || contentType.includes('octet-stream');
  }
  if (artifactType === 'activity-json') return contentType.includes('json');
  if (artifactType === 'statement-pdf') {
    return contentType.includes('pdf') || contentType.includes('octet-stream');
  }
  return contentType.includes('html') || contentType.includes('text/plain');
}

export function assertFidelityActivityResponseAccount(
  bytes: Uint8Array,
  expected: Pick<FidelityRemoteAccount, 'remoteAccountId' | 'siteAccountId'>,
): void {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error('Fidelity activity API response is not valid JSON');
  }
  const root = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const errors = root?.errors;
  const data = root?.data && typeof root.data === 'object' && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : null;
  if (!root || (errors !== undefined && errors !== null
      && (!Array.isArray(errors) || errors.length > 0)) || !Array.isArray(data?.transactions)) {
    throw new Error('Fidelity activity API response structure is invalid');
  }
  for (const transaction of data.transactions) {
    const item = transaction && typeof transaction === 'object' && !Array.isArray(transaction)
      ? transaction as Record<string, unknown>
      : null;
    const siteAccountId = typeof item?.acctNum === 'string' ? item.acctNum.trim() : '';
    if (!siteAccountId || siteAccountId !== expected.siteAccountId
        || fidelityRetailActivityRemoteAccountId(siteAccountId) !== expected.remoteAccountId) {
      throw new Error('Fidelity activity API response account does not match the selected account');
    }
  }
}

async function artifactBytesFromResponse(
  response: APIResponse,
  artifactType: FidelityArtifactType,
): Promise<Uint8Array> {
  const contentType = response.headers()['content-type']?.toLowerCase() ?? '';
  if (artifactType === 'statement-pdf' && contentType.includes('json')) {
    return decodeFidelityStatementDocument(await response.json());
  }
  if (!responseMatchesArtifact(response, artifactType)) {
    throw new Error('Fidelity direct response has the wrong content type');
  }
  return new Uint8Array(await response.body());
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
    if (plan.artifactType === 'activity-json') {
      const siteAccountId = 'siteAccountId' in plan.account && typeof plan.account.siteAccountId === 'string'
        ? plan.account.siteAccountId
        : null;
      if (!siteAccountId) {
        throw new Error('Fidelity activity plan is missing the selected site account identity');
      }
      assertFidelityActivityResponseAccount(new Uint8Array(await readFile(targetPath)), {
        remoteAccountId: plan.account.remoteAccountId,
        siteAccountId,
      });
    }
    return { ...plan, path: targetPath, ...existing };
  } catch {}

  const response = await executeFidelityRequest(page, request);
  if (!response.ok()) throw new Error(`Fidelity direct request returned status ${response.status()}`);
  const bytes = await artifactBytesFromResponse(response, plan.artifactType);
  if (plan.artifactType === 'activity-json') {
    const siteAccountId = 'siteAccountId' in plan.account && typeof plan.account.siteAccountId === 'string'
      ? plan.account.siteAccountId
      : null;
    if (!siteAccountId) {
      throw new Error('Fidelity activity plan is missing the selected site account identity');
    }
    assertFidelityActivityResponseAccount(bytes, {
      remoteAccountId: plan.account.remoteAccountId,
      siteAccountId,
    });
  }
  const temporaryPath = join(outputDir, `.${plan.fileName}.${randomUUID()}.partial`);
  try {
    await writeFile(temporaryPath, bytes, { mode: 0o600 });
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
  const responsePromise = page.waitForResponse(response => (
    fidelityActivityHistoryRequestAccountId({
      url: response.url(),
      method: response.request().method(),
      postData: response.request().postDataBuffer(),
    }) === account.siteAccountId
  ), { timeout: 60_000 });
  await control.click();
  const response = await responsePromise;
  await response.finished();
  const headers = response.headers();
  const bodyText = headers['content-type']?.toLowerCase().includes('html')
    ? await response.text().catch(() => '')
    : null;
  if (fidelityResponseRequiresAuthentication({
    status: response.status(),
    url: response.url(),
    headers,
    bodyText,
  })) {
    throw new FidelityAuthenticationRequiredError('authentication-required');
  }
  if (!response.ok()) throw new Error(`Fidelity account selection returned status ${response.status()}`);
  await page.getByRole('button', { name: /Open time filter/i }).waitFor({ state: 'visible', timeout: 30_000 });
}

async function setRetailActivityRange(
  page: Page,
  account: FidelityRemoteAccount,
  from: string,
  through: string,
): Promise<FidelityReplayRequest> {
  await page.getByRole('button', { name: /Open time filter/i }).click();
  await page.getByText('Custom', { exact: true }).click();
  await page.locator('#input-from-date').fill(from);
  await page.locator('#input-to-date').fill(through);
  const apply = page.getByRole('button', { name: 'Apply', exact: true });
  const requestPromise = page.waitForRequest(request => {
    try {
      assertFidelityActivityHistoryRequest({
        url: request.url(),
        method: request.method(),
        postData: request.postDataBuffer(),
      }, { siteAccountId: account.siteAccountId, from, through });
      return true;
    } catch {
      return false;
    }
  }, { timeout: 60_000 });
  await apply.click();
  const request = await requestPromise;
  await page.locator('#input-from-date:visible').waitFor({ state: 'hidden', timeout: 30_000 });
  assertFidelityActivityHistoryRequest({
    url: request.url(),
    method: request.method(),
    postData: request.postDataBuffer(),
  }, { siteAccountId: account.siteAccountId, from, through });
  return replayRequestFromBrowserRequest(request);
}

export async function saveAndValidateFidelityBrowserDownload(
  download: Pick<Download, 'cancel' | 'saveAs'>,
  outputDir: string,
  plan: FidelityArtifactPlan,
): Promise<FidelityDownloadedArtifact> {
  const targetPath = join(outputDir, plan.fileName);
  try {
    const existing = await validateFidelityArtifact(targetPath, plan);
    await download.cancel().catch(() => {});
    return { ...plan, path: targetPath, ...existing };
  } catch {}

  const temporaryPath = join(outputDir, `.${plan.fileName}.${randomUUID()}.partial`);
  try {
    await download.saveAs(temporaryPath);
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
    const validated = await validateFidelityArtifact(temporaryPath, plan);
    await rename(temporaryPath, targetPath);
    return { ...plan, path: targetPath, ...validated };
  } finally {
    await download.cancel().catch(() => {});
    await rm(temporaryPath, { force: true });
  }
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
      artifactType: 'activity-json',
      fileName: fidelityArtifactFileName(account, 'activity-json', config.from, config.through),
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
        const request = await setRetailActivityRange(page, account, config.from, config.through);
        return downloadAndValidatePlan(page, config.outputDir, plan, request);
      },
      { surface: account.surface, artifactType: plan.artifactType, index: index + 1, total: accounts.length },
    );
    artifacts.push(artifact);
  }
  return artifacts;
}

const fidelityStatementControlSelector = 'a[aria-label*="Download Document"]';

type FidelityStatementView = {
  documents: FidelityStatementDocument[];
};

async function statementListFromRequest(page: Page, request: Request): Promise<FidelityStatementDocument[]> {
  const response = await executeFidelityRequest(page, replayRequestFromBrowserRequest(request));
  if (!response.ok()) throw new Error(`Fidelity statement list returned status ${response.status()}`);
  const contentType = response.headers()['content-type']?.toLowerCase() ?? '';
  if (!contentType.includes('json')) throw new Error('Fidelity statement list response is not JSON');
  return parseFidelityStatementList(await response.json());
}

async function openRetailStatementCenter(page: Page): Promise<FidelityStatementView> {
  const gate = await navigateToFidelityPage(page, FIDELITY_ACTIVITY_URL, 'a[data-utility="Documents"]');
  assertGate(gate);
  const documents = page.locator('a[data-utility="Documents"]').first();
  await documents.waitFor({ state: 'attached', timeout: 30_000 });
  const href = await documents.getAttribute('href');
  if (!href) throw new Error('Fidelity Documents destination is missing');
  const requestPromise = page.waitForRequest(request => (
    request.method() === 'POST' && isFidelityStatementListRequestUrl(request.url())
  ), { timeout: 60_000 });
  const documentsGatePromise = navigateToFidelityPage(
    page,
    fidelityDirectRequestUrl(href, page.url()),
    'body',
  );
  const [request, documentsGate] = await Promise.all([requestPromise, documentsGatePromise]);
  assertGate(documentsGate);
  return { documents: await statementListFromRequest(page, request) };
}

async function statementYearOptions(page: Page): Promise<{
  selectIndex: number;
  options: Array<{ year: string; value: string; selected: boolean }>;
} | null> {
  const candidates = await page.locator('select:visible').evaluateAll(elements => elements.map((element, selectIndex) => {
    const select = element as HTMLSelectElement;
    return {
      selectIndex,
      options: [...select.options].flatMap(option => {
        const year = (option.textContent ?? '').trim();
        return /^20\d{2}$/.test(year) ? [{ year, value: option.value, selected: option.selected }] : [];
      }),
    };
  }).filter(candidate => candidate.options.length > 0));
  if (candidates.length > 1) throw new Error('Fidelity statement year selector is ambiguous');
  return candidates[0] ?? null;
}

export function fidelityStatementYearTraversal(
  requestedYears: readonly string[],
  options: readonly { year: string; selected: boolean }[],
): {
  orderedYears: string[];
  missingYears: string[];
  useInitialView: boolean;
} {
  const available = new Map(options.map(option => [option.year, option]));
  const availableRequested = requestedYears.filter(year => available.has(year));
  const selectedYear = availableRequested.find(year => available.get(year)?.selected);
  return {
    orderedYears: selectedYear
      ? [selectedYear, ...availableRequested.filter(year => year !== selectedYear)]
      : availableRequested,
    missingYears: requestedYears.filter(year => !available.has(year)),
    useInitialView: availableRequested.length === 0,
  };
}

export async function traverseFidelityStatementYears<T>(options: {
  initialView: T;
  requestedYears: readonly string[];
  initialOptions: readonly { year: string; selected: boolean }[];
  selectYear: (year: string) => Promise<T>;
  processView: (view: T) => Promise<void>;
}): Promise<ReturnType<typeof fidelityStatementYearTraversal>> {
  const traversal = fidelityStatementYearTraversal(options.requestedYears, options.initialOptions);
  if (traversal.useInitialView) {
    await options.processView(options.initialView);
    return traversal;
  }
  const initiallySelectedYear = options.initialOptions.find(option => option.selected)?.year;
  for (const year of traversal.orderedYears) {
    await options.processView(year === initiallySelectedYear
      ? options.initialView
      : await options.selectYear(year));
  }
  return traversal;
}

async function selectStatementYear(
  page: Page,
  selectIndex: number,
  option: { year: string; value: string; selected: boolean },
): Promise<FidelityStatementView> {
  if (option.selected) {
    throw new Error('Fidelity statement year option did not require a new request');
  }
  const responsePromise = page.waitForResponse(response => (
    response.request().method() === 'POST'
    && isFidelityStatementListRequestUrl(response.url())
  ), { timeout: 60_000 });
  await page.locator('select:visible').nth(selectIndex).selectOption(option.value, { timeout: 60_000 });
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`Fidelity statement year request returned status ${response.status()}`);
  await response.finished();
  return { documents: await statementListFromRequest(page, response.request()) };
}

async function waitForStatementControls(page: Page, expected: number): Promise<void> {
  await page.waitForFunction(({ selector, expectedCount }) => (
    document.querySelectorAll(selector).length === expectedCount
  ), { selector: fidelityStatementControlSelector, expectedCount: expected }, { timeout: 60_000 });
}

async function captureStatementRequest(page: Page, controlIndex: number): Promise<{
  documentId: string;
  request: FidelityReplayRequest;
}> {
  const control = page.locator(fidelityStatementControlSelector).nth(controlIndex);
  await control.waitFor({ state: 'attached', timeout: 30_000 });
  const requestPromise = page.waitForRequest(request => (
    request.method() === 'POST'
    && isFidelityStatementDownloadRequestUrl(request.url())
    && Boolean(request.postDataBuffer()?.byteLength)
  ), { timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await control.click();
  const [request, download] = await Promise.all([requestPromise, downloadPromise]);
  await download.cancel().catch(() => {});
  const postData = request.postDataBuffer();
  if (!postData) throw new Error('Fidelity statement download request body is missing');
  return {
    documentId: fidelityStatementDocumentIdFromRequestBody(postData),
    request: replayRequestFromBrowserRequest(request),
  };
}

function statementPlan(
  document: FidelityStatementDocument,
  through: string,
): FidelityArtifactPlan {
  const documentKey = createHash('sha256').update(document.id).digest('hex').slice(0, 10);
  const date = document.periodEnd ?? through;
  return {
    artifactType: 'statement-pdf',
    fileName: `fidelity-statement-${date.slice(0, 7)}-${documentKey}.pdf`,
    account: {
      surface: 'retail',
      kind: 'other',
      accountKey: opaqueAccountKey('retail', document.remoteAccountId),
      remoteAccountId: document.remoteAccountId,
      last4: null,
      label: 'Fidelity statement account',
    },
    coveredFrom: document.periodStart,
    coveredThrough: date,
  };
}

export function fidelityArtifactDedupeKey(artifact: FidelityDownloadedArtifact): string {
  return JSON.stringify({
    contentHash: artifact.contentHash,
    parserId: artifact.parserId,
    sourceAccounts: artifact.sourceAccounts.map(account => account.remoteAccountId).sort(),
    coveredFrom: artifact.coveredFrom,
    coveredThrough: artifact.coveredThrough,
  });
}

export function assertFidelityStatementControlBijection(
  documents: readonly Pick<FidelityStatementDocument, 'id'>[],
  capturedDocumentIds: readonly string[],
): void {
  const listed = new Set(documents.map(document => document.id));
  const captured = new Set(capturedDocumentIds);
  if (listed.size !== documents.length || captured.size !== capturedDocumentIds.length
      || listed.size !== captured.size
      || [...listed].some(id => !captured.has(id))) {
    throw new Error('Fidelity statement controls do not match list metadata exactly');
  }
}

async function downloadStatementView(
  page: Page,
  config: Required<FidelitySyncConfig>,
  view: FidelityStatementView,
  seenDocumentIds: Set<string>,
  seenArtifactKeys: Set<string>,
  report: FidelityProgressReporter,
): Promise<FidelityDownloadedArtifact[]> {
  await waitForStatementControls(page, view.documents.length);
  const documentsById = new Map(view.documents.map(document => [document.id, document]));
  if (documentsById.size !== view.documents.length) {
    throw new Error('Fidelity statement view repeats document identity');
  }
  const artifacts: FidelityDownloadedArtifact[] = [];
  const controlCount = await page.locator(fidelityStatementControlSelector).count();
  const capturedRequests: Array<{
    documentId: string;
    request: FidelityReplayRequest;
  }> = [];
  for (let controlIndex = 0; controlIndex < controlCount; controlIndex += 1) {
    capturedRequests.push(await captureStatementRequest(page, controlIndex));
  }
  assertFidelityStatementControlBijection(
    view.documents,
    capturedRequests.map(captured => captured.documentId),
  );
  for (const captured of capturedRequests) {
    const document = documentsById.get(captured.documentId);
    if (!document) throw new Error('Fidelity statement control was not present in list metadata');
    if (seenDocumentIds.has(document.id)) continue;
    seenDocumentIds.add(document.id);
    if (!document.pdfAvailable || !statementDocumentMayIntersect(document, config.from, config.through)) continue;
    if (document.householded) {
      throw new Error('Fidelity householded statement identity is not supported');
    }
    const plan = statementPlan(document, config.through);
    const artifact = await reportStep(
      report,
      'download',
      `statement-${seenDocumentIds.size}`,
      'Downloading Fidelity statement',
      () => downloadAndValidatePlan(page, config.outputDir, plan, captured.request),
      { surface: 'retail', artifactType: plan.artifactType },
    );
    if (artifact.sourceAccounts.length !== 1
        || artifact.sourceAccounts[0]!.remoteAccountId !== document.remoteAccountId) {
      await rm(artifact.path, { force: true });
      throw new Error('Fidelity statement parser identity does not match list metadata');
    }
    if (!artifact.coveredFrom || artifact.coveredThrough < config.from
        || artifact.coveredFrom > config.through) {
      await rm(artifact.path, { force: true });
      continue;
    }
    const dedupeKey = fidelityArtifactDedupeKey(artifact);
    if (seenArtifactKeys.has(dedupeKey)) {
      await rm(artifact.path, { force: true });
      continue;
    }
    seenArtifactKeys.add(dedupeKey);
    artifacts.push(artifact);
  }
  return artifacts;
}

async function downloadRetailStatements(
  page: Page,
  config: Required<FidelitySyncConfig>,
  report: FidelityProgressReporter,
): Promise<FidelityDownloadedArtifact[]> {
  const initialView = await openRetailStatementCenter(page);
  const yearSelector = await statementYearOptions(page);
  const requestedYears = Array.from(
    { length: Number(config.through.slice(0, 4)) - Number(config.from.slice(0, 4)) + 1 },
    (_, index) => String(Number(config.from.slice(0, 4)) + index),
  );
  const artifacts: FidelityDownloadedArtifact[] = [];
  const seenDocumentIds = new Set<string>();
  const seenArtifactKeys = new Set<string>();
  const processView = async (view: FidelityStatementView) => {
    artifacts.push(...await downloadStatementView(
      page,
      config,
      view,
      seenDocumentIds,
      seenArtifactKeys,
      report,
    ));
  };
  const traversal = fidelityStatementYearTraversal(requestedYears, yearSelector?.options ?? []);
  if (traversal.missingYears.length > 0) {
    report({
      phase: 'artifact-discovery',
      step: 'statement-years',
      status: 'completed',
      message: 'Some requested Fidelity statement years are unavailable',
      timestamp: new Date().toISOString(),
      details: {
        requestedYears: requestedYears.length,
        availableYears: traversal.orderedYears.length,
        unavailableYears: traversal.missingYears.length,
      },
    });
  }
  await traverseFidelityStatementYears({
    initialView,
    requestedYears,
    initialOptions: yearSelector?.options ?? [],
    processView,
    selectYear: async year => {
      const currentSelector = await statementYearOptions(page);
      if (!currentSelector) throw new Error('Fidelity statement year selector disappeared');
      const option = currentSelector.options.find(candidate => candidate.year === year);
      if (!option) throw new Error('Fidelity statement year became unavailable');
      if (option.selected) {
        throw new Error('Fidelity statement year selection did not advance');
      }
      return selectStatementYear(page, currentSelector.selectIndex, option);
    },
  });
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
  const activityArtifacts = retailAccounts.length > 0
    ? await downloadRetailActivity(page, config, retailAccounts, report)
    : [];
  if (retailAccounts.length > 0) {
    verifyFidelityActivityAccounts(activityArtifacts, retailAccounts);
  }
  const quietActivity = activityArtifacts.filter(artifact => (
    artifact.transactionCount === 0 && artifact.balanceCount === 0
  ));
  await Promise.all(quietActivity.map(artifact => rm(artifact.path, { force: true })));
  if (quietActivity.length > 0) {
    skipped.push(
      `Fidelity omitted ${quietActivity.length} empty activity export${quietActivity.length === 1 ? '' : 's'}`,
    );
  }
  const artifacts = activityArtifacts.filter(artifact => !quietActivity.includes(artifact));
  if (retailAccounts.length > 0) {
    artifacts.push(...await reportStep(
      report,
      'artifact-discovery',
      'statements',
      'Discovering Fidelity statements',
      () => downloadRetailStatements(page, config, report),
    ));
  }
  const sourceAccounts = new Set(artifacts.flatMap(artifact => (
    artifact.sourceAccounts.map(account => account.remoteAccountId)
  )));
  return { status: 'complete', accountsDiscovered: sourceAccounts.size || accounts.length, artifacts, skipped };
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
        authenticationTimeoutMs: FIDELITY_AUTHENTICATION_TIMEOUT_MS,
        onProgress: message => report({
          phase: 'authentication',
          step: 'session',
          status: 'started',
          message,
          timestamp: new Date().toISOString(),
        }),
        programBindings: {
          run: (page: Page) => runAuthenticatedFidelity(page, config, report),
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
