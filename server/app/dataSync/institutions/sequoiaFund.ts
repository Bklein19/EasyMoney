import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import type { Download, Page, Request } from 'playwright';

import { parseCsvRows } from '../../importParsers/csvRows.ts';
import { sequoiaFundActivityParser } from '../../importParsers/sequoiaFundActivity.ts';
import {
  sequoiaFundSourceAccountName,
} from '../../importParsers/sequoiaFundIdentity.ts';
import { sequoiaFundStatementParser } from '../../importParsers/sequoiaFundStatement.ts';
import {
  browserNativeResponseBody,
  browserNativeResponseOk,
  runBrowserNativeRequest,
  type BrowserNativeResponse,
} from '../browserRequest.ts';
import { runInstitutionBrowserProgram } from '../browserSession.ts';

const sequoiaFundHost = 'secureaccountview.com';
const sequoiaFundClientPath = '/BFWeb/clients/sequoiafund';
const sequoiaFundLoginUrl = `https://${sequoiaFundHost}${sequoiaFundClientPath}/index`;
const sequoiaFundHistoryPath = `${sequoiaFundClientPath}/transactionhistory`;
const sequoiaFundHistoryJsonPath = `${sequoiaFundClientPath}/transactionhistoryJSON`;
const sequoiaFundActivityCsvPath = `${sequoiaFundClientPath}/transactionHistoryCSV`;
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

export type SequoiaFundSelectOption = {
  label: string;
  value: string;
  disabled?: boolean;
};

export type SequoiaFundActivityScope = {
  label: string;
  value: string;
};

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

type SequoiaFundActivityFilters = {
  accountField: string;
  durationField: string;
  transactionTypeField: string;
  accounts: SequoiaFundSelectOption[];
  durations: SequoiaFundSelectOption[];
  transactionTypes: SequoiaFundSelectOption[];
};

export type SequoiaFundActivityFormCandidate = Pick<
  SequoiaFundActivityForm,
  'action' | 'method' | 'enctype' | 'fields'
> & {
  hints: string[];
  duplicateFieldNames?: string[];
};

const sequoiaFundObservedHistoryFields = [
  'acctNumber',
  'customFormField_MaxReturnCount',
  'endDate',
  'groupKey',
  'range',
  'requestCode',
  'securityID',
  'startDate',
] as const;

const sequoiaFundRequiredHistoryFields = ['groupKey', 'range', 'requestCode'] as const;
const sequoiaFundAccountBindingFields = ['acctNumber', 'groupKey', 'range', 'securityID'] as const;

export type SequoiaFundRequestSnapshot = {
  url: string;
  method: string;
  contentType: string;
  body: string;
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

export type SequoiaFundActivityScopeState = {
  scopeValue: string;
  historyFields: Record<string, string>;
};

export type SequoiaFundActivityScopeBindings = {
  changedFieldNames: string[];
  bindingFieldNames: string[];
  bindings: Array<{
    scopeValue: string;
    bindingIdentity: string;
  }>;
};

export type SequoiaFundSubmitterCandidate = {
  index: number;
  visible: boolean;
  disabled: boolean;
  exportSemantic: boolean;
  resetSemantic: boolean;
  hasFormOverride: boolean;
};

export type SequoiaFundApiRequest = {
  url: string;
  method: 'GET' | 'POST';
  form?: Record<string, string>;
  multipart?: Record<string, string>;
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
  csrfToken: string | null;
  links: Array<{
    rawTarget: string;
    context: string;
  }>;
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

export function sequoiaFundActivityScopeToken(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('Sequoia Fund activity scope is empty');
  return `key-${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

export function sequoiaFundActivityScopesFromOptions(
  options: SequoiaFundSelectOption[],
): SequoiaFundActivityScope[] {
  const byValue = new Map<string, SequoiaFundActivityScope>();
  for (const option of options) {
    const value = option.value.trim();
    const label = option.label.replace(/\s+/g, ' ').trim();
    if (!value || option.disabled || byValue.has(value)) continue;
    byValue.set(value, { label, value });
  }
  if (byValue.size === 0) throw new Error('Sequoia Fund exposed no downloadable activity scopes');
  return [...byValue.values()];
}

function durationDays(label: string, today: Date): number | null {
  const normalized = label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (/\b(?:all|maximum|max|since inception)\b/.test(normalized)) return Number.POSITIVE_INFINITY;
  if (/\byear to date\b|\bytd\b/.test(normalized)) {
    const start = Date.UTC(today.getUTCFullYear(), 0, 1);
    return Math.ceil((today.getTime() - start) / 86_400_000) + 1;
  }
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    six: 6,
    twelve: 12,
  };
  const match = normalized.match(/\b(\d+|one|two|three|four|six|twelve)\s*(day|month|year)s?\b/);
  if (!match) return null;
  const count = Number(match[1]) || words[match[1]];
  if (match[2] === 'day') return count;
  if (match[2] === 'month') return count * 31;
  return count * 366;
}

export function selectSequoiaFundDuration(
  options: SequoiaFundSelectOption[],
  from: string,
  today = new Date(),
): SequoiaFundSelectOption {
  validateDate(from, 'Sequoia Fund activity start');
  const requestedDays = Math.max(
    1,
    Math.ceil((today.getTime() - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1,
  );
  const candidates = options
    .filter(option => option.value && !option.disabled)
    .map(option => ({ option, days: durationDays(option.label, today) }))
    .filter((candidate): candidate is { option: SequoiaFundSelectOption; days: number } =>
      candidate.days !== null && candidate.days >= requestedDays)
    .sort((left, right) => left.days - right.days);
  if (!candidates[0]) throw new Error('Sequoia Fund offers no activity duration covering the requested start date');
  return candidates[0].option;
}

export function selectAllSequoiaFundTransactions(
  options: SequoiaFundSelectOption[],
): SequoiaFundSelectOption {
  const option = options.find(candidate => candidate.value && !candidate.disabled && /\ball\b/i.test(candidate.label));
  if (!option) throw new Error('Sequoia Fund offers no all-transactions activity filter');
  return option;
}

export function selectSequoiaFundActivityExportForm(
  candidates: SequoiaFundActivityFormCandidate[],
  referer: string,
): SequoiaFundActivityFormCandidate {
  const refererUrl = validatedSequoiaFundUrl(referer);
  const matching = candidates.flatMap(candidate => {
    let action: URL;
    try {
      action = validatedSequoiaFundUrl(candidate.action, refererUrl.toString());
    } catch {
      return [];
    }
    if (action.origin !== refererUrl.origin ||
      action.pathname.toLowerCase() !== sequoiaFundActivityCsvPath.toLowerCase() ||
      candidate.method !== 'POST' ||
      candidate.enctype.toLowerCase() !== 'application/x-www-form-urlencoded') {
      return [];
    }
    if (candidate.duplicateFieldNames?.length) {
      throw new Error('Sequoia Fund activity export form has duplicate fields');
    }
    return [{ ...candidate, action: action.toString() }];
  });
  if (matching.length === 0) throw new Error('Sequoia Fund activity export form is unavailable');
  if (matching.length !== 1) {
    throw new Error('Sequoia Fund activity export form is ambiguous');
  }
  return matching[0]!;
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
  if (form.enctype.toLowerCase() === 'multipart/form-data') {
    return { url: action.toString(), method: 'POST', multipart: fields, headers };
  }
  throw new Error('Sequoia Fund activity form encoding is unsupported');
}

function requestedActivityDate(template: string, value: string): string {
  return template.includes('/')
    ? `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}`
    : value;
}

export function populateSequoiaFundActivityForm(
  exportForm: SequoiaFundActivityFormCandidate,
  historyFields: Record<string, string>,
  from: string,
  through: string,
): SequoiaFundActivityFormCandidate {
  validateDate(from, 'Sequoia Fund activity start');
  validateDate(through, 'Sequoia Fund activity through date');
  const missingHistory = sequoiaFundObservedHistoryFields.filter(name => !(name in historyFields));
  const missingExport = sequoiaFundObservedHistoryFields.filter(name => !(name in exportForm.fields));
  if (missingHistory.length > 0 || missingExport.length > 0) {
    throw new Error('Sequoia Fund activity export metadata is incomplete');
  }
  if (sequoiaFundRequiredHistoryFields.some(name => !historyFields[name])) {
    throw new Error('Sequoia Fund activity export account state is incomplete');
  }
  const fields = Object.fromEntries(Object.entries(exportForm.fields).map(([name, value]) => {
    if (name === 'startDate' && historyFields[name]) {
      return [name, requestedActivityDate(historyFields[name], from)];
    }
    if (name === 'endDate' && historyFields[name]) {
      return [name, requestedActivityDate(historyFields[name], through)];
    }
    return [name, historyFields[name] ?? value];
  }));
  return { ...exportForm, fields };
}

export function parseSequoiaFundHistoryRequest(
  snapshot: SequoiaFundRequestSnapshot,
): Record<string, string> | null {
  let url: URL;
  try {
    url = validatedSequoiaFundUrl(snapshot.url);
  } catch {
    return null;
  }
  if (url.pathname.toLowerCase() !== sequoiaFundHistoryJsonPath.toLowerCase() ||
    snapshot.method !== 'POST' ||
    !/application\/x-www-form-urlencoded/i.test(snapshot.contentType)) return null;
  const fields: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(snapshot.body)) {
    if (name in fields) return null;
    fields[name] = value;
  }
  if (sequoiaFundObservedHistoryFields.some(name => !(name in fields)) ||
    sequoiaFundRequiredHistoryFields.some(name => !fields[name])) return null;
  return fields;
}

function historyFields(request: Request): Record<string, string> | null {
  return parseSequoiaFundHistoryRequest({
    url: request.url(),
    method: request.method(),
    contentType: request.headers()['content-type'] ?? '',
    body: request.postData() ?? '',
  });
}

export function sequoiaFundHistoryAccountIdentity(fields: Record<string, string>): string {
  if (sequoiaFundRequiredHistoryFields.some(name => !fields[name])) {
    throw new Error('Sequoia Fund activity account state is incomplete');
  }
  return JSON.stringify(sequoiaFundAccountBindingFields.map(name => fields[name] ?? ''));
}

export function sequoiaFundActivityScopeBindings(
  states: SequoiaFundActivityScopeState[],
): SequoiaFundActivityScopeBindings {
  if (states.length === 0) throw new Error('Sequoia Fund activity scope binding map is empty');
  const scopeValues = new Set<string>();
  for (const state of states) {
    if (!state.scopeValue || scopeValues.has(state.scopeValue)) {
      throw new Error('Sequoia Fund activity scope binding map is ambiguous');
    }
    scopeValues.add(state.scopeValue);
    if (sequoiaFundObservedHistoryFields.some(name => !(name in state.historyFields)) ||
      sequoiaFundRequiredHistoryFields.some(name => !state.historyFields[name])) {
      throw new Error('Sequoia Fund activity account state is incomplete');
    }
  }

  const changedFieldNames = sequoiaFundObservedHistoryFields.filter(name =>
    new Set(states.map(state => state.historyFields[name] ?? '')).size > 1);
  const bindingFieldNames = sequoiaFundAccountBindingFields.filter(name => changedFieldNames.includes(name));
  const bindings = states.map(state => ({
    scopeValue: state.scopeValue,
    bindingIdentity: sequoiaFundHistoryAccountIdentity(state.historyFields),
  }));
  return { changedFieldNames, bindingFieldNames, bindings };
}

export function selectSequoiaFundActivityExportSubmitter(
  candidates: SequoiaFundSubmitterCandidate[],
): number | null {
  const viable = candidates.filter(candidate =>
    candidate.visible && !candidate.disabled && !candidate.resetSemantic);
  const semantic = viable.filter(candidate => candidate.exportSemantic);
  const selected = semantic.length === 1 ? semantic[0] : viable.length === 1 ? viable[0] : null;
  if (viable.length > 0 && !selected) {
    throw new Error('Sequoia Fund activity export submitter is ambiguous');
  }
  if (selected?.hasFormOverride) {
    throw new Error('Sequoia Fund activity export submitter overrides the observed form contract');
  }
  return selected?.index ?? null;
}

export function sequoiaFundActivityFilterRequestMatches(options: {
  url: string;
  method: string;
  accountField: string;
  accountValue: string;
  durationField: string;
  durationValue: string;
  transactionTypeField: string;
  transactionTypeValue: string;
}): boolean {
  let url: URL;
  try {
    url = validatedSequoiaFundUrl(options.url);
  } catch {
    return false;
  }
  return options.method === 'GET' &&
    url.pathname.toLowerCase() === sequoiaFundHistoryPath.toLowerCase() &&
    url.searchParams.get(options.accountField) === options.accountValue &&
    url.searchParams.get(options.durationField) === options.durationValue &&
    url.searchParams.get(options.transactionTypeField) === options.transactionTypeValue;
}

export function parseSequoiaFundActivityCsvRequest(
  snapshot: SequoiaFundRequestSnapshot,
  expectedFields: Record<string, string>,
): Record<string, string> | null {
  let url: URL;
  try {
    url = validatedSequoiaFundUrl(snapshot.url);
  } catch {
    return null;
  }
  if (snapshot.method !== 'POST' ||
    url.pathname.toLowerCase() !== sequoiaFundActivityCsvPath.toLowerCase() ||
    !/application\/x-www-form-urlencoded/i.test(snapshot.contentType)) return null;
  const fields: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(snapshot.body)) {
    if (name in fields) return null;
    fields[name] = value;
  }
  if (sequoiaFundObservedHistoryFields.some(name => !(name in fields)) ||
    Object.entries(expectedFields).some(([name, value]) => fields[name] !== value) ||
    sequoiaFundRequiredHistoryFields.some(name => !fields[name])) return null;
  return fields;
}

function stringsFromAccountFields(value: Record<string, unknown>): string[] {
  return Object.entries(value)
    .filter(([key, candidate]) => /account|fund/i.test(key) && typeof candidate === 'string')
    .map(([, candidate]) => String(candidate));
}

export function parseSequoiaFundStatementList(value: unknown): SequoiaFundStatementList {
  if (!value || typeof value !== 'object') throw new Error('Sequoia Fund statement list was not an object');
  const root = value as { success?: unknown; data?: unknown };
  if (root.success !== true || !root.data || typeof root.data !== 'object') {
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
    const statementType = typeof statement.statementType === 'string' ? statement.statementType : '';
    const statementDate = normalizeStatementDate(
      typeof statement.statementDate === 'string' ? statement.statementDate : '',
    );
    if (!documentId || !statementType || !statementDate) continue;
    documents.set(`${documentId}\0${statementType}`, {
      documentId,
      statementType,
      statementDate,
      accountHints: stringsFromAccountFields(statement),
    });
  }
  return { sessionId: data.sessionId, documents: [...documents.values()] };
}

export function sequoiaFundStatementListRequest(baseUrl: string): SequoiaFundApiRequest {
  const base = validatedSequoiaFundUrl(baseUrl);
  const url = new URL(sequoiaFundStatementListPath, base.origin);
  url.searchParams.set('queryType', 'all');
  return {
    url: url.toString(),
    method: 'GET',
    headers: { Referer: new URL(sequoiaFundStatementsPath, base.origin).toString() },
  };
}

function directStatementTarget(
  document: SequoiaFundStatementDocument,
  access: SequoiaFundStatementAccess,
  baseUrl: string,
): URL | null {
  for (const link of access.links) {
    const match = link.rawTarget.match(/https?:\/\/[^\s'"<>]+|\/BFWeb\/clients\/sequoiafund\/statements\/[^\s'"<>]+/i);
    if (!match) continue;
    const candidate = validatedSequoiaFundUrl(match[0].replace(/&amp;/g, '&'), baseUrl);
    if (decodeURIComponent(candidate.pathname).includes(`/${document.documentId}/`)) return candidate;
  }
  return null;
}

export function sequoiaFundStatementDownloadRequest(
  document: SequoiaFundStatementDocument,
  _list: SequoiaFundStatementList,
  access: SequoiaFundStatementAccess,
  baseUrl: string,
): SequoiaFundApiRequest {
  const base = validatedSequoiaFundUrl(baseUrl);
  const direct = directStatementTarget(document, access, base.toString());
  if (!direct) throw new Error('Sequoia Fund statement download metadata is unavailable');
  const url = direct;
  if (url.origin !== base.origin) throw new Error('Sequoia Fund statement download is not same-origin');
  return {
    url: url.toString(),
    method: 'GET',
    headers: { Referer: new URL(sequoiaFundStatementsPath, base.origin).toString() },
  };
}

export function sequoiaFundStatementJobs(
  account: SequoiaFundCanonicalAccount,
  list: SequoiaFundStatementList,
  access: SequoiaFundStatementAccess,
  baseUrl: string,
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
      request: sequoiaFundStatementDownloadRequest(document, list, access, baseUrl),
      fileName: `sequoia-fund-account-${account.accountToken}-${document.statementDate}-statement-${documentToken}.pdf`,
    });
  }
  return jobs.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function responseContentType(response: BrowserNativeResponse): string {
  return response.headers['content-type']?.toLowerCase() ?? '';
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

export function sequoiaFundActivityResponseMetadataAccepted(
  response: { ok: boolean } | null,
): boolean {
  return response === null || response.ok;
}

function assertCsvResponse(response: BrowserNativeResponse, body: Buffer): void {
  if (!browserNativeResponseOk(response) || body.length < 32 || classifySequoiaFundArtifactBytes(body) !== 'csv' ||
    !/(?:csv|text|excel|octet-stream)/.test(responseContentType(response))) {
    throw new Error('Sequoia Fund activity response failed CSV validation');
  }
}

function assertPdfResponse(response: BrowserNativeResponse, body: Buffer): void {
  if (!browserNativeResponseOk(response) || body.length < 1_000 || body.subarray(0, 5).toString('ascii') !== '%PDF-' ||
    !/(?:pdf|octet-stream)/.test(responseContentType(response))) {
    throw new Error('Sequoia Fund statement response failed PDF validation');
  }
}

async function executeRequest(page: Page, request: SequoiaFundApiRequest): Promise<BrowserNativeResponse> {
  return runBrowserNativeRequest(page, {
    url: request.url,
    method: request.method,
    headers: request.headers,
    ...(request.form ? { form: request.form } : {}),
    ...(request.multipart ? { multipart: request.multipart } : {}),
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

async function discoverActivityFilters(page: Page): Promise<SequoiaFundActivityFilters> {
  const current = validatedSequoiaFundUrl(page.url());
  await page.goto(new URL(sequoiaFundHistoryPath, current.origin).toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.locator('select#fundAccount').first().waitFor({ state: 'attached', timeout: 30_000 });
  await page.waitForFunction(() => {
    const select = document.querySelector('select#fundAccount');
    return select instanceof HTMLSelectElement && Array.from(select.options).some(option => option.value);
  });
  return page.locator('select#fundAccount').first().evaluate(select => {
    if (!(select instanceof HTMLSelectElement) || !select.form) {
      throw new Error('Sequoia Fund activity form is unavailable');
    }
    const duration = select.form.querySelector('select#duration');
    const transactionType = select.form.querySelector('select#transActionType');
    if (!(duration instanceof HTMLSelectElement) || !(transactionType instanceof HTMLSelectElement) ||
      !select.name || !duration.name || !transactionType.name) {
      throw new Error('Sequoia Fund activity filters are incomplete');
    }
    const options = (input: HTMLSelectElement) => Array.from(input.options).map(option => ({
      label: (option.textContent ?? '').replace(/\s+/g, ' ').trim(),
      value: option.value,
      disabled: input.disabled || option.disabled ||
        (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
    })).filter(option => option.value);
    return {
      accountField: select.name,
      durationField: duration.name,
      transactionTypeField: transactionType.name,
      accounts: options(select),
      durations: options(duration),
      transactionTypes: options(transactionType),
    };
  });
}

type SequoiaFundActivityExportState = {
  exportForm: SequoiaFundActivityFormCandidate;
  historyFields: Record<string, string>;
  accountIdentity: string;
  referer: string;
};

async function discoverActivityExportState(
  page: Page,
  filters: SequoiaFundActivityFilters,
  scope: SequoiaFundActivityScope,
  duration: SequoiaFundSelectOption,
  transactionType: SequoiaFundSelectOption,
  from: string,
  through: string,
  sensitiveValues: Set<string>,
): Promise<SequoiaFundActivityExportState> {
  sensitiveValues.add(scope.value);
  await page.waitForLoadState('networkidle', { timeout: 30_000 });
  let filterRequestObserved = false;
  const historyRequestPromise = page.waitForRequest(request => {
    if (sequoiaFundActivityFilterRequestMatches({
      url: request.url(),
      method: request.method(),
      accountField: filters.accountField,
      accountValue: scope.value,
      durationField: filters.durationField,
      durationValue: duration.value,
      transactionTypeField: filters.transactionTypeField,
      transactionTypeValue: transactionType.value,
    })) {
      filterRequestObserved = true;
      return false;
    }
    return filterRequestObserved && historyFields(request) !== null;
  }, { timeout: 30_000 });
  for (const [name, value] of [
    [filters.accountField, scope.value],
    [filters.durationField, duration.value],
    [filters.transactionTypeField, transactionType.value],
  ] as const) {
    const locator = page.locator(`select[name="${name}"]`).first();
    await locator.waitFor({ state: 'attached', timeout: 30_000 });
    await locator.selectOption(value);
  }
  const [, historyRequest] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
    historyRequestPromise,
    page.locator(`select[name="${filters.accountField}"]`).first().evaluate(element => {
      if (!(element instanceof HTMLSelectElement) || !element.form) {
        throw new Error('Sequoia Fund activity form is unavailable');
      }
      element.form.requestSubmit();
    }),
  ]);
  const observedHistory = historyFields(historyRequest);
  if (!observedHistory) {
    throw new Error('Sequoia Fund activity account mapping is ambiguous');
  }
  for (const value of Object.values(observedHistory)) {
    if (value) sensitiveValues.add(value);
  }
  const historyResponse = await historyRequest.response();
  await historyResponse?.finished();
  const selectedAccount = await page.locator(`select[name="${filters.accountField}"]`).first().inputValue();
  if (selectedAccount !== scope.value) {
    throw new Error('Sequoia Fund activity scope selection was not preserved');
  }
  await page.waitForFunction(expectedPath => Array.from(document.forms).some(form => {
    try {
      return new URL(form.action, location.href).pathname.toLowerCase() === expectedPath &&
        (form.method || 'GET').toUpperCase() === 'POST' &&
        form.enctype.toLowerCase() === 'application/x-www-form-urlencoded';
    } catch {
      return false;
    }
  }), sequoiaFundActivityCsvPath.toLowerCase(), { timeout: 30_000 });
  const discovered = await page.evaluate(() => Array.from(document.forms).map(form => {
      const entries = Array.from(new FormData(form).entries());
      const fields: Record<string, string> = {};
      const duplicateFieldNames = [...new Set(entries.map(([name]) => name)
        .filter((name, index, names) => names.indexOf(name) !== index))];
      for (const [key, value] of entries) {
        if (typeof value === 'string') fields[key] = value;
      }
      const submitHints = Array.from(form.elements).flatMap(element => {
        if (element instanceof HTMLButtonElement) {
          return [element.name, element.id, element.value, element.textContent ?? ''];
        }
        if (element instanceof HTMLInputElement && /^(?:button|image|submit)$/i.test(element.type)) {
          return [element.name, element.id, element.value];
        }
        return [];
      });
      return {
        action: form.action,
        method: (form.method || 'GET').toUpperCase(),
        enctype: form.enctype,
        fields,
        hints: [form.id, form.name, ...submitHints].filter(Boolean),
        duplicateFieldNames,
      };
    }));
  const candidates = discovered.flatMap(candidate =>
    candidate.method === 'GET' || candidate.method === 'POST'
      ? [candidate as SequoiaFundActivityFormCandidate]
      : []);
  const referer = page.url();
  const exportForm = populateSequoiaFundActivityForm(
    selectSequoiaFundActivityExportForm(candidates, referer),
    observedHistory,
    from,
    through,
  );
  return {
    exportForm,
    historyFields: observedHistory,
    accountIdentity: sequoiaFundHistoryAccountIdentity(observedHistory),
    referer,
  };
}

async function populateActivityExportForm(
  page: Page,
  state: SequoiaFundActivityExportState,
): Promise<void> {
  const populated = await page.locator('form').evaluateAll((forms, expected) => {
    const candidates = forms.filter((candidate): candidate is HTMLFormElement => {
      if (!(candidate instanceof HTMLFormElement)) return false;
      try {
        return new URL(candidate.action, location.href).toString() === expected.action &&
          (candidate.method || 'GET').toUpperCase() === expected.method;
      } catch {
        return false;
      }
    });
    if (candidates.length !== 1) return { formCount: candidates.length, missingFields: [] as string[] };
    const form = candidates[0]!;
    for (const candidate of forms) candidate.removeAttribute('data-easymoney-sequoia-export');
    form.setAttribute('data-easymoney-sequoia-export', 'true');
    const missingFields: string[] = [];
    for (const [name, value] of Object.entries(expected.fields)) {
      const controls = Array.from(form.elements).filter((control): control is HTMLInputElement |
        HTMLSelectElement | HTMLTextAreaElement =>
        (control instanceof HTMLInputElement || control instanceof HTMLSelectElement ||
          control instanceof HTMLTextAreaElement) && control.name === name);
      if (controls.length === 0) {
        missingFields.push(name);
        continue;
      }
      for (const control of controls) control.value = value;
    }
    return { formCount: candidates.length, missingFields };
  }, {
    action: state.exportForm.action,
    method: state.exportForm.method,
    fields: state.exportForm.fields,
  });
  if (populated.formCount !== 1 || populated.missingFields.length > 0) {
    throw new Error('Sequoia Fund activity export form changed before download');
  }
}

async function submitActivityExport(
  page: Page,
  state: SequoiaFundActivityExportState,
): Promise<{ download: Download; request: Request }> {
  await populateActivityExportForm(page, state);
  const requestPromise = page.waitForRequest(request => parseSequoiaFundActivityCsvRequest({
    url: request.url(),
    method: request.method(),
    contentType: request.headers()['content-type'] ?? '',
    body: request.postData() ?? '',
  }, state.exportForm.fields) !== null, { timeout: 30_000 });
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  const exportForm = page.locator('form[data-easymoney-sequoia-export="true"]');
  if (await exportForm.count() !== 1) throw new Error('Sequoia Fund activity export form is ambiguous');
  const submitters = exportForm.locator(
    'button,input[type="button"],input[type="image"],input[type="submit"]',
  );
  const submitterCandidates = await submitters.evaluateAll(elements => elements.map((element, index) => {
    if (!(element instanceof HTMLButtonElement) && !(element instanceof HTMLInputElement)) {
      throw new Error('Sequoia Fund activity export submitter is invalid');
    }
    const style = getComputedStyle(element);
    const signal = [element.name, element.id, element.value,
      element instanceof HTMLButtonElement ? element.textContent ?? '' : '']
      .join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
    return {
      index,
      visible: style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0,
      disabled: element.disabled,
      exportSemantic: /\b(?:csv|export|download)\b/.test(signal),
      resetSemantic: /\b(?:reset|clear|cancel)\b/.test(signal),
      hasFormOverride: ['formaction', 'formmethod', 'formenctype', 'formtarget']
        .some(name => element.hasAttribute(name)),
    };
  }));
  const submitterIndex = selectSequoiaFundActivityExportSubmitter(submitterCandidates);
  const submitPromise = submitterIndex === null
    ? exportForm.evaluate(candidate => {
        if (!(candidate instanceof HTMLFormElement)) {
          throw new Error('Sequoia Fund activity export form is invalid');
        }
        candidate.requestSubmit();
      })
    : submitters.nth(submitterIndex).click({ noWaitAfter: true });
  const [request, download] = await Promise.all([requestPromise, downloadPromise, submitPromise]);
  return { request, download };
}

async function fetchStatementList(page: Page): Promise<SequoiaFundStatementList> {
  const request = sequoiaFundStatementListRequest(page.url());
  const response = await executeRequest(page, request);
  if (!browserNativeResponseOk(response) || !responseContentType(response).includes('json')) {
    throw new Error('Sequoia Fund statement list request failed');
  }
  let body: unknown;
  try {
    body = JSON.parse(browserNativeResponseBody(response).toString('utf8')) as unknown;
  } catch {
    throw new Error('Sequoia Fund statement list request failed');
  }
  return parseSequoiaFundStatementList(body);
}

async function discoverStatementAccess(
  page: Page,
  expectedDocuments: number,
): Promise<SequoiaFundStatementAccess> {
  const current = validatedSequoiaFundUrl(page.url());
  await page.goto(new URL(sequoiaFundStatementsPath, current.origin).toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  if (expectedDocuments > 0) {
    await page.locator('a.statementLink').first().waitFor({ state: 'attached', timeout: 30_000 });
  }
  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a.statementLink')).map(link => ({
      rawTarget: [link.getAttribute('href'), link.getAttribute('onclick')].filter(Boolean).join(' '),
      context: (link.closest('li')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    }));
    const directToken = [
      document.querySelector<HTMLInputElement>('input[name="csrf_token"]')?.value,
      document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content,
    ].find(Boolean) ?? null;
    const targetToken = links
      .map(link => link.rawTarget.match(/[?&]csrf_token=([^&'"\s]+)/i)?.[1] ?? null)
      .find(Boolean) ?? null;
    return { csrfToken: directToken ?? targetToken, links };
  });
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
    const { request, download } = await submitActivityExport(options.page, options.state);
    const failure = await download.failure();
    if (failure) throw new Error('Sequoia Fund activity browser download failed');
    await download.saveAs(path);
    const bytes = await readFile(path);
    const byteClass = classifySequoiaFundArtifactBytes(bytes);
    const response = await request.response();
    const responseStatus = response?.status() ?? 0;
    const responseContentType = response?.headers()['content-type']?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!sequoiaFundActivityResponseMetadataAccepted(response ? { ok: response.ok() } : null)) {
      throw new Error('Sequoia Fund activity browser response failed');
    }
    if (byteClass !== 'csv') {
      throw new Error(`Sequoia Fund activity browser download was ${byteClass}`);
    }
    options.progress(options.key, 'activity-download', 'complete', 'Downloaded Sequoia Fund activity', {
      ...options.data,
      byteClass,
      responseStatus,
      responseContentType: responseContentType || 'unknown',
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
  const body = browserNativeResponseBody(response);
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
  progress(discoveryKey, 'discovery', 'start', 'Discovering Sequoia Fund activity scopes and artifacts');
  const activityFilters = await discoverActivityFilters(page);
  for (const option of activityFilters.accounts) {
    if (option.value) sensitiveValues.add(option.value);
    if (option.label) sensitiveValues.add(option.label);
  }
  const account = sequoiaFundCanonicalAccount(config.accountToken);
  const scopes = sequoiaFundActivityScopesFromOptions(activityFilters.accounts);
  const duration = selectSequoiaFundDuration(activityFilters.durations, config.from);
  const transactionType = selectAllSequoiaFundTransactions(activityFilters.transactionTypes);
  const artifacts: SequoiaFundDownloadedArtifact[] = [];
  const discoveredStates: Array<{
    scope: SequoiaFundActivityScope;
    state: SequoiaFundActivityExportState;
  }> = [];
  for (const scope of scopes) {
    const state = await discoverActivityExportState(
      page,
      activityFilters,
      scope,
      duration,
      transactionType,
      config.from,
      config.through,
      sensitiveValues,
    );
    discoveredStates.push({ scope, state });
  }
  const scopeBindings = sequoiaFundActivityScopeBindings(discoveredStates.map(({ scope, state }) => ({
    scopeValue: scope.value,
    historyFields: state.historyFields,
  })));
  progress('activity-scope-bindings', 'discovery', 'complete', 'Validated Sequoia Fund activity scope bindings', {
    activityScopeCount: scopes.length,
    changedFieldNames: scopeBindings.changedFieldNames.join(','),
    bindingFieldNames: scopeBindings.bindingFieldNames.join(','),
  });
  const bindingByScope = new Map(scopeBindings.bindings.map(binding => [
    binding.scopeValue,
    binding.bindingIdentity,
  ]));
  for (let index = 0; index < scopes.length; index += 1) {
    const scope = scopes[index]!;
    const state = await discoverActivityExportState(
      page,
      activityFilters,
      scope,
      duration,
      transactionType,
      config.from,
      config.through,
      sensitiveValues,
    );
    if (bindingByScope.get(scope.value) !== state.accountIdentity) {
      throw new Error('Sequoia Fund activity scope binding changed before download');
    }
    const scopeToken = sequoiaFundActivityScopeToken(scope.value);
    const fileName = `sequoia-fund-account-${account.accountToken}-scope-${scopeToken}-activity-${config.from}-to-${config.through}.csv`;
    artifacts.push(await downloadActivityArtifact({
      page,
      outputDir: config.outputDir,
      fileName,
      account,
      state,
      progress,
      key: `activity:${index}`,
      data: { activityScopeIndex: index + 1, activityScopeCount: scopes.length },
    }));
  }
  const statementList = await fetchStatementList(page);
  const statementAccess = await discoverStatementAccess(page, statementList.documents.length);
  const statementJobs = sequoiaFundStatementJobs(
    account,
    statementList,
    statementAccess,
    page.url(),
    config.from,
    config.through,
  );
  progress(discoveryKey, 'discovery', 'complete', 'Discovered Sequoia Fund activity scopes and artifacts', {
    accountCount: 1,
    activityCount: scopes.length,
    statementCount: statementJobs.length,
    activityChangedFieldNames: scopeBindings.changedFieldNames.join(','),
    activityBindingFieldNames: scopeBindings.bindingFieldNames.join(','),
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
    activityCount: scopes.length,
    statementCount: statementJobs.length,
  };
}

export async function isSequoiaFundAuthenticatedPage(page: Page): Promise<boolean> {
  try {
    const url = validatedSequoiaFundUrl(page.url());
    const authenticationFields = await page.locator([
      'input[type="password"]:visible',
      'input[autocomplete="username"]:visible',
      'input[autocomplete="current-password"]:visible',
      'input[autocomplete="one-time-code"]:visible',
      'input[name*="otp" i]:visible',
      'input[id*="otp" i]:visible',
    ].join(',')).count();
    if (authenticationFields > 0) return false;
    return url.pathname.startsWith(`${sequoiaFundClientPath}/`) && await page.locator([
      'a[href*="transactionhistory" i]',
      'a[href*="viewStatements" i]',
      'a[href*="logout" i]',
      'select#fundAccount',
    ].join(',')).count() > 0;
  } catch {
    return false;
  }
}

export async function waitUntilSequoiaFundAuthenticated(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(({ host, clientPath }) => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    const hasAuthenticationField = Array.from(document.querySelectorAll([
      'input[type="password"]',
      'input[autocomplete="username"]',
      'input[autocomplete="current-password"]',
      'input[autocomplete="one-time-code"]',
      'input[name*="otp" i]',
      'input[id*="otp" i]',
    ].join(','))).some(visible);
    const hasAuthenticatedNavigation = [
      'a[href*="transactionhistory" i]',
      'a[href*="viewStatements" i]',
      'a[href*="logout" i]',
      'select#fundAccount',
    ].some(selector => document.querySelector(selector));
    return location.protocol === 'https:' &&
      (location.hostname === host || location.hostname.endsWith(`.${host}`)) &&
      location.pathname.startsWith(`${clientPath}/`) &&
      !hasAuthenticationField &&
      hasAuthenticatedNavigation;
  }, { host: sequoiaFundHost, clientPath: sequoiaFundClientPath }, { timeout: timeoutMs });
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
