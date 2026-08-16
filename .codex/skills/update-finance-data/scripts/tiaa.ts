import { mkdir } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

import type { BrowserContext, Locator, Page } from 'playwright';

import parseActivity from '../../../../server/app/importParsers/moneyParsers/tiaa-activity-csv.ts';
import parseStatement, { meta as statementMeta } from '../../../../server/app/importParsers/moneyParsers/tiaa-statement-pdf.ts';
import { waitForInteractiveAuthentication, withPlaywrightPage } from './playwrightSession.ts';

type Kind = 'csv' | 'pdf';
type Artifact = { fileName: string; kind: Kind; path: string };
type Options = {
  from: string;
  output: string;
  probeOnly: boolean;
  statementsOnly: boolean;
  to: string;
  validateOnly: boolean;
};

const SESSION_NAME = 'tiaa-catchup';
const HOME_URL = 'https://my.tiaa.org/private/participant/home';
const DEFAULT_OUTPUT = '/private/tmp/easymoney-tiaa-catchup';
const DEFAULT_FROM = '2026-01-01';
const DEFAULT_TO = new Date().toISOString().slice(0, 10);
const AUTHENTICATION_TIMEOUT_MS = 10 * 60_000;

function option(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return Bun.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function iso(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
}

export function quarterEnds(from: string, to: string): Array<{ date: string; quarter: number; year: number }> {
  const result: Array<{ date: string; quarter: number; year: number }> = [];
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
    for (const [month, quarter] of [[3, 1], [6, 2], [9, 3], [12, 4]] as const) {
      const date = `${year}-${String(month).padStart(2, '0')}-${month === 3 || month === 12 ? '31' : '30'}`;
      if (date >= from && date <= to) result.push({ date, quarter, year });
    }
  }
  return result;
}

export function activityPeriodLabel(from: string, to: string, currentYear = new Date().getFullYear()): string {
  const fromYear = Number(from.slice(0, 4));
  const toYear = Number(to.slice(0, 4));
  if (fromYear !== toYear) throw new Error('TIAA activity downloads must be requested one calendar year at a time');
  if (fromYear === currentYear) return 'Current year';
  if (fromYear >= currentYear - 2 && fromYear < currentYear) return String(fromYear);
  throw new Error(`TIAA Quick Download does not offer activity for ${fromYear}`);
}

export function statementDocumentLabel(artifact: Artifact): string {
  const match = artifact.fileName.match(/tiaa-(\d{4})-\d{2}-\d{2}-retirement-q(\d)-/);
  if (!match) throw new Error(`Invalid TIAA statement filename: ${artifact.fileName}`);
  return `RETIREMENT Q${match[2]}/${match[1]}`;
}

function artifacts(output: string, from: string, to: string): Artifact[] {
  const result: Artifact[] = [{
    fileName: `tiaa-retirement-annuity-${from}-to-${to}.csv`,
    kind: 'csv',
    path: resolve(output, `tiaa-retirement-annuity-${from}-to-${to}.csv`),
  }];
  for (const item of quarterEnds(from, to)) {
    const fileName = `tiaa-${item.date}-retirement-q${item.quarter}-${item.year}-0000.pdf`;
    result.push({ fileName, kind: 'pdf', path: resolve(output, fileName) });
  }
  return result;
}

async function validate(artifact: Artifact): Promise<void> {
  const file = Bun.file(artifact.path);
  if (!(await file.exists()) || file.size < (artifact.kind === 'pdf' ? 10_000 : 100)) {
    throw new Error(`Invalid ${artifact.kind} artifact: ${artifact.fileName}`);
  }
  if (extname(artifact.path).toLowerCase() !== `.${artifact.kind}`) throw new Error(`Invalid extension: ${artifact.fileName}`);
  const bytes = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  if (artifact.kind === 'csv') {
    const text = new TextDecoder().decode(bytes);
    if (bytes.includes(0) || !text.includes('Date,AccountId,Action,Security,Price,Quantity,Amount,Text,Memo,Commission')) {
      throw new Error(`TIAA CSV shape mismatch: ${artifact.fileName}`);
    }
    const parsed = await parseActivity(artifact.path);
    if (!parsed.transactions.length) throw new Error(`TIAA CSV has no activity rows: ${artifact.fileName}`);
    return;
  }
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error(`TIAA PDF signature mismatch: ${artifact.fileName}`);
  if (!statementMeta.matches({ filename: basename(artifact.path), sample: '' })) throw new Error(`TIAA PDF filename mismatch: ${artifact.fileName}`);
  const parsed = await parseStatement(artifact.path);
  if (!parsed.balances.length) throw new Error(`TIAA PDF has no balance: ${artifact.fileName}`);
}

async function isValid(artifact: Artifact): Promise<boolean> {
  try {
    await validate(artifact);
    return true;
  } catch {
    return false;
  }
}

async function settle(page: Page, milliseconds = 2_000): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('load').catch(() => {});
  await page.waitForTimeout(milliseconds);
}

async function isLoginPage(page: Page): Promise<boolean> {
  return /login|signin|authenticate|auth\./i.test(page.url().split('?')[0])
    || await page.locator('input[type="password"], input[autocomplete="username"]').count() > 0;
}

async function authenticate(page: Page): Promise<void> {
  await page.goto(HOME_URL, { waitUntil: 'commit' });
  await settle(page);
  if (!await isLoginPage(page)) return;
  console.log(`Authentication required in ${SESSION_NAME}. Complete login and MFA in the open browser.`);
  await waitForInteractiveAuthentication(page, Date.now() + AUTHENTICATION_TIMEOUT_MS);
  await page.goto(HOME_URL, { waitUntil: 'commit' });
  await settle(page);
  if (await isLoginPage(page)) throw new Error('TIAA authentication did not complete');
}

async function navigationLinks(page: Page): Promise<Array<{ href: string }>> {
  return await page.locator('a').evaluateAll(items => items
    .map(anchor => ({ href: (anchor as HTMLAnchorElement).href }))
    .filter(item => item.href));
}

async function chooseComboboxOption(combobox: Locator, page: Page, label: string): Promise<void> {
  if (await combobox.evaluate(element => element.tagName === 'SELECT')) {
    await combobox.selectOption({ label });
  } else {
    await combobox.click();
    await page.getByRole('option', { name: label, exact: true }).click();
  }
}

async function downloadActivity(page: Page, target: Artifact, options: Options): Promise<void> {
  const links = await navigationLinks(page);
  const activityLink = links.find(link => /participantdata\/quickendownload/i.test(link.href));
  if (!activityLink) throw new Error('TIAA Quick Download control was not found');
  await page.goto(activityLink.href, { waitUntil: 'commit' });
  await settle(page, 5_000);
  if (await isLoginPage(page)) throw new Error('TIAA authentication expired before activity download');

  const checkboxes = page.locator('input[type="checkbox"]');
  let accountCount = 0;
  for (let index = 0; index < await checkboxes.count(); index++) {
    const checkbox = checkboxes.nth(index);
    const label = await checkbox.evaluate(element => [...((element as HTMLInputElement).labels ?? [])]
      .map(item => item.textContent ?? '').join(' '));
    if (/download to csv/i.test(label)) continue;
    await checkbox.check();
    accountCount += 1;
  }
  if (!accountCount) throw new Error('TIAA Quick Download exposed no account selection');

  const period = page.getByRole('combobox').first();
  if (!await period.count()) throw new Error('TIAA Quick Download period control was not found');
  await chooseComboboxOption(period, page, activityPeriodLabel(options.from, options.to));

  const csv = page.getByRole('checkbox', { name: /Download to CSV/i });
  if (!await csv.count()) throw new Error('TIAA CSV download option was not found');
  await csv.check();

  const downloadButton = page.getByRole('button', { name: /^Download$/i });
  if (!await downloadButton.count()) throw new Error('TIAA Download button was not found');
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await downloadButton.click();
  const download = await downloadPromise;
  await download.saveAs(target.path);
  const failure = await download.failure();
  if (failure) throw new Error('TIAA activity download failed');
}

async function selectStatementYear(page: Page, year: string): Promise<void> {
  const filter = page.getByRole('combobox').first();
  if (!await filter.count()) throw new Error('TIAA statement date filter was not found');
  if ((await filter.textContent())?.trim() !== year) {
    await chooseComboboxOption(filter, page, year);
    await page.waitForTimeout(1_000);
  }
}

async function expandStatements(page: Page): Promise<void> {
  const accordion = page.getByRole('button', { name: /^Statements$/i });
  if (!await accordion.count()) throw new Error('TIAA statements accordion was not found');
  if (await accordion.getAttribute('aria-expanded') !== 'true') await accordion.click();
}

async function downloadStatement(page: Page, context: BrowserContext, target: Artifact): Promise<void> {
  const label = statementDocumentLabel(target);
  const year = label.slice(-4);
  await selectStatementYear(page, year);
  await expandStatements(page);

  const row = page.locator('tr:visible').filter({ hasText: label }).first();
  if (!await row.count()) throw new Error(`Requested TIAA statement is unavailable: ${label}`);
  const view = row.getByText('View', { exact: true });
  if (!await view.count()) throw new Error(`TIAA statement View control is unavailable: ${label}`);

  const popupPromise = page.waitForEvent('popup', { timeout: 30_000 });
  await view.evaluate(element => (element as HTMLElement).click());
  const popup = await popupPromise;
  try {
    await popup.waitForURL(url => url.protocol === 'https:', { timeout: 30_000 });
    const response = await context.request.get(popup.url());
    const body = await response.body();
    if (!response.ok() || body.length < 10_000 || body.subarray(0, 5).toString() !== '%PDF-') {
      throw new Error(`TIAA statement response failed validation: ${label}`);
    }
    await Bun.write(target.path, body);
  } finally {
    await popup.close().catch(() => {});
  }
}

async function downloadStatements(page: Page, context: BrowserContext, targets: Artifact[]): Promise<void> {
  const links = await navigationLinks(page);
  const statementLink = links.find(link => /account-statements/i.test(link.href));
  if (!statementLink) throw new Error('TIAA statements control was not found');
  await page.goto(statementLink.href, { waitUntil: 'commit' });
  await settle(page, 4_000);
  for (const target of targets) await downloadStatement(page, context, target);
}

async function probeContract(page: Page): Promise<void> {
  const links = await navigationLinks(page);
  console.log(JSON.stringify({
    status: 'observed',
    activityLink: links.some(link => /participantdata\/quickendownload/i.test(link.href)),
    statementLink: links.some(link => /account-statements/i.test(link.href)),
  }));
}

function parseOptions(): Options {
  const from = option('from', DEFAULT_FROM);
  const to = option('to', DEFAULT_TO);
  iso(from, 'from');
  iso(to, 'to');
  if (from > to) throw new Error('from must not be after to');
  return {
    from,
    to,
    output: resolve(option('output-dir', DEFAULT_OUTPUT)),
    validateOnly: Bun.argv.includes('--validate-only'),
    probeOnly: Bun.argv.includes('--probe-contract'),
    statementsOnly: Bun.argv.includes('--statements-only'),
  };
}

async function main(): Promise<void> {
  const options = parseOptions();
  await mkdir(options.output, { recursive: true });
  const expected = artifacts(options.output, options.from, options.to)
    .filter(artifact => !options.statementsOnly || artifact.kind === 'pdf');
  const started = performance.now();

  if (!options.validateOnly) {
    const requested: Artifact[] = [];
    for (const artifact of expected) if (!await isValid(artifact)) requested.push(artifact);
    if (options.probeOnly || requested.length) {
      await withPlaywrightPage({ name: SESSION_NAME, startUrl: HOME_URL }, async (page, context) => {
        await authenticate(page);
        if (options.probeOnly) return await probeContract(page);
        const activity = requested.find(artifact => artifact.kind === 'csv');
        if (activity) await downloadActivity(page, activity, options);
        const statements = requested.filter(artifact => artifact.kind === 'pdf');
        if (statements.length) await downloadStatements(page, context, statements);
      });
    }
  }

  if (!options.probeOnly) {
    for (const artifact of expected) await validate(artifact);
    console.log(JSON.stringify({
      status: 'ready',
      artifacts: expected.length,
      csv: expected.filter(artifact => artifact.kind === 'csv').length,
      pdf: expected.filter(artifact => artifact.kind === 'pdf').length,
      elapsedMs: Math.round(performance.now() - started),
    }));
  }
}

if (import.meta.main) await main();
