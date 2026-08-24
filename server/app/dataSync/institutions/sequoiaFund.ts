import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import type { APIResponse, Page } from 'playwright';

import { parseCsvRows } from '../../importParsers/csvRows.ts';
import { sequoiaFundActivityParser } from '../../importParsers/sequoiaFundActivity.ts';
import {
  sequoiaFundSourceAccountName,
} from '../../importParsers/sequoiaFundIdentity.ts';
import { sequoiaFundStatementParser } from '../../importParsers/sequoiaFundStatement.ts';
import {
  playwrightHasSavedAuthentication,
  runInstitutionBrowserProgram,
} from '../browserSession.ts';

const sequoiaFundHost = 'secureaccountview.com';
const sequoiaFundClientPath = '/BFWeb/clients/sequoiafund';
const sequoiaFundLoginUrl = `https://${sequoiaFundHost}${sequoiaFundClientPath}/index`;
const sequoiaFundHistoryPath = `${sequoiaFundClientPath}/transactionhistory`;
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
  session?: string;
  profilePath?: string;
  headless?: boolean;
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

export type SequoiaFundSelectOption = {
  label: string;
  value: string;
};

export type SequoiaFundRemoteAccount = {
  label: string;
  value: string;
  last4: string | null;
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
  account: SequoiaFundRemoteAccount;
  document: SequoiaFundStatementDocument;
  request: SequoiaFundApiRequest;
  fileName: string;
};

function safeErrorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
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

function accountLast4(label: string, value: string): string | null {
  return label.match(/(\d{4})(?!.*\d)/)?.[1] ?? value.match(/(\d{4})(?!.*\d)/)?.[1] ?? null;
}

function opaqueAccountToken(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function accountNameForToken(accountToken: string): string {
  return sequoiaFundSourceAccountName(
    `sequoia-fund-account-${accountToken}-activity-2000-01-01-to-2000-01-01.csv`,
  );
}

export function sequoiaFundAccountsFromOptions(
  options: SequoiaFundSelectOption[],
): SequoiaFundRemoteAccount[] {
  const byValue = new Map<string, SequoiaFundRemoteAccount>();
  for (const option of options) {
    const value = option.value.trim();
    const label = option.label.replace(/\s+/g, ' ').trim();
    if (!value || byValue.has(value)) continue;
    const last4 = accountLast4(label, value);
    const accountToken = last4 ? `last4-${last4}` : `key-${opaqueAccountToken(value)}`;
    byValue.set(value, {
      label,
      value,
      last4,
      accountToken,
      accountName: accountNameForToken(accountToken),
    });
  }
  if (byValue.size === 0) throw new Error('Sequoia Fund exposed no downloadable accounts');

  const tokens = new Set<string>();
  for (const account of byValue.values()) {
    if (tokens.has(account.accountToken)) {
      throw new Error('Sequoia Fund exposed ambiguous account identities');
    }
    tokens.add(account.accountToken);
  }
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
    .filter(option => option.value)
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
  const option = options.find(candidate => candidate.value && /\ball\b/i.test(candidate.label));
  if (!option) throw new Error('Sequoia Fund offers no all-transactions activity filter');
  return option;
}

export function selectSequoiaFundActivityExportForm(
  candidates: SequoiaFundActivityFormCandidate[],
  referer: string,
): SequoiaFundActivityFormCandidate {
  const refererUrl = validatedSequoiaFundUrl(referer);
  const scored = candidates.flatMap(candidate => {
    let action: URL;
    try {
      action = validatedSequoiaFundUrl(candidate.action, refererUrl.toString());
    } catch {
      return [];
    }
    if (action.origin !== refererUrl.origin || (candidate.method !== 'GET' && candidate.method !== 'POST')) {
      return [];
    }
    const signal = [
      action.pathname,
      ...candidate.hints,
      ...Object.keys(candidate.fields),
      ...Object.values(candidate.fields).filter(value => /^(?:csv|export|download)$/i.test(value)),
    ].join(' ').toLowerCase();
    if (!/(?:csv|export|download)/.test(signal) || /(?:tax.?lot|cost.?basis)/.test(signal)) return [];
    const score = (signal.includes('csv') ? 4 : 0) +
      (signal.includes('export') ? 2 : 0) +
      (signal.includes('download') ? 2 : 0) +
      (signal.includes('transaction') ? 4 : 0) +
      (signal.includes('history') ? 2 : 0) +
      (signal.includes('activity') ? 2 : 0);
    return score > 0 ? [{ candidate: { ...candidate, action: action.toString() }, score }] : [];
  }).sort((left, right) => right.score - left.score);

  const selected = scored[0];
  if (!selected) throw new Error('Sequoia Fund activity export form is unavailable');
  if (scored[1]?.score === selected.score) {
    throw new Error('Sequoia Fund activity export form is ambiguous');
  }
  return selected.candidate;
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
  list: SequoiaFundStatementList,
  access: SequoiaFundStatementAccess,
  baseUrl: string,
): SequoiaFundApiRequest {
  const base = validatedSequoiaFundUrl(baseUrl);
  const direct = directStatementTarget(document, access, base.toString());
  const url = direct ?? new URL([
    sequoiaFundClientPath,
    'statements',
    encodeURIComponent(document.documentId),
    encodeURIComponent(document.statementType),
    encodeURIComponent(list.sessionId),
  ].join('/'), base.origin);
  if (!direct) {
    if (!access.csrfToken) throw new Error('Sequoia Fund statement access token is unavailable');
    url.searchParams.set('csrf_token', access.csrfToken);
  }
  if (url.origin !== base.origin) throw new Error('Sequoia Fund statement download is not same-origin');
  return {
    url: url.toString(),
    method: 'GET',
    headers: { Referer: new URL(sequoiaFundStatementsPath, base.origin).toString() },
  };
}

function statementAccount(
  document: SequoiaFundStatementDocument,
  context: string,
  accounts: SequoiaFundRemoteAccount[],
): SequoiaFundRemoteAccount {
  if (accounts.length === 1) return accounts[0]!;
  const hints = [...document.accountHints, context].map(value => value.toLowerCase());
  const matches = accounts.filter(account => hints.some(hint =>
    (account.last4 ? hint.includes(account.last4) : false) ||
    (account.label.length >= 4 ? hint.includes(account.label.toLowerCase()) : false) ||
    (account.value.length >= 4 ? hint.includes(account.value.toLowerCase()) : false)));
  if (matches.length !== 1) throw new Error('Sequoia Fund statement account mapping is ambiguous');
  return matches[0]!;
}

export function sequoiaFundStatementJobs(
  accounts: SequoiaFundRemoteAccount[],
  list: SequoiaFundStatementList,
  access: SequoiaFundStatementAccess,
  baseUrl: string,
  from: string,
  through: string,
): SequoiaFundStatementJob[] {
  const jobs: SequoiaFundStatementJob[] = [];
  for (const document of list.documents) {
    if (document.statementDate < from || document.statementDate > through) continue;
    const link = access.links.find(candidate => candidate.rawTarget.includes(document.documentId));
    const account = statementAccount(document, link?.context ?? '', accounts);
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

function responseContentType(response: APIResponse): string {
  return response.headers()['content-type']?.toLowerCase() ?? '';
}

function assertCsvResponse(response: APIResponse, body: Buffer): void {
  const sample = body.subarray(0, Math.min(body.length, 1024));
  const text = sample.toString('utf8').trimStart().toLowerCase();
  if (!response.ok() || body.length < 32 || sample.includes(0) || !sample.includes(44) || !/[\r\n]/.test(text) ||
    text.startsWith('<') || text.startsWith('%pdf-') ||
    !/(?:csv|text|excel|octet-stream)/.test(responseContentType(response))) {
    throw new Error('Sequoia Fund activity response failed CSV validation');
  }
}

function assertPdfResponse(response: APIResponse, body: Buffer): void {
  if (!response.ok() || body.length < 1_000 || body.subarray(0, 5).toString('ascii') !== '%PDF-' ||
    !/(?:pdf|octet-stream)/.test(responseContentType(response))) {
    throw new Error('Sequoia Fund statement response failed PDF validation');
  }
}

async function executeRequest(page: Page, request: SequoiaFundApiRequest): Promise<APIResponse> {
  return page.context().request.fetch(request.url, {
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
  account: SequoiaFundRemoteAccount,
): Promise<Omit<SequoiaFundDownloadedArtifact, 'status' | 'statementDate'>> {
  const fileName = basename(path);
  const expectedExtension = kind === 'activity' ? '.csv' : '.pdf';
  if (!fileName.endsWith(expectedExtension)) throw new Error('Sequoia Fund artifact extension is invalid');
  const info = await stat(path);
  const minimum = kind === 'activity' ? 32 : 1_000;
  if (!info.isFile() || info.size < minimum) throw new Error('Sequoia Fund artifact is empty or too small');
  const bytes = await readFile(path);
  if (kind === 'activity') {
    const sample = bytes.subarray(0, Math.min(bytes.length, 1024));
    const text = sample.toString('utf8').trimStart().toLowerCase();
    if (sample.includes(0) || !sample.includes(44) || !/[\r\n]/.test(text) || text.startsWith('<')) {
      throw new Error('Sequoia Fund activity file signature is invalid');
    }
  } else if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
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

async function discoverActivityRequest(
  page: Page,
  filters: SequoiaFundActivityFilters,
  account: SequoiaFundRemoteAccount,
  duration: SequoiaFundSelectOption,
  transactionType: SequoiaFundSelectOption,
  referer: string,
): Promise<SequoiaFundApiRequest> {
  const discovered = await page.evaluate(async selection => {
    const setSelection = (name: string, value: string) => {
      const select = Array.from(document.querySelectorAll('select'))
        .find(candidate => candidate.name === name);
      if (!(select instanceof HTMLSelectElement) ||
        !Array.from(select.options).some(option => option.value === value)) {
        throw new Error('Sequoia Fund activity selection is unavailable');
      }
      select.value = value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setSelection(selection.accountField, selection.accountValue);
    setSelection(selection.durationField, selection.durationValue);
    setSelection(selection.transactionTypeField, selection.transactionTypeValue);
    await Promise.resolve();

    return Array.from(document.forms).map(form => {
      const fields: Record<string, string> = {};
      for (const [key, value] of new FormData(form).entries()) {
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
      };
    });
  }, {
    accountField: filters.accountField,
    accountValue: account.value,
    durationField: filters.durationField,
    durationValue: duration.value,
    transactionTypeField: filters.transactionTypeField,
    transactionTypeValue: transactionType.value,
  });
  const candidates = discovered.flatMap(candidate =>
    candidate.method === 'GET' || candidate.method === 'POST'
      ? [candidate as SequoiaFundActivityFormCandidate]
      : []);
  const exportForm = selectSequoiaFundActivityExportForm(candidates, referer);
  return sequoiaFundActivityRequest(exportForm, referer);
}

async function fetchStatementList(page: Page): Promise<SequoiaFundStatementList> {
  const request = sequoiaFundStatementListRequest(page.url());
  const response = await executeRequest(page, request);
  if (!response.ok() || !responseContentType(response).includes('json')) {
    throw new Error('Sequoia Fund statement list request failed');
  }
  return parseSequoiaFundStatementList(await response.json());
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
  account: SequoiaFundRemoteAccount,
): Promise<SequoiaFundDownloadedArtifact | null> {
  try {
    return { ...await validateSequoiaFundArtifact(path, kind, account), status: 'existing' };
  } catch {
    return null;
  }
}

async function downloadArtifact(options: {
  page: Page;
  outputDir: string;
  fileName: string;
  kind: SequoiaFundArtifactKind;
  account: SequoiaFundRemoteAccount;
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
  const body = await response.body();
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
  config: Required<Pick<SequoiaFundSyncConfig, 'outputDir' | 'from' | 'through'>>,
  progress: Progress,
): Promise<SequoiaFundSyncResult> {
  const discoveryKey = 'discovery';
  progress(discoveryKey, 'discovery', 'start', 'Discovering Sequoia Fund accounts and artifacts');
  const activityFilters = await discoverActivityFilters(page);
  const accounts = sequoiaFundAccountsFromOptions(activityFilters.accounts);
  const duration = selectSequoiaFundDuration(activityFilters.durations, config.from);
  const transactionType = selectAllSequoiaFundTransactions(activityFilters.transactionTypes);
  const historyUrl = page.url();
  const activityRequests: SequoiaFundApiRequest[] = [];
  const activityRequestIdentities = new Set<string>();
  for (const account of accounts) {
    const request = await discoverActivityRequest(
      page,
      activityFilters,
      account,
      duration,
      transactionType,
      historyUrl,
    );
    const requestIdentity = JSON.stringify([
      request.method,
      request.url,
      Object.entries(request.form ?? request.multipart ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ]);
    if (activityRequestIdentities.has(requestIdentity)) {
      throw new Error('Sequoia Fund activity request mapping is ambiguous');
    }
    activityRequestIdentities.add(requestIdentity);
    activityRequests.push(request);
  }
  const statementList = await fetchStatementList(page);
  const statementAccess = await discoverStatementAccess(page, statementList.documents.length);
  const statementJobs = sequoiaFundStatementJobs(
    accounts,
    statementList,
    statementAccess,
    page.url(),
    config.from,
    config.through,
  );
  progress(discoveryKey, 'discovery', 'complete', 'Discovered Sequoia Fund accounts and artifacts', {
    accountCount: accounts.length,
    activityCount: accounts.length,
    statementCount: statementJobs.length,
  });

  const artifacts: SequoiaFundDownloadedArtifact[] = [];
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index]!;
    const fileName = `sequoia-fund-account-${account.accountToken}-activity-${config.from}-to-${config.through}.csv`;
    artifacts.push(await downloadArtifact({
      page,
      outputDir: config.outputDir,
      fileName,
      kind: 'activity',
      account,
      request: activityRequests[index]!,
      progress,
      key: `activity:${index}`,
      phase: 'activity-download',
      data: { accountIndex: index + 1, accountCount: accounts.length },
    }));
  }

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
    accountCount: accounts.length,
    activityCount: accounts.length,
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
  if (config.from > config.through) throw new Error('Sequoia Fund date range is invalid');
  const outputDir = resolve(config.outputDir);
  await mkdir(outputDir, { recursive: true });
  const session = config.session ?? 'sequoia-fund-catchup';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(session)) {
    throw new Error('Sequoia Fund session must be a PII-free kebab-case label');
  }

  const progress = createProgress(onProgress);
  const authenticationKey = 'authentication';
  const hasSavedAuthentication = await playwrightHasSavedAuthentication(session, config.profilePath);
  progress(authenticationKey, 'authentication', 'start', 'Checking Sequoia Fund authentication', {
    cachedAuthentication: hasSavedAuthentication,
  });
  let authenticationWaiting = false;
  const startedAt = performance.now();
  const result = await runInstitutionBrowserProgram<SequoiaFundSyncResult>(
    {
      name: session,
      startUrl: sequoiaFundLoginUrl,
      savedAuthenticationMode: 'headed',
      ...(config.profilePath ? { profilePath: config.profilePath } : {}),
      ...(config.headless === undefined ? {} : { contextOptions: { headless: config.headless } }),
    },
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
        safeErrorMessage,
        syncAuthenticated: (page: Page) => syncAuthenticated(page, {
          outputDir,
          from: config.from,
          through: config.through,
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
