import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { marcusStatementParser } from '../../importParsers/marcusStatement.ts';
import type { AppImportParser, AppImportParseResult } from '../../importTypes.ts';
import {
  playwrightHasSavedAuthentication,
  runInstitutionBrowserProgram,
  type InstitutionBrowserProgramResult,
} from '../browserSession.ts';
import { reportSyncStep } from '../observability.ts';
import type { SyncReporter } from '../types.ts';
import type { APIResponse, Page, Request } from 'playwright';

const LOGIN_URL = 'https://www.marcus.com/us/en/login';
const ACCOUNTS_URL = 'https://www.marcus.com/us/en/accounts';
const DOCUMENTS_URL = 'https://www.marcus.com/us/en/documents';
const MARCUS_ORIGIN = 'https://www.marcus.com';
const MARCUS_COS_PATH = '/api/cos';
const MARCUS_COS_QUERY_KEY = 'operations';
const MARCUS_ACCOUNTS_REQUEST_MARKER = 'savingsAccountsInput';
const MARCUS_DOCUMENTS_REQUEST_MARKER = 'savingsDocumentList';
const AUTHENTICATION_FIELD_SELECTOR = [
  'input[type="password"]:visible',
  'input[autocomplete="username"]:visible',
  'input[autocomplete="current-password"]:visible',
].join(',');
const LOGIN_PATH_PATTERN = /(?:login|logon|sign[-_]?in|authenticate|challenge|verify|mfa|otp)/i;
const DOCUMENT_PATH_PATTERN = /^\/api\/savings\/api\/[^/]+\/accounts\/document\/[^/]+\/?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const MARCUS_PROFILE_NAME = 'marcus-catchup';

export type MarcusAccountKind = 'savings' | 'deposit';
export type MarcusArtifactType = 'statement-pdf';

export interface MarcusAccountIdentity {
  kind: MarcusAccountKind;
  last4: string;
  sourceAccountKey: string;
  parserAccountName: string | null;
}

export interface MarcusRemoteAccount extends MarcusAccountIdentity {
  supportedArtifactTypes: MarcusArtifactType[];
  availableArtifactCount: number;
}

export interface MarcusDownloadedArtifact {
  fileName: string;
  path: string;
  artifactType: MarcusArtifactType;
  accountId: number;
  account: MarcusAccountIdentity;
  statementDate: string;
  parserId: string;
  size: number;
  transactionCount: number;
  balanceCount: number;
}

export interface MarcusSyncConfig {
  outputDir: string;
  through: string;
  accounts: MarcusSyncAccount[];
  session?: string;
  profilePath?: string;
  allowInteractiveAuthentication?: boolean;
}

export interface MarcusSyncAccount {
  accountId: number;
  kind: MarcusAccountKind;
  last4: string;
  startDate: string;
}

export type MarcusAuthenticationReason = 'missing' | 'expired';

export type MarcusSyncResult =
  | {
      status: 'authentication-required';
      reason: MarcusAuthenticationReason;
      accounts: [];
      artifacts: [];
    }
  | {
      status: 'complete';
      accounts: MarcusRemoteAccount[];
      artifacts: MarcusDownloadedArtifact[];
      unsupportedArtifactCount: number;
      unmappedAccountCount: number;
      unavailableAccountCount: number;
    };

export interface MarcusAccountMetadata {
  text: string;
  remoteKey?: string | null;
}

export interface MarcusDocumentMetadata {
  href: string;
  accountText: string;
  documentText: string;
  remoteKey?: string | null;
}

export type MarcusApiCatalogOperation = 'accounts' | 'documents';

export interface MarcusApiRequest {
  method: 'GET';
  url: string;
}

export interface MarcusCatalogDocument {
  account: MarcusAccountIdentity;
  artifactType: MarcusArtifactType;
  statementDate: string;
  request: MarcusApiRequest;
}

export interface MarcusRemoteCatalog {
  accounts: MarcusRemoteAccount[];
  documents: MarcusCatalogDocument[];
  unsupportedArtifactCount: number;
}

export interface MarcusMappedAccount {
  remote: MarcusRemoteAccount;
  planned: MarcusSyncAccount;
}

export interface MarcusCatalogPlan {
  mappedAccounts: MarcusMappedAccount[];
  documents: Array<{
    document: MarcusCatalogDocument;
    planned: MarcusSyncAccount;
  }>;
  unmappedAccountCount: number;
  unavailableAccountCount: number;
}

type MarcusBrowserResult = {
  result: Extract<MarcusSyncResult, { status: 'complete' }>;
};

type MarcusParserLike = Pick<AppImportParser, 'id' | 'matches' | 'parse'>;

export interface MarcusSyncDependencies {
  hasSavedAuthentication: typeof playwrightHasSavedAuthentication;
  runBrowserProgram: typeof runInstitutionBrowserProgram;
  parser: MarcusParserLike;
}

const defaultDependencies: MarcusSyncDependencies = {
  hasSavedAuthentication: playwrightHasSavedAuthentication,
  runBrowserProgram: runInstitutionBrowserProgram,
  parser: marcusStatementParser,
};

function validateDateRange(from: string, through: string): void {
  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(through) || from > through) {
    throw new Error('Marcus dates must be ordered YYYY-MM-DD values');
  }
}

function validateSyncAccounts(accounts: MarcusSyncAccount[], through: string): void {
  if (accounts.length === 0) throw new Error('Marcus sync requires at least one planned account');
  const identities = new Set<string>();
  for (const account of accounts) {
    validateDateRange(account.startDate, through);
    if (!Number.isSafeInteger(account.accountId) || account.accountId <= 0) {
      throw new Error('Marcus planned account ID is invalid');
    }
    if (!/^\d{4}$/.test(account.last4)) {
      throw new Error('Marcus planned account number must contain exactly four digits');
    }
    const identity = `${account.kind}:${account.last4}`;
    if (identities.has(identity)) {
      throw new Error('Marcus planned account identities are ambiguous');
    }
    identities.add(identity);
  }
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function accountKindFromText(value: string): MarcusAccountKind | null {
  const savings = /\b(?:online\s+)?savings(?:\s+account)?\b/i.test(value);
  const deposit = /\b(?:certificate\s+of\s+deposit|deposit\s+account|(?:no[- ]penalty|high[- ]yield)\s+cd|cd)\b/i.test(value);
  if (savings === deposit) return null;
  return savings ? 'savings' : 'deposit';
}

function accountLast4FromText(value: string): string | null {
  const candidates = new Set<string>();
  for (const match of value.matchAll(
    /(?:account(?:\s+(?:number|ending\s+in))?|ending\s+in)\D{0,16}(\d{4,})\b/gi,
  )) {
    candidates.add(match[1]!.slice(-4));
  }
  for (const match of value.matchAll(/(?:[*x\u2022]\s*){2,}(\d{4})\b/gi)) {
    candidates.add(match[1]!);
  }
  for (const match of value.matchAll(
    /\b(?:online\s+savings(?:\s+account)?|savings\s+account|certificate\s+of\s+deposit|deposit\s+account|(?:no[- ]penalty|high[- ]yield)\s+cd|cd)\s*[-:]\s*(\d{4})\b/gi,
  )) {
    candidates.add(match[1]!);
  }
  return candidates.size === 1 ? [...candidates][0]! : null;
}

export function marcusAccountIdentityFromText(value: string): MarcusAccountIdentity | null {
  const text = normalizedText(value);
  const kind = accountKindFromText(text);
  const last4 = accountLast4FromText(text);
  if (!kind || !last4) return null;
  return {
    kind,
    last4,
    sourceAccountKey: `marcus:${kind}:${last4}`,
    parserAccountName: kind === 'savings' ? `Online Savings - ${last4}` : null,
  };
}

const monthNumbers: Record<string, string> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
};

export function marcusStatementDateFromText(value: string): string | null {
  const text = normalizedText(value);
  const slashDate = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slashDate) {
    return `${slashDate[3]}-${slashDate[1]!.padStart(2, '0')}-${slashDate[2]!.padStart(2, '0')}`;
  }

  const isoDate = text.match(/\b(\d{4})-(\d{2})-(\d{2})(?!\d)/);
  if (isoDate) return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`;

  const namedDate = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:(\d{1,2}),\s*)?(\d{4})\b/i,
  );
  if (!namedDate) return null;
  return `${namedDate[3]}-${monthNumbers[namedDate[1]!.toLowerCase()]}-${(namedDate[2] ?? '1').padStart(2, '0')}`;
}

function isSupportedStatementMetadata(value: string): boolean {
  if (/\b(?:tax|1099|interest\s+income)\b/i.test(value)) return false;
  return /\bstatement\b/i.test(value) || marcusStatementDateFromText(value) !== null;
}

export function marcusDocumentRequest(href: string): MarcusApiRequest {
  const url = new URL(href, DOCUMENTS_URL);
  if (
    url.origin !== MARCUS_ORIGIN ||
    !DOCUMENT_PATH_PATTERN.test(url.pathname) ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Marcus document destination is invalid');
  }
  return { method: 'GET', url: url.toString() };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function apiPayloadRoots(payload: unknown): Record<string, unknown>[] {
  const values = Array.isArray(payload) ? payload : [payload];
  return values.map(objectValue).filter((value): value is Record<string, unknown> => value !== null);
}

function apiAccounts(payload: unknown): unknown[] | null {
  for (const root of apiPayloadRoots(payload)) {
    const data = objectValue(root.data);
    const savings = objectValue(data?.savings);
    if (Array.isArray(savings?.accounts)) return savings.accounts;
  }
  return null;
}

function apiDocuments(payload: unknown): unknown[] | null {
  for (const root of apiPayloadRoots(payload)) {
    const outerData = objectValue(root.data);
    const data = objectValue(outerData?.data);
    const list = objectValue(data?.savingsDocumentList);
    if (Array.isArray(list?.response)) return list.response;
  }
  return null;
}

function apiAccountIdentity(record: Record<string, unknown>): MarcusAccountIdentity | null {
  const last4 = stringValue(record.accountNumberLastFour);
  if (!last4 || !/^\d{4}$/.test(last4)) return null;
  const identityText = [
    record.accountName,
    record.formattedAccountName,
    record.type,
    record.productName,
    record.accountType,
  ].map(stringValue).filter((value): value is string => value !== null).join(' ');
  const kind = accountKindFromText(identityText);
  if (!kind) return null;
  return {
    kind,
    last4,
    sourceAccountKey: `marcus:${kind}:${last4}`,
    parserAccountName: kind === 'savings' ? `Online Savings - ${last4}` : null,
  };
}

function canonicalApiAccountText(identity: MarcusAccountIdentity): string {
  return identity.kind === 'savings'
    ? `Online Savings Account ending in ${identity.last4}`
    : `Certificate of Deposit ending in ${identity.last4}`;
}

function validApiDocumentLinks(value: unknown): MarcusApiRequest[] {
  if (!Array.isArray(value)) return [];
  const requests = new Map<string, MarcusApiRequest>();
  for (const candidate of value) {
    const link = stringValue(objectValue(candidate)?.link);
    if (!link) continue;
    try {
      const request = marcusDocumentRequest(link);
      requests.set(request.url, request);
    } catch {
      // The response may contain unrelated links. Only the live statement route is eligible.
    }
  }
  return [...requests.values()];
}

export function marcusMetadataFromApiPayloads(
  accountPayload: unknown,
  documentPayload: unknown,
): { accounts: MarcusAccountMetadata[]; documents: MarcusDocumentMetadata[] } {
  const accountRecords = apiAccounts(accountPayload);
  const documentRecords = apiDocuments(documentPayload);
  if (!accountRecords) throw new Error('Marcus account API response shape is invalid');
  if (!documentRecords) throw new Error('Marcus document API response shape is invalid');

  const accountsByRemoteKey = new Map<string, { identity: MarcusAccountIdentity; text: string }>();
  for (const value of accountRecords) {
    const record = objectValue(value);
    const remoteKey = stringValue(record?.accountId);
    const identity = record ? apiAccountIdentity(record) : null;
    if (!remoteKey || !identity) throw new Error('Marcus account API identity is unavailable');
    const text = canonicalApiAccountText(identity);
    const existing = accountsByRemoteKey.get(remoteKey);
    if (existing && existing.identity.sourceAccountKey !== identity.sourceAccountKey) {
      throw new Error('Marcus account API exposed a conflicting remote identity');
    }
    accountsByRemoteKey.set(remoteKey, { identity, text });
  }
  if (accountsByRemoteKey.size === 0) throw new Error('Marcus account API exposed no accounts');

  const documents: MarcusDocumentMetadata[] = [];
  for (const value of documentRecords) {
    const record = objectValue(value);
    const remoteKey = stringValue(record?.accountId);
    const account = remoteKey ? accountsByRemoteKey.get(remoteKey) : null;
    const createdDate = stringValue(record?.createdDate);
    const fileName = stringValue(record?.fileName);
    if (!remoteKey || !account || !createdDate || !fileName) {
      throw new Error('Marcus document API identity is unavailable');
    }
    const requests = validApiDocumentLinks(record?.links);
    if (requests.length !== 1) {
      throw new Error('Marcus document API did not expose one verified statement link');
    }
    documents.push({
      href: requests[0]!.url,
      accountText: account.text,
      documentText: `${fileName} ${createdDate}`,
      remoteKey,
    });
  }

  return {
    accounts: [...accountsByRemoteKey.entries()].map(([remoteKey, account]) => ({
      text: account.text,
      remoteKey,
    })),
    documents,
  };
}

export function buildMarcusRemoteCatalogFromApi(
  accountPayload: unknown,
  documentPayload: unknown,
): MarcusRemoteCatalog {
  const metadata = marcusMetadataFromApiPayloads(accountPayload, documentPayload);
  return buildMarcusRemoteCatalog(metadata.accounts, metadata.documents);
}

function addAccount(
  accounts: Map<string, { identity: MarcusAccountIdentity; remoteKeys: Set<string> }>,
  identity: MarcusAccountIdentity,
  remoteKey?: string | null,
): void {
  const existing = accounts.get(identity.sourceAccountKey);
  if (!existing) {
    accounts.set(identity.sourceAccountKey, {
      identity,
      remoteKeys: new Set(remoteKey ? [remoteKey] : []),
    });
    return;
  }
  if (remoteKey) existing.remoteKeys.add(remoteKey);
  if (existing.remoteKeys.size > 1) {
    throw new Error('Marcus exposed ambiguous accounts with the same routing identity');
  }
}

export function buildMarcusRemoteCatalog(
  accountMetadata: MarcusAccountMetadata[],
  documentMetadata: MarcusDocumentMetadata[],
): MarcusRemoteCatalog {
  const accounts = new Map<string, { identity: MarcusAccountIdentity; remoteKeys: Set<string> }>();
  for (const candidate of accountMetadata) {
    const identity = marcusAccountIdentityFromText(candidate.text);
    if (identity) addAccount(accounts, identity, candidate.remoteKey);
  }

  const documents = new Map<string, MarcusCatalogDocument>();
  let unsupportedArtifactCount = 0;
  for (const candidate of documentMetadata) {
    const identity = marcusAccountIdentityFromText(candidate.accountText);
    if (!identity) throw new Error('Marcus document account identity is unavailable');
    addAccount(accounts, identity, candidate.remoteKey);

    if (!isSupportedStatementMetadata(candidate.documentText) || identity.kind !== 'savings') {
      unsupportedArtifactCount += 1;
      continue;
    }
    const statementDate = marcusStatementDateFromText(candidate.documentText);
    if (!statementDate) throw new Error('Marcus statement date is unavailable');
    const request = marcusDocumentRequest(candidate.href);
    const logicalKey = `${identity.sourceAccountKey}:${statementDate}:statement-pdf`;
    const existing = documents.get(logicalKey);
    if (existing && existing.request.url !== request.url) {
      throw new Error('Marcus exposed multiple documents for one account statement period');
    }
    documents.set(logicalKey, {
      account: identity,
      artifactType: 'statement-pdf',
      statementDate,
      request,
    });
  }

  if (accounts.size === 0) throw new Error('Marcus did not expose any savings or deposit accounts');
  const availableByAccount = new Map<string, number>();
  for (const document of documents.values()) {
    availableByAccount.set(
      document.account.sourceAccountKey,
      (availableByAccount.get(document.account.sourceAccountKey) ?? 0) + 1,
    );
  }
  const remoteAccounts = [...accounts.values()].map(({ identity }) => ({
    ...identity,
    supportedArtifactTypes: identity.kind === 'savings' ? ['statement-pdf' as const] : [],
    availableArtifactCount: availableByAccount.get(identity.sourceAccountKey) ?? 0,
  })).sort((left, right) => left.sourceAccountKey.localeCompare(right.sourceAccountKey));

  return {
    accounts: remoteAccounts,
    documents: [...documents.values()].sort((left, right) =>
      left.statementDate.localeCompare(right.statementDate) ||
      left.account.sourceAccountKey.localeCompare(right.account.sourceAccountKey)),
    unsupportedArtifactCount,
  };
}

export function isMarcusAuthenticatedPath(pathname: string): boolean {
  return !LOGIN_PATH_PATTERN.test(pathname) && /^\/us\/en\/(?:accounts|documents|dashboard)(?:\/|$)/i.test(pathname);
}

export async function isMarcusAuthenticatedPage(page: Page): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(page.url());
  } catch {
    return false;
  }
  if (url.origin !== MARCUS_ORIGIN || !isMarcusAuthenticatedPath(url.pathname)) return false;
  return await page.locator(AUTHENTICATION_FIELD_SELECTOR).count() === 0;
}

export async function waitUntilMarcusAuthenticated(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction((loginPathSource: string) => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    const hasAuthenticationFields = Array.from(document.querySelectorAll(
      'input[type="password"], input[autocomplete="username"], input[autocomplete="current-password"]',
    )).some(visible);
    return location.origin === 'https://www.marcus.com' &&
      !new RegExp(loginPathSource, 'i').test(location.pathname) &&
      /^\/us\/en\/(?:accounts|documents|dashboard)(?:\/|$)/i.test(location.pathname) &&
      !hasAuthenticationFields;
  }, LOGIN_PATH_PATTERN.source, { timeout: timeoutMs });
}

async function openMarcusAuthenticatedRoute(
  page: Page,
  url: string,
  destination: 'accounts' | 'documents',
): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch {
    throw new Error(`Marcus ${destination} navigation failed`);
  }
  return isMarcusAuthenticatedPage(page);
}

type MarcusCatalogRequestLike = Pick<Request, 'method' | 'postData' | 'url'>;

function missingMarcusCatalogRequestError(
  accounts: Request | undefined,
  documents: Request | undefined,
): Error {
  const missing = [
    ...(!accounts ? ['account'] : []),
    ...(!documents ? ['document'] : []),
  ].join(' and ');
  return new Error(`Marcus ${missing} metadata API request did not load`);
}

export function isMarcusApiCatalogRequest(
  request: MarcusCatalogRequestLike,
  operation: MarcusApiCatalogOperation,
): boolean {
  let url: URL;
  try {
    url = new URL(request.url());
  } catch {
    return false;
  }
  const queryKeys = [...url.searchParams.keys()];
  if (
    request.method() !== 'POST' ||
    url.origin !== MARCUS_ORIGIN ||
    url.pathname !== MARCUS_COS_PATH ||
    queryKeys.length !== 1 ||
    queryKeys[0] !== MARCUS_COS_QUERY_KEY
  ) {
    return false;
  }
  const marker = operation === 'accounts'
    ? MARCUS_ACCOUNTS_REQUEST_MARKER
    : MARCUS_DOCUMENTS_REQUEST_MARKER;
  return request.postData()?.includes(marker) ?? false;
}

export async function fetchMarcusApiPayload(page: Page, request: Request): Promise<unknown> {
  let response: APIResponse;
  try {
    response = await page.context().request.fetch(request, {
      maxRedirects: 0,
      timeout: 30_000,
    });
  } catch {
    throw new Error('Marcus metadata API request failed');
  }
  try {
    if (!response.ok()) throw new Error('Marcus metadata API request was rejected');
    const contentType = response.headers()['content-type']?.toLowerCase() ?? '';
    if (!contentType.includes('json')) throw new Error('Marcus metadata API response was not JSON');
    try {
      return await response.json();
    } catch {
      throw new Error('Marcus metadata API response was invalid');
    }
  } finally {
    await disposeResponse(response);
  }
}

async function waitForMarcusCatalogRequests(
  page: Page,
): Promise<{ accounts: Request; documents: Request } | null> {
  let accounts: Request | undefined;
  let documents: Request | undefined;
  let resolveCaptured: (() => void) | undefined;
  const captured = new Promise<void>(resolve => { resolveCaptured = resolve; });
  const onRequest = (request: Request) => {
    if (!accounts && isMarcusApiCatalogRequest(request, 'accounts')) accounts = request;
    if (!documents && isMarcusApiCatalogRequest(request, 'documents')) documents = request;
    if (accounts && documents) resolveCaptured?.();
  };
  const context = page.context();
  context.on('request', onRequest);
  try {
    if (!await openMarcusAuthenticatedRoute(page, ACCOUNTS_URL, 'accounts')) return null;
    if (!await openMarcusAuthenticatedRoute(page, DOCUMENTS_URL, 'documents')) return null;
    if (!accounts || !documents) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          captured,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(missingMarcusCatalogRequestError(accounts, documents)),
              30_000,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    if (!accounts || !documents) throw missingMarcusCatalogRequestError(accounts, documents);
    return { accounts, documents };
  } finally {
    context.off('request', onRequest);
  }
}

export async function discoverMarcusRemoteCatalog(page: Page): Promise<MarcusRemoteCatalog | null> {
  const requests = await waitForMarcusCatalogRequests(page);
  if (!requests) return null;
  const accountPayload = await fetchMarcusApiPayload(page, requests.accounts);
  const documentPayload = requests.documents === requests.accounts
    ? accountPayload
    : await fetchMarcusApiPayload(page, requests.documents);
  return buildMarcusRemoteCatalogFromApi(accountPayload, documentPayload);
}

function documentIsInRange(document: MarcusCatalogDocument, from: string, through: string): boolean {
  const month = document.statementDate.slice(0, 7);
  return month >= from.slice(0, 7) && month <= through.slice(0, 7);
}

function accountIdentityKey(account: Pick<MarcusAccountIdentity, 'kind' | 'last4'>): string {
  return `${account.kind}:${account.last4}`;
}

export function mapMarcusRemoteAccounts(
  remoteAccounts: readonly MarcusRemoteAccount[],
  plannedAccounts: readonly MarcusSyncAccount[],
): MarcusMappedAccount[] {
  const remoteByIdentity = new Map<string, MarcusRemoteAccount>();
  for (const remote of remoteAccounts) {
    const identity = accountIdentityKey(remote);
    if (remoteByIdentity.has(identity)) {
      throw new Error('Marcus remote account identities are ambiguous');
    }
    remoteByIdentity.set(identity, remote);
  }

  const mapped: MarcusMappedAccount[] = [];
  for (const planned of plannedAccounts) {
    const remote = remoteByIdentity.get(accountIdentityKey(planned));
    if (remote) mapped.push({ remote, planned });
  }
  return mapped;
}

export function planMarcusCatalog(
  catalog: MarcusRemoteCatalog,
  plannedAccounts: readonly MarcusSyncAccount[],
  through: string,
): MarcusCatalogPlan {
  const mappedAccounts = mapMarcusRemoteAccounts(catalog.accounts, plannedAccounts);
  const planByIdentity = new Map(mappedAccounts.map(({ remote, planned }) => [
    accountIdentityKey(remote),
    planned,
  ]));
  const plannedIdentities = new Set(plannedAccounts.map(accountIdentityKey));
  const unmappedAccountCount = catalog.accounts.filter(account =>
    !plannedIdentities.has(accountIdentityKey(account))
  ).length;
  const unavailableAccountCount = plannedAccounts.length - mappedAccounts.length;
  const documents = catalog.documents.flatMap(document => {
    const planned = planByIdentity.get(accountIdentityKey(document.account));
    return planned && documentIsInRange(document, planned.startDate, through)
      ? [{ document, planned }]
      : [];
  });
  return {
    mappedAccounts,
    documents,
    unmappedAccountCount,
    unavailableAccountCount,
  };
}

function safeMarcusError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith('Marcus ')) return 'Marcus sync failed';
  return message
    .replace(/https?:\/\/\S+/g, '<redacted-url>')
    .replace(/\b\d{4,}\b/g, '<digits>');
}

export function validateMarcusPdfSignature(bytes: Uint8Array): void {
  if (bytes.byteLength < 32) throw new Error('Marcus statement PDF is empty or too small');
  const header = new TextDecoder('ascii').decode(bytes.slice(0, 5));
  const trailer = new TextDecoder('ascii').decode(bytes.slice(Math.max(0, bytes.byteLength - 2_048)));
  if (header !== '%PDF-' || !trailer.includes('%%EOF')) {
    throw new Error('Marcus statement PDF signature is invalid');
  }
}

async function disposeResponse(response: APIResponse): Promise<void> {
  await response.dispose().catch(() => {});
}

export async function fetchMarcusDocumentBytes(page: Page, request: MarcusApiRequest): Promise<Uint8Array> {
  let response: APIResponse;
  try {
    response = await page.context().request.fetch(request.url, {
      method: request.method,
      maxRedirects: 5,
      timeout: 30_000,
    });
  } catch {
    throw new Error('Marcus statement request failed');
  }

  try {
    if (!response.ok()) throw new Error(`Marcus statement request failed with status ${response.status()}`);
    const contentType = response.headers()['content-type']?.toLowerCase() ?? '';
    if (!contentType.includes('pdf') && !contentType.includes('octet-stream')) {
      throw new Error('Marcus statement response was not a PDF');
    }
    const bytes = new Uint8Array(await response.body());
    validateMarcusPdfSignature(bytes);
    return bytes;
  } finally {
    await disposeResponse(response);
  }
}

function parsedAccountNames(parsed: AppImportParseResult): string[] {
  return [...new Set([
    ...parsed.transactions.map(transaction => transaction?.account ?? null),
    ...parsed.balances.map(balance => balance.account ?? null),
  ].filter((value): value is string => Boolean(value)))];
}

export async function validateMarcusStatementArtifact(
  options: {
    outputDir: string;
    bytes: Uint8Array;
    accountId: number;
    expectedAccount: MarcusAccountIdentity;
    expectedStatementDate: string;
  },
  parser: MarcusParserLike = marcusStatementParser,
): Promise<MarcusDownloadedArtifact> {
  validateMarcusPdfSignature(options.bytes);
  const temporaryDir = await mkdtemp(join(resolve(options.outputDir), '.marcus-download-'));
  const temporaryPath = join(temporaryDir, 'statement.pdf');
  try {
    await writeFile(temporaryPath, options.bytes, { mode: 0o600 });
    let parsed: AppImportParseResult;
    try {
      parsed = await parser.parse({
        fileName: 'statement.pdf',
        headers: [],
        rows: [],
        text: '',
        filePath: temporaryPath,
        fileBytes: options.bytes,
      });
    } catch {
      throw new Error('Marcus statement parser validation failed');
    }

    const accountNames = parsedAccountNames(parsed);
    if (accountNames.length !== 1 || accountNames[0] !== options.expectedAccount.parserAccountName) {
      throw new Error('Marcus statement account identity does not match its remote account');
    }
    if (parsed.balances.length !== 1 || !DATE_PATTERN.test(parsed.balances[0]!.date)) {
      throw new Error('Marcus statement parser did not produce one dated balance');
    }
    const statementDate = parsed.balances[0]!.date;
    if (statementDate.slice(0, 7) !== options.expectedStatementDate.slice(0, 7)) {
      throw new Error('Marcus statement date does not match its remote document metadata');
    }
    const fileName = `marcus-online-savings-${options.expectedAccount.last4}-${statementDate}-statement.pdf`;
    if (!parser.matches({ fileName, headers: [], sample: '' })) {
      throw new Error('Marcus statement does not match the EasyMoney parser route');
    }
    const path = join(resolve(options.outputDir), fileName);
    try {
      await writeFile(path, options.bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('Marcus produced a duplicate account statement artifact');
      }
      throw new Error('Marcus statement artifact could not be saved');
    }
    return {
      fileName,
      path,
      artifactType: 'statement-pdf',
      accountId: options.accountId,
      account: options.expectedAccount,
      statementDate,
      parserId: parser.id,
      size: options.bytes.byteLength,
      transactionCount: parsed.transactions.length,
      balanceCount: parsed.balances.length,
    };
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function syncAuthenticatedMarcus(
  page: Page,
  config: MarcusSyncConfig,
  report: SyncReporter,
  parser: MarcusParserLike,
  catalog: MarcusRemoteCatalog,
): Promise<Extract<MarcusSyncResult, { status: 'complete' }>> {
  const plan = planMarcusCatalog(catalog, config.accounts, config.through);
  report({
    type: 'phase',
    message: 'Marcus discovery complete',
    data: {
      accountCount: catalog.accounts.length,
      mappedAccountCount: plan.mappedAccounts.length,
      unmappedAccountCount: plan.unmappedAccountCount,
      unavailableAccountCount: plan.unavailableAccountCount,
      supportedArtifactCount: catalog.documents.length,
      unsupportedArtifactCount: catalog.unsupportedArtifactCount,
    },
  });

  const artifacts: MarcusDownloadedArtifact[] = [];
  try {
    for (const [index, { document, planned }] of plan.documents.entries()) {
      const details = {
        artifactIndex: index + 1,
        artifactCount: plan.documents.length,
        artifactType: document.artifactType,
      };
      const bytes = await reportSyncStep(report, {
        step: 'download-artifact',
        message: 'Downloading Marcus statement',
        details,
      }, () => fetchMarcusDocumentBytes(page, document.request));
      const artifact = await reportSyncStep(report, {
        step: 'validate-artifact',
        message: 'Validating Marcus statement',
        details,
      }, () => validateMarcusStatementArtifact({
        outputDir: config.outputDir,
        bytes,
        accountId: planned.accountId,
        expectedAccount: document.account,
        expectedStatementDate: document.statementDate,
      }, parser));
      artifacts.push(artifact);
      report({
        type: 'artifact',
        message: 'Marcus statement is ready for review',
        data: { ...details, parserId: artifact.parserId },
      });
    }
  } catch (error) {
    await Promise.all(artifacts.map(artifact => rm(artifact.path, { force: true })));
    throw error;
  }

  return {
    status: 'complete',
    accounts: catalog.accounts,
    artifacts,
    unsupportedArtifactCount: catalog.unsupportedArtifactCount,
    unmappedAccountCount: plan.unmappedAccountCount,
    unavailableAccountCount: plan.unavailableAccountCount,
  };
}

export async function executeMarcusBrowser(
  page: Page,
  config: MarcusSyncConfig,
  report: SyncReporter,
  parser: MarcusParserLike,
): Promise<InstitutionBrowserProgramResult<MarcusBrowserResult>> {
  try {
    if (!await isMarcusAuthenticatedPage(page)) {
      return {
        status: 'login-required',
        action: 'Sign in to Marcus and complete MFA. EasyMoney will continue automatically.',
      };
    }
    const catalog = await reportSyncStep(report, {
      step: 'discover-metadata',
      message: 'Discovering Marcus accounts and documents',
    }, () => discoverMarcusRemoteCatalog(page));
    if (!catalog) {
      return {
        status: 'login-required',
        action: 'Sign in to Marcus and complete MFA. EasyMoney will continue automatically.',
      };
    }
    return {
      status: 'complete',
      result: await syncAuthenticatedMarcus(page, config, report, parser, catalog),
    };
  } catch (error) {
    return { status: 'error', message: safeMarcusError(error) };
  }
}

function browserProgram(): string {
  return `async (page, _reportProgress, bindings) => JSON.stringify(
    await bindings.execute(page)
  )`;
}

export async function runMarcusSync(
  config: MarcusSyncConfig,
  report: SyncReporter = () => {},
  dependencies: MarcusSyncDependencies = defaultDependencies,
): Promise<MarcusSyncResult> {
  if (!DATE_PATTERN.test(config.through)) {
    throw new Error('Marcus through date must use YYYY-MM-DD');
  }
  validateSyncAccounts(config.accounts, config.through);
  const outputDir = resolve(config.outputDir);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const session = config.session ?? MARCUS_PROFILE_NAME;
  const allowInteractiveAuthentication = config.allowInteractiveAuthentication ?? false;
  const hasSavedAuthentication = await reportSyncStep(report, {
    step: 'check-authentication',
    message: 'Checking Marcus cached authentication',
  }, () => dependencies.hasSavedAuthentication(session, config.profilePath));

  if (!hasSavedAuthentication && !allowInteractiveAuthentication) {
    report({
      type: 'warning',
      message: 'Marcus authentication is required',
      data: { reason: 'missing' },
    });
    return { status: 'authentication-required', reason: 'missing', accounts: [], artifacts: [] };
  }

  const result = await reportSyncStep(report, {
    step: 'browser-session',
    message: hasSavedAuthentication
      ? 'Opening Marcus cached session'
      : 'Opening Marcus authentication session',
    details: { cachedAuthentication: hasSavedAuthentication },
  }, () => dependencies.runBrowserProgram<MarcusBrowserResult>(
    {
      name: session,
      startUrl: LOGIN_URL,
      ...(config.profilePath ? { profilePath: config.profilePath } : {}),
      ...(!allowInteractiveAuthentication ? { contextOptions: { headless: true } } : {}),
    },
    browserProgram(),
    {
      completionDescription: 'Marcus downloads are complete.',
      isAuthenticated: isMarcusAuthenticatedPage,
      waitUntilAuthenticated: waitUntilMarcusAuthenticated,
      onProgress: message => report({
        type: 'phase',
        message,
        data: { step: 'browser-session-wait' },
      }),
      programBindings: {
        execute: (page: Page) => executeMarcusBrowser(
          page,
          { ...config, outputDir },
          report,
          dependencies.parser,
        ),
      },
    },
  ));

  if (result.status === 'login-required') {
    report({
      type: 'warning',
      message: 'Marcus cached authentication has expired',
      data: { reason: 'expired' },
    });
    return { status: 'authentication-required', reason: 'expired', accounts: [], artifacts: [] };
  }
  if (result.status !== 'complete') throw new Error(result.message ?? 'Marcus sync failed');
  report({
    type: 'complete',
    message: 'Marcus artifacts are ready for review',
    data: {
      accountCount: result.result.accounts.length,
      artifactCount: result.result.artifacts.length,
      unsupportedArtifactCount: result.result.unsupportedArtifactCount,
      unmappedAccountCount: result.result.unmappedAccountCount,
      unavailableAccountCount: result.result.unavailableAccountCount,
    },
  });
  return result.result;
}
