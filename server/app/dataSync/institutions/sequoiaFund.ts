import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import type { Page } from 'playwright';

import { parseCsvRows } from '../../importParsers/csvRows.ts';
import { sequoiaFundActivityParser } from '../../importParsers/sequoiaFundActivity.ts';
import {
  sequoiaFundSourceAccountName,
} from '../../importParsers/sequoiaFundIdentity.ts';
import { sequoiaFundStatementParser } from '../../importParsers/sequoiaFundStatement.ts';
import {
  assertAuthenticatedHttpResponse,
  authenticatedHttpContentType,
  runAuthenticatedHttpRequest,
  type AuthenticatedHttpResponse,
} from '../authenticatedHttp.ts';
import { runInstitutionBrowserProgram } from '../browserSession.ts';
import { parseSequoiaFundStatementHtml } from './sequoiaFundHtml.ts';
import {
  parseSequoiaFundHistoryResponse,
  parseSequoiaFundPortfolio,
  sequoiaFundActivityExportFields,
  sequoiaFundActivityWindow,
  sequoiaFundHistoryFields,
} from './sequoiaFundProtocol.ts';

const sequoiaFundHost = 'secureaccountview.com';
const sequoiaFundClientPath = '/BFWeb/clients/sequoiafund';
const sequoiaFundLoginUrl = `https://${sequoiaFundHost}${sequoiaFundClientPath}/index`;
const sequoiaFundHistoryPath = `${sequoiaFundClientPath}/transactionhistory`;
const sequoiaFundHistoryJsonPath = `${sequoiaFundClientPath}/transactionhistoryJSON`;
const sequoiaFundActivityCsvPath = `${sequoiaFundClientPath}/transactionHistoryCSV`;
const sequoiaFundPortfolioPath = `${sequoiaFundClientPath}/portfolioJSON`;
const sequoiaFundStatementsPath = `${sequoiaFundClientPath}/viewStatements`;
const sequoiaFundStatementListPath = `${sequoiaFundClientPath}/statements/getStatementList`;

export type SequoiaFundProgressPhase =
  | 'authentication'
  | 'discovery'
  | 'activity-download'
  | 'statement-download'
  | 'validation'
  | 'complete';

export type SequoiaFundProgressEvent = {
  phase: SequoiaFundProgressPhase;
  state: 'start' | 'waiting' | 'complete';
  timestamp: string;
  message: string;
  elapsedMs?: number;
  data?: Record<string, number | string | boolean>;
};

export type SequoiaFundProgressReporter = (event: SequoiaFundProgressEvent) => void;

export type SequoiaFundSyncConfig = {
  outputDir: string;
  from: string;
  through: string;
  accountToken: string;
  session?: string;
  profilePath?: string;
};

export type SequoiaFundArtifactKind = 'activity' | 'statement';

export type SequoiaFundDownloadedArtifact = {
  fileName: string;
  path: string;
  kind: SequoiaFundArtifactKind;
  parserId: string;
  accountToken: string;
  accountName: string;
  status: 'downloaded' | 'existing';
  size: number;
  transactionCount: number;
  balanceCount: number;
  statementDate?: string;
};

export type SequoiaFundSyncResult = {
  artifacts: SequoiaFundDownloadedArtifact[];
  accountCount: number;
  activityCount: number;
  statementCount: number;
};

export function sequoiaFundBrowserSession(name: string, profilePath?: string) {
  return {
    name,
    startUrl: sequoiaFundLoginUrl,
    ...(profilePath ? { profilePath } : {}),
    persistAuthentication: false,
    contextOptions: { headless: false },
  } as const;
}

export type SequoiaFundCanonicalAccount = {
  accountToken: string;
  accountName: string;
};

export type SequoiaFundActivityForm = {
  action: string;
  method: 'GET' | 'POST';
  enctype: string;
  fields: Record<string, string>;
};

export type SequoiaFundArtifactByteClass =
  | 'empty'
  | 'pdf'
  | 'html'
  | 'json'
  | 'csv'
  | 'tabular-text'
  | 'utf16-or-binary'
  | 'text';

export type SequoiaFundApiRequest = {
  url: string;
  method: 'GET' | 'POST';
  form?: Record<string, string>;
  headers: Record<string, string>;
};

export type SequoiaFundStatementDocument = {
  documentId: string;
  statementType: string;
  statementDate: string;
  accountHints: string[];
};

export type SequoiaFundStatementList = {
  sessionId: string;
  documents: SequoiaFundStatementDocument[];
};

export type SequoiaFundStatementAccess = {
  csrfToken: string;
  referer: string;
};

export type SequoiaFundStatementJob = {
  account: SequoiaFundCanonicalAccount;
  document: SequoiaFundStatementDocument;
  request: SequoiaFundApiRequest;
  fileName: string;
};

export function safeSequoiaFundErrorMessage(
  error: unknown,
  sensitiveValues: Iterable<string> = [],
): string {
  let message = String(error instanceof Error ? error.message : error);
  const values = [...new Set(sensitiveValues)]
    .map(value => value.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const value of values) message = message.split(value).join('<redacted-selection>');
  return message
    .replace(/https?:\/\/\S+/g, '<redacted-url>')
    .replace(/\b[a-f0-9-]{16,}\b/gi, '<redacted-id>')
    .replace(/\b\d{4,}\b/g, '<digits>');
}

function isSequoiaFundOrigin(url: URL): boolean {
  return url.protocol === 'https:' &&
    (url.hostname === sequoiaFundHost || url.hostname.endsWith(`.${sequoiaFundHost}`));
}

function validatedSequoiaFundUrl(value: string, base?: string): URL {
  const url = new URL(value, base);
  if (!isSequoiaFundOrigin(url) || !url.pathname.startsWith(`${sequoiaFundClientPath}/`)) {
    throw new Error('Sequoia Fund API destination is outside the authenticated client origin');
  }
  return url;
}

function validateDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
}

function normalizeStatementDate(value: string): string | null {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!us) return null;
  const year = us[3].length === 2 ? `20${us[3]}` : us[3];
  return `${year}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
}

export function sequoiaFundCanonicalAccount(accountToken: string): SequoiaFundCanonicalAccount {
  if (!/^(?:last4-\d{4}|key-[a-f0-9]{12})$/.test(accountToken)) {
    throw new Error('Sequoia Fund canonical account token is invalid');
  }
  const accountName = sequoiaFundSourceAccountName(
    `sequoia-fund-account-${accountToken}-activity-2000-01-01-to-2000-01-01.csv`,
  );
  return { accountToken, accountName };
}

export function sequoiaFundActivityRequest(
  form: SequoiaFundActivityForm,
  referer: string,
): SequoiaFundApiRequest {
  const refererUrl = validatedSequoiaFundUrl(referer);
  let action: URL;
  try {
    action = validatedSequoiaFundUrl(form.action, refererUrl.toString());
  } catch {
    throw new Error('Sequoia Fund activity form is not same-origin');
  }
  if (action.origin !== refererUrl.origin) {
    throw new Error('Sequoia Fund activity form is not same-origin');
  }
  const fields = { ...form.fields };
  const headers = { Referer: refererUrl.toString() };
  if (form.method === 'GET') {
    action.search = new URLSearchParams(fields).toString();
    return { url: action.toString(), method: 'GET', headers };
  }
  if (form.enctype.toLowerCase() === 'application/x-www-form-urlencoded') {
    return { url: action.toString(), method: 'POST', form: fields, headers };
  }
  throw new Error('Sequoia Fund activity form encoding is unsupported');
}

function stringsFromAccountFields(value: Record<string, unknown>): string[] {
  return Object.entries(value)
    .filter(([key, candidate]) => /account|fund/i.test(key) && typeof candidate === 'string')
    .map(([, candidate]) => String(candidate));
}

export function parseSequoiaFundStatementList(value: unknown): SequoiaFundStatementList {
  if (!value || typeof value !== 'object') throw new Error('Sequoia Fund statement list was not an object');
  const root = value as { success?: unknown; data?: unknown };
  if (root.success === false || !root.data || typeof root.data !== 'object') {
    throw new Error('Sequoia Fund statement list reported failure');
  }
  const data = root.data as { sessionId?: unknown; statements?: unknown };
  if (typeof data.sessionId !== 'string' || !data.sessionId || !Array.isArray(data.statements)) {
    throw new Error('Sequoia Fund statement list metadata is incomplete');
  }

  const documents = new Map<string, SequoiaFundStatementDocument>();
  for (const candidate of data.statements) {
    if (!candidate || typeof candidate !== 'object') continue;
    const statement = candidate as Record<string, unknown>;
    const documentId = typeof statement.documentId === 'string' ? statement.documentId : '';
    const statementDate = normalizeStatementDate(
      typeof statement.statementDate === 'string' ? statement.statementDate : '',
    );
    if (!documentId || !statementDate) continue;
    documents.set(documentId, {
      documentId,
      statementType: 'pdf',
      statementDate,
      accountHints: stringsFromAccountFields(statement),
    });
  }
  return { sessionId: data.sessionId, documents: [...documents.values()] };
}

export function sequoiaFundStatementListRequest(
  access: SequoiaFundStatementAccess,
): SequoiaFundApiRequest {
  const base = validatedSequoiaFundUrl(access.referer);
  if (!access.csrfToken.trim()) throw new Error('Sequoia Fund statement CSRF state is unavailable');
  const url = new URL(sequoiaFundStatementListPath, base.origin);
  url.searchParams.set('csrf_token', access.csrfToken);
  return {
    url: url.toString(),
    method: 'POST',
    form: { queryType: 'all' },
    headers: { Referer: base.toString() },
  };
}

export function sequoiaFundStatementDownloadRequest(
  document: SequoiaFundStatementDocument,
  list: SequoiaFundStatementList,
  access: SequoiaFundStatementAccess,
): SequoiaFundApiRequest {
  const base = validatedSequoiaFundUrl(access.referer);
  if (!list.sessionId.trim() || !access.csrfToken.trim()) {
    throw new Error('Sequoia Fund statement download metadata is unavailable');
  }
  const path = [
    sequoiaFundClientPath,
    'statements',
    encodeURIComponent(document.documentId),
    document.statementType,
    encodeURIComponent(list.sessionId),
  ].join('/');
  const url = validatedSequoiaFundUrl(path, base.origin);
  url.searchParams.set('csrf_token', access.csrfToken);
  return {
    url: url.toString(),
    method: 'GET',
    headers: { Referer: access.referer },
  };
}

export function sequoiaFundStatementJobs(
  account: SequoiaFundCanonicalAccount,
  list: SequoiaFundStatementList,
  access: SequoiaFundStatementAccess,
  from: string,
  through: string,
): SequoiaFundStatementJob[] {
  const jobs: SequoiaFundStatementJob[] = [];
  for (const document of list.documents) {
    if (document.statementDate < from || document.statementDate > through) continue;
    const documentToken = createHash('sha256')
      .update(`${document.documentId}\0${document.statementType}`)
      .digest('hex')
      .slice(0, 10);
    jobs.push({
      account,
      document,
      request: sequoiaFundStatementDownloadRequest(document, list, access),
      fileName: `sequoia-fund-account-${account.accountToken}-${document.statementDate}-statement-${documentToken}.pdf`,
    });
  }
  return jobs.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function responseContentType(response: AuthenticatedHttpResponse): string {
  return authenticatedHttpContentType(response);
}

export function classifySequoiaFundArtifactBytes(bytes: Uint8Array): SequoiaFundArtifactByteClass {
  if (bytes.length === 0) return 'empty';
  const sample = Buffer.from(bytes).subarray(0, Math.min(bytes.length, 4096));
  if (sample.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf';
  if (sample.includes(0)) return 'utf16-or-binary';
  const text = sample.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  const lower = text.toLowerCase();
  if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b|<\?xml\b)/.test(lower)) return 'html';
  if (/^[{[]/.test(text)) return 'json';
  if (/[\r\n]/.test(text) && text.includes(',')) return 'csv';
  if (/[\r\n]/.test(text) && text.includes('\t')) return 'tabular-text';
  return 'text';
}

function assertCsvResponse(response: AuthenticatedHttpResponse, body: Buffer): void {
  if (response.status < 200 || response.status >= 300 ||
    body.length < 32 || classifySequoiaFundArtifactBytes(body) !== 'csv' ||
    !/(?:csv|text|excel|octet-stream)/.test(responseContentType(response))) {
    throw new Error('Sequoia Fund activity response failed CSV validation');
  }
}

function assertPdfResponse(response: AuthenticatedHttpResponse, body: Buffer): void {
  if (response.status < 200 || response.status >= 300 ||
    body.length < 1_000 || body.subarray(0, 5).toString('ascii') !== '%PDF-' ||
    !/(?:pdf|octet-stream)/.test(responseContentType(response))) {
    throw new Error('Sequoia Fund statement response failed PDF validation');
  }
}

async function executeRequest(page: Page, request: SequoiaFundApiRequest): Promise<AuthenticatedHttpResponse> {
  return runAuthenticatedHttpRequest(page, {
    url: request.url,
    method: request.method,
    headers: request.headers,
    ...(request.form ? { form: request.form } : {}),
  });
}

function parserInput(path: string, fileName: string, bytes: Buffer) {
  const text = fileName.endsWith('.csv') ? bytes.toString('utf8') : '';
  const rows = text ? parseCsvRows(text) : [];
  return {
    fileName,
    headers: rows[0] ?? [],
    rows: [],
    text,
    filePath: path,
    fileBytes: new Uint8Array(bytes),
  };
}

export async function validateSequoiaFundArtifact(
  path: string,
  kind: SequoiaFundArtifactKind,
  account: SequoiaFundCanonicalAccount,
): Promise<Omit<SequoiaFundDownloadedArtifact, 'status' | 'statementDate'>> {
  const fileName = basename(path);
  const expectedExtension = kind === 'activity' ? '.csv' : '.pdf';
  if (!fileName.endsWith(expectedExtension)) throw new Error('Sequoia Fund artifact extension is invalid');
  const info = await stat(path);
  const minimum = kind === 'activity' ? 32 : 1_000;
  if (!info.isFile() || info.size < minimum) throw new Error('Sequoia Fund artifact is empty or too small');
  const bytes = await readFile(path);
  if (kind === 'activity') {
    if (classifySequoiaFundArtifactBytes(bytes) !== 'csv') {
      throw new Error('Sequoia Fund activity file signature is invalid');
    }
  } else if (classifySequoiaFundArtifactBytes(bytes) !== 'pdf') {
    throw new Error('Sequoia Fund statement file signature is invalid');
  }

  const parser = kind === 'activity' ? sequoiaFundActivityParser : sequoiaFundStatementParser;
  const input = parserInput(path, fileName, bytes);
  if (!parser.matches({ fileName, headers: input.headers, sample: input.text.slice(0, 4096) })) {
    throw new Error(`EasyMoney did not match the Sequoia Fund ${kind} parser`);
  }
  const parsed = await parser.parse(input);
  const transactions = parsed.transactions.filter((transaction): transaction is NonNullable<typeof transaction> =>
    transaction !== null);
  if (kind === 'statement' && parsed.balances.length === 0) {
    throw new Error('EasyMoney Sequoia Fund statement parser produced no balance');
  }
  const claimedAccounts = new Set([
    ...transactions.map(transaction => transaction.account),
    ...parsed.balances.map(balance => balance.account),
  ].filter((value): value is string => Boolean(value)));
  if (claimedAccounts.size > 0 &&
    (claimedAccounts.size !== 1 || !claimedAccounts.has(account.accountName))) {
    throw new Error('EasyMoney Sequoia Fund parser produced an ambiguous account identity');
  }
  return {
    fileName,
    path,
    kind,
    parserId: parser.id,
    accountToken: account.accountToken,
    accountName: account.accountName,
    size: info.size,
    transactionCount: transactions.length,
    balanceCount: parsed.balances.length,
  };
}

type Progress = ReturnType<typeof createProgress>;

function createProgress(onProgress: SequoiaFundProgressReporter) {
  const started = new Map<string, number>();
  return (
    key: string,
    phase: SequoiaFundProgressPhase,
    state: SequoiaFundProgressEvent['state'],
    message: string,
    data?: Record<string, number | string | boolean>,
  ) => {
    const now = performance.now();
    if (state === 'start') started.set(key, now);
    const began = started.get(key);
    onProgress({
      phase,
      state,
      timestamp: new Date().toISOString(),
      message,
      ...(state === 'complete' && began !== undefined ? { elapsedMs: Math.round(now - began) } : {}),
      ...(data ? { data } : {}),
    });
  };
}

type SequoiaFundActivityExportState = {
  exportForm: SequoiaFundActivityForm;
  referer: string;
  transactionCount: number;
};

function isSequoiaFundLoginResponseUrl(url: URL): boolean {
  if (!isSequoiaFundOrigin(url)) return true;
  const path = url.pathname.toLowerCase();
  return path === `${sequoiaFundClientPath}/index`.toLowerCase() ||
    /\/(?:login|authenticate|authentication|challenge|mfa)(?:\/|$)/.test(path);
}

function acceptedHttpBody(
  response: AuthenticatedHttpResponse,
  contentTypes: readonly (string | RegExp)[],
  minimumBytes = 1,
): Buffer {
  return assertAuthenticatedHttpResponse(response, {
    isLoginUrl: isSequoiaFundLoginResponseUrl,
    status: status => status >= 200 && status < 300,
    contentTypes,
    body: { minimumBytes },
  });
}

async function initializeSequoiaFundHistory(page: Page): Promise<string> {
  const current = validatedSequoiaFundUrl(page.url());
  const historyUrl = new URL(sequoiaFundHistoryPath, current.origin).toString();
  const response = await executeRequest(page, {
    url: historyUrl,
    method: 'GET',
    headers: { Referer: current.toString() },
  });
  acceptedHttpBody(response, ['text/html', 'application/xhtml+xml'], 64);
  return response.finalUrl;
}

async function fetchSequoiaFundPortfolio(page: Page, referer: string) {
  const current = validatedSequoiaFundUrl(referer);
  const response = await executeRequest(page, {
    url: new URL(sequoiaFundPortfolioPath, current.origin).toString(),
    method: 'GET',
    headers: { Referer: current.toString() },
  });
  const body = acceptedHttpBody(response, ['application/json', 'text/json', 'text/plain']);
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new Error('Sequoia Fund portfolio response was not valid JSON');
  }
  return parseSequoiaFundPortfolio(value);
}

async function discoverActivityExportState(
  page: Page,
  groupKey: string,
  referer: string,
  from: string,
  through: string,
  sensitiveValues: Set<string>,
): Promise<SequoiaFundActivityExportState> {
  sensitiveValues.add(groupKey);
  const window = sequoiaFundActivityWindow(from, through);
  const observedHistory = sequoiaFundHistoryFields(groupKey, window);
  for (const value of Object.values(observedHistory)) {
    if (value) sensitiveValues.add(value);
  }
  const current = validatedSequoiaFundUrl(referer);
  const historyResponse = await executeRequest(page, {
    url: new URL(sequoiaFundHistoryJsonPath, current.origin).toString(),
    method: 'POST',
    form: observedHistory,
    headers: { Referer: current.toString() },
  });
  const historyBody = acceptedHttpBody(
    historyResponse,
    ['application/json', 'text/json', 'text/plain'],
  );
  let historyValue: unknown;
  try {
    historyValue = JSON.parse(historyBody.toString('utf8')) as unknown;
  } catch {
    throw new Error('Sequoia Fund history response was not valid JSON');
  }
  const transactionCount = parseSequoiaFundHistoryResponse(historyValue);
  const exportForm: SequoiaFundActivityForm = {
    action: new URL(sequoiaFundActivityCsvPath, current.origin).toString(),
    method: 'POST',
    enctype: 'application/x-www-form-urlencoded',
    fields: sequoiaFundActivityExportFields(observedHistory),
  };
  return {
    exportForm,
    referer,
    transactionCount,
  };
}

async function fetchStatementList(
  page: Page,
  access: SequoiaFundStatementAccess,
): Promise<SequoiaFundStatementList> {
  const request = sequoiaFundStatementListRequest(access);
  const response = await executeRequest(page, request);
  const responseBody = acceptedHttpBody(
    response,
    ['application/json', 'text/json', 'text/plain', 'text/html'],
  );
  let body: unknown;
  try {
    body = JSON.parse(responseBody.toString('utf8')) as unknown;
  } catch {
    throw new Error('Sequoia Fund statement list request failed');
  }
  return parseSequoiaFundStatementList(body);
}

async function discoverStatementAccess(
  page: Page,
  baseUrl: string,
): Promise<SequoiaFundStatementAccess> {
  const current = validatedSequoiaFundUrl(baseUrl);
  const statementsUrl = new URL(sequoiaFundStatementsPath, current.origin).toString();
  const response = await executeRequest(page, {
    url: statementsUrl,
    method: 'GET',
    headers: { Referer: current.toString() },
  });
  const body = acceptedHttpBody(response, ['text/html', 'application/xhtml+xml'], 64);
  const parsed = parseSequoiaFundStatementHtml(body.toString('utf8'));
  if (!parsed.csrfToken) throw new Error('Sequoia Fund statement CSRF state is unavailable');
  return { csrfToken: parsed.csrfToken, referer: response.finalUrl };
}

async function existingArtifact(
  path: string,
  kind: SequoiaFundArtifactKind,
  account: SequoiaFundCanonicalAccount,
): Promise<SequoiaFundDownloadedArtifact | null> {
  try {
    return { ...await validateSequoiaFundArtifact(path, kind, account), status: 'existing' };
  } catch {
    return null;
  }
}

async function downloadActivityArtifact(options: {
  page: Page;
  outputDir: string;
  fileName: string;
  account: SequoiaFundCanonicalAccount;
  state: SequoiaFundActivityExportState;
  progress: Progress;
  key: string;
  data: Record<string, number | string | boolean>;
}): Promise<SequoiaFundDownloadedArtifact> {
  const path = resolve(options.outputDir, options.fileName);
  const existing = await existingArtifact(path, 'activity', options.account);
  if (existing) return existing;

  options.progress(options.key, 'activity-download', 'start', 'Downloading Sequoia Fund activity', options.data);
  try {
    const response = await executeRequest(
      options.page,
      sequoiaFundActivityRequest(options.state.exportForm, options.state.referer),
    );
    const bytes = response.body;
    assertCsvResponse(response, bytes);
    await writeFile(path, bytes);
    options.progress(options.key, 'activity-download', 'complete', 'Downloaded Sequoia Fund activity', {
      ...options.data,
      byteClass: classifySequoiaFundArtifactBytes(bytes),
      responseStatus: response.status,
      responseContentType: responseContentType(response).split(';')[0]?.trim() || 'unknown',
      responseBytes: bytes.length,
    });

    const validationKey = `${options.key}:validation`;
    options.progress(validationKey, 'validation', 'start', 'Validating Sequoia Fund activity', options.data);
    const validated = await validateSequoiaFundArtifact(path, 'activity', options.account);
    options.progress(validationKey, 'validation', 'complete', 'Validated Sequoia Fund activity', {
      ...options.data,
      transactionCount: validated.transactionCount,
      balanceCount: validated.balanceCount,
    });
    return { ...validated, status: 'downloaded' };
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

async function downloadArtifact(options: {
  page: Page;
  outputDir: string;
  fileName: string;
  kind: SequoiaFundArtifactKind;
  account: SequoiaFundCanonicalAccount;
  request: SequoiaFundApiRequest;
  progress: Progress;
  key: string;
  phase: 'activity-download' | 'statement-download';
  data: Record<string, number | string | boolean>;
  statementDate?: string;
}): Promise<SequoiaFundDownloadedArtifact> {
  const path = resolve(options.outputDir, options.fileName);
  const existing = await existingArtifact(path, options.kind, options.account);
  if (existing) return { ...existing, ...(options.statementDate ? { statementDate: options.statementDate } : {}) };

  options.progress(options.key, options.phase, 'start', `Downloading Sequoia Fund ${options.kind}`, options.data);
  const response = await executeRequest(options.page, options.request);
  const body = response.body;
  if (options.kind === 'activity') assertCsvResponse(response, body);
  else assertPdfResponse(response, body);
  await writeFile(path, body);
  options.progress(options.key, options.phase, 'complete', `Downloaded Sequoia Fund ${options.kind}`, options.data);

  const validationKey = `${options.key}:validation`;
  options.progress(validationKey, 'validation', 'start', `Validating Sequoia Fund ${options.kind}`, options.data);
  try {
    const validated = await validateSequoiaFundArtifact(path, options.kind, options.account);
    options.progress(validationKey, 'validation', 'complete', `Validated Sequoia Fund ${options.kind}`, {
      ...options.data,
      transactionCount: validated.transactionCount,
      balanceCount: validated.balanceCount,
    });
    return {
      ...validated,
      status: 'downloaded',
      ...(options.statementDate ? { statementDate: options.statementDate } : {}),
    };
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

async function syncAuthenticated(
  page: Page,
  config: Required<Pick<SequoiaFundSyncConfig, 'outputDir' | 'from' | 'through' | 'accountToken'>>,
  progress: Progress,
): Promise<SequoiaFundSyncResult> {
  const sensitiveValues = new Set<string>();
  try {
    return await syncAuthenticatedWithSensitiveValues(page, config, progress, sensitiveValues);
  } catch (error) {
    throw new Error(safeSequoiaFundErrorMessage(error, sensitiveValues));
  }
}

async function syncAuthenticatedWithSensitiveValues(
  page: Page,
  config: Required<Pick<SequoiaFundSyncConfig, 'outputDir' | 'from' | 'through' | 'accountToken'>>,
  progress: Progress,
  sensitiveValues: Set<string>,
): Promise<SequoiaFundSyncResult> {
  const discoveryKey = 'discovery';
  progress(discoveryKey, 'discovery', 'start', 'Discovering Sequoia Fund account and artifacts');
  const historyReferer = await initializeSequoiaFundHistory(page);
  const portfolio = await fetchSequoiaFundPortfolio(page, historyReferer);
  sensitiveValues.add(portfolio.groupKey);
  for (const registration of portfolio.registration) sensitiveValues.add(registration);
  for (const portfolioAccount of portfolio.accountList) {
    sensitiveValues.add(portfolioAccount.fundAccountNumber);
    sensitiveValues.add(portfolioAccount.fundAcctNumbMasked);
    sensitiveValues.add(portfolioAccount.fundSecIssueId);
    sensitiveValues.add(portfolioAccount.fund.fundIdNumStripLeadingZeros);
    sensitiveValues.add(portfolioAccount.fund.fundName);
  }
  const account = sequoiaFundCanonicalAccount(config.accountToken);
  const artifacts: SequoiaFundDownloadedArtifact[] = [];
  const activityState = await discoverActivityExportState(
    page,
    portfolio.groupKey,
    historyReferer,
    config.from,
    config.through,
    sensitiveValues,
  );
  const activityFileName = `sequoia-fund-account-${account.accountToken}-activity-${config.from}-to-${config.through}.csv`;
  artifacts.push(await downloadActivityArtifact({
    page,
    outputDir: config.outputDir,
    fileName: activityFileName,
    account,
    state: activityState,
    progress,
    key: 'activity:0',
    data: { transactionCount: activityState.transactionCount },
  }));

  const statementAccess = await discoverStatementAccess(page, historyReferer);
  const statementList = await fetchStatementList(page, statementAccess);
  const statementJobs = sequoiaFundStatementJobs(
    account,
    statementList,
    statementAccess,
    config.from,
    config.through,
  );
  progress(discoveryKey, 'discovery', 'complete', 'Discovered Sequoia Fund account and artifacts', {
    accountCount: 1,
    activityCount: 1,
    statementCount: statementJobs.length,
  });

  for (let index = 0; index < statementJobs.length; index += 1) {
    const job = statementJobs[index]!;
    artifacts.push(await downloadArtifact({
      page,
      outputDir: config.outputDir,
      fileName: job.fileName,
      kind: 'statement',
      account: job.account,
      request: job.request,
      progress,
      key: `statement:${index}`,
      phase: 'statement-download',
      data: { artifactIndex: index + 1, artifactCount: statementJobs.length },
      statementDate: job.document.statementDate,
    }));
  }

  return {
    artifacts,
    accountCount: 1,
    activityCount: 1,
    statementCount: statementJobs.length,
  };
}

export async function isSequoiaFundAuthenticatedPage(page: Page): Promise<boolean> {
  try {
    const current = validatedSequoiaFundUrl(page.url());
    const response = await executeRequest(page, {
      url: new URL(sequoiaFundPortfolioPath, current.origin).toString(),
      method: 'GET',
      headers: { Referer: current.toString() },
    });
    const body = acceptedHttpBody(response, ['application/json', 'text/json', 'text/plain']);
    parseSequoiaFundPortfolio(JSON.parse(body.toString('utf8')) as unknown);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntilSequoiaFundAuthenticated(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isSequoiaFundAuthenticatedPage(page)) return;
    await Bun.sleep(Math.min(1_000, Math.max(1, deadline - Date.now())));
  }
  throw new Error('Timed out waiting for Sequoia Fund authentication');
}

function browserProgram(): string {
  return `async (page, _reportProgress, bindings) => {
    try {
      if (!await bindings.isAuthenticated(page)) {
        bindings.authenticationRequired();
        return JSON.stringify({
          status: 'login-required',
          action: 'Sign in to Sequoia Fund and complete MFA. EasyMoney will continue automatically.',
        });
      }
      const result = await bindings.syncAuthenticated(page);
      return JSON.stringify({ status: 'complete', ...result });
    } catch (error) {
      return JSON.stringify({ status: 'error', message: bindings.safeErrorMessage(error) });
    }
  }`;
}

export async function runSequoiaFundSync(
  config: SequoiaFundSyncConfig,
  onProgress: SequoiaFundProgressReporter = () => {},
): Promise<SequoiaFundSyncResult> {
  validateDate(config.from, 'Sequoia Fund start date');
  validateDate(config.through, 'Sequoia Fund through date');
  sequoiaFundCanonicalAccount(config.accountToken);
  if (config.from > config.through) throw new Error('Sequoia Fund date range is invalid');
  const outputDir = resolve(config.outputDir);
  await mkdir(outputDir, { recursive: true });
  const session = config.session ?? 'sequoia-fund-catchup';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(session)) {
    throw new Error('Sequoia Fund session must be a PII-free kebab-case label');
  }

  const progress = createProgress(onProgress);
  const authenticationKey = 'authentication';
  progress(authenticationKey, 'authentication', 'start', 'Checking Sequoia Fund authentication', {
    cachedAuthentication: false,
  });
  let authenticationWaiting = false;
  const startedAt = performance.now();
  const result = await runInstitutionBrowserProgram<SequoiaFundSyncResult>(
    sequoiaFundBrowserSession(session, config.profilePath),
    browserProgram(),
    {
      completionDescription: 'Sequoia Fund downloads are complete.',
      isAuthenticated: isSequoiaFundAuthenticatedPage,
      waitUntilAuthenticated: waitUntilSequoiaFundAuthenticated,
      onProgress: message => {
        if (/waiting|authentication required|needs attention/i.test(message) && !authenticationWaiting) {
          authenticationWaiting = true;
          progress(authenticationKey, 'authentication', 'waiting', 'Waiting for Sequoia Fund authentication');
        }
      },
      programBindings: {
        authenticationRequired: () => {
          if (authenticationWaiting) return;
          authenticationWaiting = true;
          progress(authenticationKey, 'authentication', 'waiting', 'Waiting for Sequoia Fund authentication');
        },
        isAuthenticated: isSequoiaFundAuthenticatedPage,
        safeErrorMessage: safeSequoiaFundErrorMessage,
        syncAuthenticated: (page: Page) => syncAuthenticated(page, {
          outputDir,
          from: config.from,
          through: config.through,
          accountToken: config.accountToken,
        }, progress),
      },
    },
  );
  if (result.status === 'login-required') {
    throw new Error(result.action ?? 'Sequoia Fund authentication is required');
  }
  if (result.status !== 'complete') {
    throw new Error(result.message ?? 'Sequoia Fund sync did not complete');
  }
  progress(authenticationKey, 'authentication', 'complete', 'Sequoia Fund authentication is ready');
  progress('complete', 'complete', 'complete', 'Sequoia Fund downloads are ready for review', {
    artifactCount: result.artifacts.length,
    elapsedMs: Math.round(performance.now() - startedAt),
  });
  return {
    artifacts: result.artifacts,
    accountCount: result.accountCount,
    activityCount: result.activityCount,
    statementCount: result.statementCount,
  };
}
