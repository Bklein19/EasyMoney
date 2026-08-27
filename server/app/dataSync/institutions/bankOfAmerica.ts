#!/usr/bin/env bun

import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";

import { runInstitutionBrowserProgram } from "../browserSession.ts";
import {
  browserNativeResponseBody,
  browserNativeResponseOk,
  runBrowserNativeRequest,
  type BrowserNativeResponse,
} from "../browserRequest.ts";
import { parseCsvRows } from "../../importParsers/csvRows.ts";
import type { Page } from "playwright";

export type BankOfAmericaSyncConfig = {
  outputDir: string;
  through: string;
  checkingThrough?: string;
  savingsThrough?: string;
  cardThrough?: string;
  checkingFrom: string;
  savingsFrom: string;
  cardFrom: string;
  session: string;
  scope: "checking" | "savings" | "card-activity" | "card-statements" | null;
  accounts?: BankOfAmericaAccountPlan[];
  dryRun: boolean;
};

export type BankOfAmericaAccountKind = "checking" | "savings" | "deposit" | "credit-card";

export type BankOfAmericaAccountPlan = {
  kind: BankOfAmericaAccountKind;
  last4: string;
  from: string;
  through: string;
};

export type BankOfAmericaRemoteAccount = {
  kind: BankOfAmericaAccountKind;
  last4: string;
  label: string;
  destination: string;
};

export type BankOfAmericaCardPeriodOption = {
  label: string;
  value: string;
};

export type BankOfAmericaCardActivityJob = {
  label: string;
  filename: string;
  target: string;
};

export type BankOfAmericaApiRequest = {
  url: string;
  method: "GET" | "POST";
  multipart?: Record<string, string>;
  data?: Record<string, string>;
};

export type BankOfAmericaStatementDocument = {
  accountDisplayName?: string;
  adx?: string;
  date?: string;
  docDisplayName?: string;
  docId?: string;
};

type ValidArtifact = {
  filename: string;
  kind: "csv" | "pdf";
  size: number;
};

const loginUrl = "https://secure.bankofamerica.com/myaccounts/signin/signIn.go";
const bankOfAmericaOrigin = "https://secure.bankofamerica.com";
const depositActivityPath = "/ogateway/addapi/v1/download/form/transaction";
const statementIndexPath = "/ogateway/dsviewdocuments/omni/statements/v1/gatherDocuments";
const statementDownloadPath = "/ogateway/dsviewdocuments/omni/statements/v1/docViewDownload";
const cardActivityPath = "/myaccounts/details/card/download-transactions.go";

const bankOfAmericaMonthNumbers: Record<string, string> = {
  Jan: "01",
  January: "01",
  Feb: "02",
  February: "02",
  Mar: "03",
  March: "03",
  Apr: "04",
  April: "04",
  May: "05",
  Jun: "06",
  June: "06",
  Jul: "07",
  July: "07",
  Aug: "08",
  August: "08",
  Sep: "09",
  September: "09",
  Oct: "10",
  October: "10",
  Nov: "11",
  November: "11",
  Dec: "12",
  December: "12",
};

function dateFromBankOfAmericaPeriodLabel(label: string): string | null {
  const match = label.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),\s+(\d{4})\b/,
  );
  if (!match) return null;
  return `${match[3]}-${bankOfAmericaMonthNumbers[match[1]]}-${match[2].padStart(2, "0")}`;
}

export function bankOfAmericaCardActivityJobs(
  options: BankOfAmericaCardPeriodOption[],
  excelFileTypeValue: string,
  from: string,
  through: string,
  accountLast4?: string,
): BankOfAmericaCardActivityJob[] {
  const jobs: BankOfAmericaCardActivityJob[] = [];
  const prefix = `bofa-credit-card${accountLast4 ? `-${accountLast4}` : ""}`;
  for (const option of options) {
    const label = option.label.trim();
    if (!label || !option.value) continue;
    if (/^Current transactions$/i.test(label)) {
      jobs.push({
        label,
        filename: `${prefix}-current-to-${through}.csv`,
        target: option.value + excelFileTypeValue,
      });
      continue;
    }
    const date = dateFromBankOfAmericaPeriodLabel(label);
    if (!date || date < from || date > through) continue;
    jobs.push({
      label,
      filename: `${prefix}-period-ending-${date}.csv`,
      target: option.value + excelFileTypeValue,
    });
  }
  if (!jobs.some(job => job.filename === `${prefix}-current-to-${through}.csv`)) {
    throw new Error("Bank of America did not offer a current credit-card activity period");
  }
  return jobs;
}

function bankOfAmericaRemoteAccountKind(label: string, destination: string): BankOfAmericaAccountKind {
  const target = new URL(destination).searchParams.get("target") ?? "";
  const value = `${label} ${target}`;
  if (/credit|card|visa|mastercard/i.test(value)) return "credit-card";
  if (/savings|money market/i.test(value)) return "savings";
  if (/checking|banking/i.test(value)) return "checking";
  return "deposit";
}

export async function discoverBankOfAmericaAccounts(page: Page): Promise<BankOfAmericaRemoteAccount[]> {
  const links = page.locator('a[href*="/myaccounts/brain/redirect.go"]');
  await links.first().waitFor({ state: "attached", timeout: 30_000 }).catch(() => {
    throw new Error("Timed out waiting for Bank of America accounts");
  });
  const candidates = await links.evaluateAll((elements, baseUrl) => elements.map(element => ({
    label: (element.textContent || "").replace(/\s+/g, " ").trim(),
    destination: new URL(element.getAttribute("href") || "", String(baseUrl)).toString(),
  })), page.url());
  const accounts = new Map<string, BankOfAmericaRemoteAccount>();
  for (const candidate of candidates) {
    const url = new URL(candidate.destination);
    if (url.origin !== bankOfAmericaOrigin || url.pathname !== "/myaccounts/brain/redirect.go") continue;
    const token = url.searchParams.get("adx");
    if (!token || accounts.has(token)) continue;
    const last4 = candidate.label.match(/(?:-|ending in|[x*\u2022]{2,})\s*(\d{4})\b/i)?.[1];
    if (!last4) throw new Error("A Bank of America account did not expose its last four digits");
    accounts.set(token, {
      kind: bankOfAmericaRemoteAccountKind(candidate.label, candidate.destination),
      last4,
      label: candidate.label,
      destination: candidate.destination,
    });
  }
  if (accounts.size === 0) throw new Error("Bank of America did not expose any downloadable accounts");
  const identities = new Set<string>();
  for (const account of accounts.values()) {
    const identity = `${account.kind}:${account.last4}`;
    if (identities.has(identity)) {
      throw new Error(`Multiple Bank of America ${account.kind} accounts end in the same four digits`);
    }
    identities.add(identity);
  }
  return [...accounts.values()];
}

export async function openBankOfAmericaAccount(
  page: Page,
  destination: string,
): Promise<void> {
  await page.goto(destination, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
}

export async function isBankOfAmericaAuthenticatedPage(page: Page): Promise<boolean> {
  let hostname: string;
  try {
    hostname = new URL(page.url()).hostname;
  } catch {
    return false;
  }
  if (hostname !== "secure.bankofamerica.com") return false;
  if (!/Accounts Overview/i.test(await page.title())) return false;
  return await page.locator('input[type="password"]:visible').count() === 0;
}

export async function waitUntilBankOfAmericaAuthenticated(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(() => {
    const passwordField = document.querySelector('input[type="password"]');
    const passwordFieldIsVisible = passwordField
      ? getComputedStyle(passwordField).display !== 'none' &&
        getComputedStyle(passwordField).visibility !== 'hidden' &&
        passwordField.getClientRects().length > 0
      : false;
    return location.hostname === 'secure.bankofamerica.com' &&
      /Accounts Overview/i.test(document.title) &&
      !passwordFieldIsVisible;
  }, undefined, { timeout: timeoutMs });
}

export function parseBankOfAmericaArgs(args: string[]): BankOfAmericaSyncConfig {
  const today = new Date().toISOString().slice(0, 10);
  const config: BankOfAmericaSyncConfig = {
    outputDir: join(
      homedir(),
      `Downloads/easymoney-imports/${today}`,
    ),
    through: today,
    checkingFrom: today,
    savingsFrom: today,
    cardFrom: today,
    session: "bank-of-america",
    scope: null,
    dryRun: false,
  };

  const valueFlags: Record<string, 'outputDir' | 'through' | 'checkingFrom' | 'savingsFrom' | 'cardFrom' | 'session'> = {
    "--output-dir": "outputDir",
    "--through": "through",
    "--checking-from": "checkingFrom",
    "--savings-from": "savingsFrom",
    "--card-from": "cardFrom",
    "--session": "session",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      config.dryRun = true;
      continue;
    }
    if (arg === "--scope") {
      const value = args[index + 1];
      if (!value || !["checking", "savings", "card-activity", "card-statements"].includes(value))
        throw new Error("--scope must be checking, savings, card-activity, or card-statements");
      config.scope = value as BankOfAmericaSyncConfig["scope"];
      index += 1;
      continue;
    }
    const key = valueFlags[arg];
    if (!key)
      throw new Error(`Unknown argument: ${arg}`);
    const value = args[index + 1];
    if (!value)
      throw new Error(`Missing value for ${arg}`);
    config[key] = value as never;
    index += 1;
  }

  for (const value of [
    config.through,
    config.checkingFrom,
    config.savingsFrom,
    config.cardFrom,
  ]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new Error(`Dates must use YYYY-MM-DD: ${value}`);
  }

  return config;
}

async function validateArtifact(path: string): Promise<ValidArtifact> {
  const filename = basename(path);
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension !== "csv" && extension !== "pdf")
    throw new Error(`${filename}: unsupported extension`);

  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size < 16)
    throw new Error(`${filename}: file is empty or too small`);

  const bytes = await readFile(path);
  if (extension === "pdf") {
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-")
      throw new Error(`${filename}: PDF magic is missing`);
  } else {
    const sample = bytes.subarray(0, Math.min(bytes.length, 1024));
    const text = sample.toString("utf8");
    if (sample.includes(0) || !sample.includes(44) || !/[\r\n]/.test(text))
      throw new Error(`${filename}: CSV text magic is invalid`);
    if (/^bofa-(checking|savings|deposit)-/i.test(filename) &&
      (!text.includes("Description,,Summary Amt.") ||
        !text.includes("Date,Description,Amount,Running Bal."))) {
      throw new Error(`${filename}: Bank of America deposit headers are missing`);
    }
  }

  return { filename, kind: extension, size: metadata.size };
}

async function validatedArtifacts(outputDir: string): Promise<ValidArtifact[]> {
  const filenames = await readdir(outputDir).catch(() => []);
  const results: ValidArtifact[] = [];
  for (const filename of filenames) {
    if (!/^bofa-.*\.(csv|pdf)$/i.test(filename))
      continue;
    results.push(await validateArtifact(join(outputDir, filename)));
  }
  return results.sort((left, right) => left.filename.localeCompare(right.filename));
}

export function hasBankOfAmericaCreditCardActivity(text: string): boolean {
  const rows = parseCsvRows(text);
  return rows.slice(1).some(row => row.some(value => value.trim().length > 0));
}

function bankOfAmericaAccountToken(destination: string): string {
  const url = new URL(destination);
  if (url.origin !== bankOfAmericaOrigin || url.pathname !== "/myaccounts/brain/redirect.go") {
    throw new Error("Bank of America account destination is invalid");
  }
  const token = url.searchParams.get("adx");
  if (!token) throw new Error("Bank of America account destination has no account token");
  return token;
}

function bankOfAmericaDate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Bank of America date is invalid: ${value}`);
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function bankOfAmericaStatementYears(from: string, through: string): string[] {
  const first = Number(from.slice(0, 4));
  const last = Number(through.slice(0, 4));
  if (!Number.isInteger(first) || !Number.isInteger(last) || first > last) {
    throw new Error("Bank of America statement range is invalid");
  }
  return Array.from({ length: last - first + 1 }, (_value, index) => String(first + index));
}

function validatedBankOfAmericaUrl(value: string, allowedPath: string, base = bankOfAmericaOrigin): string {
  const url = new URL(value, base);
  if (url.origin !== bankOfAmericaOrigin || url.pathname !== allowedPath) {
    throw new Error("Bank of America API destination is invalid");
  }
  return url.toString();
}

export function bankOfAmericaDepositActivityRequest(
  accountDestination: string,
  from: string,
  through: string,
): BankOfAmericaApiRequest {
  return {
    url: `${bankOfAmericaOrigin}${depositActivityPath}`,
    method: "POST",
    multipart: {
      "payload.accountToken": bankOfAmericaAccountToken(accountDestination),
      "payload.locale": "en-us",
      "payload.txnSearchCriteria.txnPeriod": "custom range",
      "payload.txnSearchCriteria.startDate": bankOfAmericaDate(from),
      "payload.txnSearchCriteria.endDate": bankOfAmericaDate(through),
      "payload.txnSearchCriteria.fileType": "csv",
    },
  };
}

export function bankOfAmericaStatementIndexRequests(
  accountDestination: string,
  from: string,
  through: string,
): BankOfAmericaApiRequest[] {
  const accountToken = bankOfAmericaAccountToken(accountDestination);
  return bankOfAmericaStatementYears(from, through).map(year => ({
    url: `${bankOfAmericaOrigin}${statementIndexPath}`,
    method: "POST" as const,
    data: {
      adx: accountToken,
      docCategoryId: "DISPFLD001",
      lang: "en-US",
      year,
    },
  }));
}

export function bankOfAmericaStatementDownloadRequest(
  statement: BankOfAmericaStatementDocument,
): BankOfAmericaApiRequest {
  if (!statement.adx || !statement.docId) {
    throw new Error("Bank of America statement metadata is incomplete");
  }
  const params = new URLSearchParams({
    adx: statement.adx,
    documentId: statement.docId,
    adaDocumentFlag: "N",
    menuFlag: "download",
    request_locale: "en-US",
  });
  return {
    url: `${bankOfAmericaOrigin}${statementDownloadPath}?${params}`,
    method: "GET",
  };
}

export function bankOfAmericaCardActivityRequest(
  target: string,
  accountPageUrl: string,
): BankOfAmericaApiRequest {
  return {
    url: validatedBankOfAmericaUrl(target, cardActivityPath, accountPageUrl),
    method: "GET",
  };
}

async function executeBankOfAmericaRequest(
  page: Page,
  request: BankOfAmericaApiRequest,
): Promise<BrowserNativeResponse> {
  if (request.multipart) {
    return runBrowserNativeRequest(page, {
      url: request.url,
      method: request.method,
      multipart: request.multipart,
    });
  }
  if (request.data) {
    return runBrowserNativeRequest(page, {
      url: request.url,
      method: request.method,
      headers: { "content-type": "application/json" },
      bodyBase64: Buffer.from(JSON.stringify(request.data), "utf8").toString("base64"),
    });
  }
  return runBrowserNativeRequest(page, { url: request.url, method: request.method });
}

async function saveBankOfAmericaArtifact(
  page: Page,
  outputDir: string,
  filename: string,
  kind: "csv" | "pdf",
  request: BankOfAmericaApiRequest,
): Promise<void> {
  if (basename(filename) !== filename || !/^bofa-[a-z0-9-]+\.(csv|pdf)$/i.test(filename)) {
    throw new Error("Bank of America artifact filename is invalid");
  }
  const response = await executeBankOfAmericaRequest(page, request);
  if (!browserNativeResponseOk(response)) {
    throw new Error(`Bank of America ${kind.toUpperCase()} request failed with status ${response.status}`);
  }
  const contentType = response.headers["content-type"]?.toLowerCase() ?? "";
  if (kind === "csv" && !contentType.includes("csv") && !contentType.includes("octet-stream")) {
    throw new Error("Bank of America activity response was not CSV");
  }
  if (kind === "pdf" && !contentType.includes("pdf") && !contentType.includes("octet-stream")) {
    throw new Error("Bank of America statement response was not PDF");
  }
  const body = browserNativeResponseBody(response);
  if (body.length < 16) throw new Error(`Bank of America ${kind.toUpperCase()} response was empty`);
  await writeFile(join(outputDir, filename), body);
}

async function fetchBankOfAmericaStatements(
  page: Page,
  accountDestination: string,
  from: string,
  through: string,
): Promise<BankOfAmericaStatementDocument[]> {
  const documents = new Map<string, BankOfAmericaStatementDocument>();
  for (const request of bankOfAmericaStatementIndexRequests(accountDestination, from, through)) {
    const response = await executeBankOfAmericaRequest(page, request);
    if (!browserNativeResponseOk(response)) {
      throw new Error(`Bank of America statement index failed with status ${response.status}`);
    }
    const contentType = response.headers["content-type"]?.toLowerCase() ?? "";
    if (!contentType.includes("json")) throw new Error("Bank of America statement index was not JSON");
    let body: { documentList?: unknown };
    try {
      body = JSON.parse(browserNativeResponseBody(response).toString("utf8")) as { documentList?: unknown };
    } catch {
      throw new Error("Bank of America statement index was not JSON");
    }
    if (!Array.isArray(body.documentList)) {
      throw new Error("Bank of America statement index omitted its document list");
    }
    for (const value of body.documentList) {
      if (!value || typeof value !== "object") continue;
      const statement = value as BankOfAmericaStatementDocument;
      if (!statement.adx || !statement.docId) continue;
      documents.set(`${statement.adx}:${statement.docId}`, statement);
    }
  }
  return [...documents.values()];
}

async function downloadBankOfAmericaDepositActivity(
  page: Page,
  outputDir: string,
  accountDestination: string,
  from: string,
  through: string,
  filename: string,
): Promise<void> {
  await saveBankOfAmericaArtifact(
    page,
    outputDir,
    filename,
    "csv",
    bankOfAmericaDepositActivityRequest(accountDestination, from, through),
  );
}

async function downloadBankOfAmericaStatement(
  page: Page,
  outputDir: string,
  statement: BankOfAmericaStatementDocument,
  filename: string,
): Promise<void> {
  await saveBankOfAmericaArtifact(
    page,
    outputDir,
    filename,
    "pdf",
    bankOfAmericaStatementDownloadRequest(statement),
  );
}

async function downloadBankOfAmericaCardActivity(
  page: Page,
  outputDir: string,
  target: string,
  accountPageUrl: string,
  filename: string,
): Promise<void> {
  await saveBankOfAmericaArtifact(
    page,
    outputDir,
    filename,
    "csv",
    bankOfAmericaCardActivityRequest(target, accountPageUrl),
  );
}

function buildBrowserProgram(
  config: BankOfAmericaSyncConfig,
  valid: ValidArtifact[],
  scope: BankOfAmericaSyncConfig["scope"],
): string {
  const checkingThrough = config.checkingThrough ?? config.through;
  const savingsThrough = config.savingsThrough ?? config.through;
  const cardThrough = config.cardThrough ?? config.through;
  const plan = {
    scope,
    existingFiles: valid.map(artifact => artifact.filename),
    accounts: config.accounts ?? [],
    defaults: {
      checking: { from: config.checkingFrom, through: checkingThrough },
      savings: { from: config.savingsFrom, through: savingsThrough },
      deposit: {
        from: config.checkingFrom < config.savingsFrom ? config.checkingFrom : config.savingsFrom,
        through: checkingThrough > savingsThrough ? checkingThrough : savingsThrough,
      },
      "credit-card": { from: config.cardFrom, through: cardThrough },
    },
  };

  return `async (page, reportProgress, bindings) => {
    const plan = ${JSON.stringify(plan)};
    const saved = [];
    const skipped = [];
    const monthNumbers = { Jan: "01", January: "01", Feb: "02", February: "02", Mar: "03", March: "03", Apr: "04", April: "04", May: "05", Jun: "06", June: "06", Jul: "07", July: "07", Aug: "08", August: "08", Sep: "09", September: "09", Oct: "10", October: "10", Nov: "11", November: "11", Dec: "12", December: "12" };

    const safeError = error => String(error && error.message || error)
      .replace(/https?:\\/\\/\\S+/g, "<redacted-url>")
      .replace(/\\b[a-f0-9]{20,}\\b/gi, "<redacted-id>")
      .replace(/\\b\\d{4,}\\b/g, "<digits>");
    const monthFromText = text => {
      const match = text.match(/\\b(January|February|March|April|May|June|July|August|September|October|November|December) Statement\\b/);
      if (!match) return null;
      const short = match[1].slice(0, 3);
      return monthNumbers[short];
    };
    const existingFiles = new Set(plan.existingFiles);
    const windowFor = account => plan.accounts.find(candidate =>
      candidate.kind === account.kind && candidate.last4 === account.last4
    ) || plan.defaults[account.kind];
    const accountPrefix = account => \`bofa-\${account.kind}-\${account.last4}\`;
    const accountIsSelected = account => {
      if (!plan.scope) return true;
      if (plan.scope === "card-activity" || plan.scope === "card-statements") {
        return account.kind === "credit-card";
      }
      return account.kind === plan.scope;
    };
    const wantsActivity = account => !plan.scope ||
      plan.scope === account.kind ||
      (plan.scope === "card-activity" && account.kind === "credit-card");
    const wantsStatements = account => !plan.scope ||
      plan.scope === account.kind ||
      (plan.scope === "card-statements" && account.kind === "credit-card");
    const apiDownloadDepositActivity = async (account, window) => {
      const filename = \`\${accountPrefix(account)}-\${window.from}-to-\${window.through}.csv\`;
      if (existingFiles.has(filename)) {
        skipped.push(filename);
        return;
      }
      reportProgress(\`Downloading Bank of America \${account.kind} activity ending in \${account.last4}\`);
      await bindings.downloadDepositActivity(
        page,
        account.destination,
        window.from,
        window.through,
        filename,
      );
      saved.push(filename);
    };
    const apiDownloadStatements = async (account, window) => {
      const documents = await bindings.fetchStatements(
        page,
        account.destination,
        window.from,
        window.through,
      );
      for (const statement of documents) {
        const statementDate = String(statement.date || "").slice(0, 10);
        const monthNumber = monthFromText(String(statement.docDisplayName || ""));
        if (!statementDate || !monthNumber || statementDate < window.from || statementDate > window.through) continue;
        const month = statementDate.slice(0, 4) + "-" + monthNumber;
        const filename = \`\${accountPrefix(account)}-\${month}-statement.pdf\`;
        if (existingFiles.has(filename)) {
          skipped.push(filename);
          continue;
        }
        reportProgress(\`Downloading Bank of America statement for account ending in \${account.last4}\`);
        await bindings.downloadStatement(page, statement, filename);
        saved.push(filename);
      }
    };
    const apiDownloadCardActivity = async (account, window) => {
      await bindings.openAccount(page, account.destination);
      const period = page.locator("#select_transaction").first();
      await period.waitFor({ state: "attached" });
      const periodOptions = await period.locator("option").evaluateAll(options => options.map(option => ({
        label: (option.textContent || "").trim(),
        value: option.value,
      })));
      const fileType = page.locator("#select_filetype").first();
      await fileType.waitFor({ state: "attached" });
      const excelFileTypeValue = await fileType.locator("option").evaluateAll(options => {
        const excel = options.find(option => /Microsoft Excel Format/i.test(option.textContent || ""));
        return excel ? excel.value : null;
      });
      if (!excelFileTypeValue) throw new Error("Bank of America Excel download format was not found");
      const jobs = bindings.buildCardActivityJobs(
        periodOptions,
        excelFileTypeValue,
        window.from,
        window.through,
        account.last4,
      );
      for (const job of jobs) {
        if (existingFiles.has(job.filename)) {
          skipped.push(job.filename);
          continue;
        }
        reportProgress(\`Downloading Bank of America card activity: \${job.label}\`);
        await bindings.downloadCardActivity(page, job.target, page.url(), job.filename);
        saved.push(job.filename);
      }
    };
    try {
      page.setDefaultTimeout(12000);
      await page.screencast.showActions({ position: "bottom-right", duration: 700, fontSize: 18 });
      const authenticated = page.url().startsWith("https://secure.bankofamerica.com/") && !await page.locator('input[type="password"]').count();
      if (!authenticated) {
        return JSON.stringify({
          status: "login-required",
          action: "Sign in to Bank of America and complete MFA. EasyMoney will continue automatically.",
        });
      }

      const accounts = (await bindings.discoverAccounts(page)).filter(accountIsSelected);
      if (accounts.length === 0) throw new Error("Bank of America did not expose any accounts for this sync");
      reportProgress(\`Discovered \${accounts.length} Bank of America account\${accounts.length === 1 ? "" : "s"}\`);
      for (const account of accounts) {
        const window = windowFor(account);
        await page.screencast.showChapter(\`Updating \${account.kind}\`, {
          description: \`Downloading data for the account ending in \${account.last4}.\`,
        });
        if (wantsActivity(account)) {
          if (account.kind === "credit-card") await apiDownloadCardActivity(account, window);
          else await apiDownloadDepositActivity(account, window);
        }
        if (wantsStatements(account)) await apiDownloadStatements(account, window);
      }

      return JSON.stringify({ status: "complete", scope: plan.scope, saved, skipped, accountCount: accounts.length });
    } catch (error) {
      return JSON.stringify({ status: "error", message: safeError(error), saved, skipped });
    }
  }`;
}

export async function runBankOfAmericaSync(
  config: BankOfAmericaSyncConfig,
  onProgress: (message: string) => void = () => {},
): Promise<{
  saved: string[];
  skipped: string[];
  artifacts: ValidArtifact[];
}> {
  await mkdir(config.outputDir, { recursive: true });
  const before = await validatedArtifacts(config.outputDir);
  if (config.dryRun)
    return { saved: [], skipped: before.map(artifact => artifact.filename), artifacts: before };

  const parsed = await runInstitutionBrowserProgram<{ scope: BankOfAmericaSyncConfig["scope"]; saved: string[]; skipped: string[] }>(
    { name: config.session, startUrl: loginUrl },
    buildBrowserProgram(config, before, config.scope),
    {
      completionDescription: "Bank of America downloads are complete.",
      isAuthenticated: isBankOfAmericaAuthenticatedPage,
      waitUntilAuthenticated: waitUntilBankOfAmericaAuthenticated,
      onProgress,
      programBindings: {
        buildCardActivityJobs: bankOfAmericaCardActivityJobs,
        discoverAccounts: discoverBankOfAmericaAccounts,
        downloadCardActivity: (
          page: Page,
          target: string,
          accountPageUrl: string,
          filename: string,
        ) => downloadBankOfAmericaCardActivity(page, config.outputDir, target, accountPageUrl, filename),
        downloadDepositActivity: (
          page: Page,
          accountDestination: string,
          from: string,
          through: string,
          filename: string,
        ) => downloadBankOfAmericaDepositActivity(
          page,
          config.outputDir,
          accountDestination,
          from,
          through,
          filename,
        ),
        downloadStatement: (
          page: Page,
          statement: BankOfAmericaStatementDocument,
          filename: string,
        ) => downloadBankOfAmericaStatement(page, config.outputDir, statement, filename),
        fetchStatements: fetchBankOfAmericaStatements,
        openAccount: openBankOfAmericaAccount,
      },
    },
  );
  if (parsed.status === "login-required")
    throw new Error(parsed.action ?? "Interactive login is required.");
  if (parsed.status !== "complete")
    throw new Error(parsed.message ?? "Bank of America automation did not complete.");

  const after = await validatedArtifacts(config.outputDir);
  const saved: string[] = [];
  const skipped = [...(parsed.skipped ?? [])];
  for (const filename of parsed.saved ?? []) {
    if (/^bofa-credit-card-.*\.csv$/i.test(filename)) {
      const text = await readFile(join(config.outputDir, filename), "utf8");
      if (!hasBankOfAmericaCreditCardActivity(text)) {
        skipped.push(`${filename} (no activity)`);
        continue;
      }
    }
    saved.push(filename);
  }
  return { saved, skipped, artifacts: after };
}
