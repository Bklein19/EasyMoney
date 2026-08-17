#!/usr/bin/env bun

import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import Papa from 'papaparse';
import { wellsFargoGenericActivityParser } from '../../../../server/app/importParsers/wellsFargoGenericActivity.ts';
import { pdfToText } from '../../../../server/app/importParsers/moneyParsers/_helpers.ts';
import { parseWellsFargoStatementText } from '../../../../server/app/importParsers/moneyParsers/wells-fargo-statement-pdf.ts';
import { wellsFargoStatementParser } from '../../../../server/app/importParsers/wellsFargoStatement.ts';
import { runPlaywrightCode } from '../../../../server/app/dataSync/browserSession.ts';

const DEFAULT_OUTPUT = '/private/tmp/easymoney-wells-fargo-catchup';
const LOGIN_URL = 'https://connect.secure.wellsfargo.com/auth/login/present';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATEMENT = /^wells-fargo-(checking|autograph-visa|platinum-card)-statement-(\d{4}-\d{2}-\d{2})\.pdf$/i;

type Kind = 'checking' | 'autograph-visa' | 'platinum-card';
type Account = { kind: Kind; label: RegExp; activity: string };
type Activity = { account: Account; path: string };
type Statement = { account: Account; date: string; path: string };
type Options = { from: string; to: string; output: string; session: string; clean: boolean; validateOnly: boolean };

const ACCOUNTS: Account[] = [
  { kind: 'checking', label: /checking/i, activity: 'wells-fargo-checking.csv' },
  { kind: 'autograph-visa', label: /autograph visa/i, activity: 'wells-fargo-autograph-visa.csv' },
  { kind: 'platinum-card', label: /platinum card/i, activity: 'wells-fargo-platinum-card.csv' },
];

function args(argv: string[]): Options {
  const values = new Map<string, string>();
  let clean = false;
  let validateOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--clean-run') { clean = true; continue; }
    if (arg === '--validate-only') { validateOnly = true; continue; }
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: bun .codex/skills/update-finance-data/scripts/wells-fargo.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--output PATH] [--session NAME] [--clean-run] [--validate-only]');
      process.exit(0);
    }
    if (!arg.startsWith('--') || !argv[i + 1] || argv[i + 1]!.startsWith('--')) throw new Error(`Invalid argument: ${arg}`);
    values.set(arg, argv[++i]!);
  }
  const from = values.get('--from') ?? '2026-05-29';
  const to = values.get('--to') ?? new Date().toISOString().slice(0, 10);
  if (!DATE.test(from) || !DATE.test(to) || from > to) throw new Error('Expected ordered YYYY-MM-DD dates');
  return { from, to, output: resolve(values.get('--output') ?? DEFAULT_OUTPUT), session: values.get('--session') ?? 'wells-fargo-catchup', clean, validateOnly };
}

function safe(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/https?:\/\/\S+/g, '[url]').replace(/\$[\d,]+(?:\.\d{2})?/g, '[amount]')
    .replace(/\b\d{4,}\b/g, '[number]').slice(0, 1_000);
}

function activities(output: string): Activity[] {
  return ACCOUNTS.map(account => ({ account, path: resolve(output, account.activity) }));
}

function statementFromPath(path: string): Statement | null {
  const match = basename(path).match(STATEMENT);
  if (!match) return null;
  const account = ACCOUNTS.find(candidate => candidate.kind === match[1]!.toLowerCase());
  return account ? { account, date: match[2]!, path } : null;
}

async function statements(output: string): Promise<Statement[]> {
  return (await readdir(output).catch(() => []))
    .map(file => statementFromPath(resolve(output, file)))
    .filter((value): value is Statement => value !== null)
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function validateActivity(artifact: Activity) {
  if (extname(artifact.path).toLowerCase() !== '.csv') throw new Error(`${basename(artifact.path)} has wrong extension`);
  const info = await stat(artifact.path);
  if (!info.isFile() || info.size < 32) throw new Error(`${basename(artifact.path)} is empty`);
  const text = await Bun.file(artifact.path).text();
  if (text.includes('\0')) throw new Error(`${basename(artifact.path)} contains binary data`);
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const headers = parsed.meta.fields ?? [];
  if (!wellsFargoGenericActivityParser.matches({ fileName: basename(artifact.path), headers, sample: text.slice(0, 2048) })) throw new Error(`${basename(artifact.path)} does not match Wells Fargo activity parser`);
  const result = await wellsFargoGenericActivityParser.parse({ fileName: basename(artifact.path), headers, rows: parsed.data, text, filePath: artifact.path });
  const transactions = result.transactions.filter(Boolean).length;
  if (!transactions) throw new Error(`${basename(artifact.path)} has no posted transactions`);
  return { bytes: info.size, transactions };
}

async function validateStatement(artifact: Statement) {
  const info = await stat(artifact.path);
  if (extname(artifact.path).toLowerCase() !== '.pdf' || !info.isFile() || info.size < 100) throw new Error(`${basename(artifact.path)} is not a valid PDF artifact`);
  const bytes = new Uint8Array(await Bun.file(artifact.path).slice(0, 5).arrayBuffer());
  if (new TextDecoder('ascii').decode(bytes) !== '%PDF-') throw new Error(`${basename(artifact.path)} is not a PDF`);
  const text = await pdfToText(artifact.path, true);
  if (!wellsFargoStatementParser.matches({ fileName: basename(artifact.path), headers: [], sample: text.slice(0, 8192) })) throw new Error(`${basename(artifact.path)} does not match Wells Fargo statement parser`);
  // The persisted name omits account numbers. The parser needs a statement date
  // in its filename, so this normalized path exists only during validation.
  const normalizedPath = `wells-fargo-${artifact.account.kind}-0000-${artifact.date}.pdf`;
  const result = parseWellsFargoStatementText(text, normalizedPath);
  const accountPattern = artifact.account.kind === 'checking' ? /^Checking - \d{4}$/ : artifact.account.kind === 'autograph-visa' ? /^Autograph Visa - \d{4}$/ : /^Platinum Card - \d{4}$/;
  if (!result.balances.length || result.balances.some(balance => !accountPattern.test(balance.account))) throw new Error(`${basename(artifact.path)} has no matching balance anchor`);
  return { bytes: info.size, transactions: result.transactions.length, balances: result.balances.length };
}

function browserProgram(options: Options, activityJobs: Activity[], existing: Statement[]): string {
  const plan = ACCOUNTS.map(account => ({
    kind: account.kind,
    pattern: account.label.source,
    activityPath: activityJobs.find(job => job.account.kind === account.kind)?.path ?? null,
    from: options.from,
    to: options.to,
    existing: existing.filter(file => file.account.kind === account.kind).map(file => basename(file.path)),
  }));
  return `async page => {
    const plan = ${JSON.stringify(plan)};
    const output = { activities: [], statements: [] };
    const mmdd = date => { const [year, month, day] = date.split('-'); return month + '/' + day + '/' + year; };
    const isoDate = value => {
      const numeric = value.match(/(\\d{1,2})[\\/-](\\d{1,2})[\\/-](\\d{2}|\\d{4})/);
      if (numeric) { const year = numeric[3].length === 2 ? '20' + numeric[3] : numeric[3]; return year + '-' + numeric[1].padStart(2, '0') + '-' + numeric[2].padStart(2, '0'); }
      const named = value.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\\s+(\\d{1,2}),?\\s+(\\d{4})/i);
      if (!named) return null;
      const month = { january:'01', february:'02', march:'03', april:'04', may:'05', june:'06', july:'07', august:'08', september:'09', october:'10', november:'11', december:'12' }[named[1].toLowerCase()];
      return named[3] + '-' + month + '-' + named[2].padStart(2, '0');
    };
    const saveBase64 = async (base64, fileName, path, mimeType) => {
      const downloadPromise = page.waitForEvent('download');
      await page.evaluate(({ base64, fileName, mimeType }) => { const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)); const url = URL.createObjectURL(new Blob([bytes], { type: mimeType })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }, { base64, fileName, mimeType });
      await (await downloadPromise).saveAs(path);
    };
    const openAccount = async item => {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      if (/login|signin|sign-on|securelogout/i.test(await page.url()) || await page.locator('input[type=password]').count()) return false;
      let summary = page.getByRole('link', { name: 'Account Summary', exact: true });
      if (await summary.count() === 0 && await page.getByRole('heading', { name: 'Account Summary', exact: true }).count() === 0) {
        await page.goBack();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.getByRole('heading', { name: 'Account Summary', exact: true }).waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
        summary = page.getByRole('link', { name: 'Account Summary', exact: true });
      }
      if (await summary.count() === 1) {
        await summary.click();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
      } else if (await page.getByRole('heading', { name: 'Account Summary', exact: true }).count() !== 1) {
        return false;
      }
      await page.getByRole('heading', { name: 'Account Summary', exact: true }).waitFor({ state: 'visible', timeout: 15000 });
      const matches = page.getByRole('link').filter({ hasText: new RegExp(item.pattern, 'i') }).filter({ hasText: /Account number ending in/i });
      await matches.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      if (await matches.count() !== 1) throw new Error('Expected exactly one Wells Fargo account match for ' + item.kind);
      await matches.first().click();
      return true;
    };
    for (const item of plan) {
      if (!await openAccount(item)) return JSON.stringify({ status: 'auth-required' });
      if (item.activityPath) {
        await page.getByRole('button', { name: 'Download Account Activity' }).click();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        const boxes = page.getByRole('textbox', { name: /MM\\/DD\\/YYYY/i });
        await boxes.nth(1).waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
        if (await boxes.count() !== 2) throw new Error('Wells Fargo activity date controls unavailable');
        await page.evaluate(({ from, to }) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          const assign = (name, value) => {
            const input = document.querySelector('input[name="' + name + '"]');
            if (!(input instanceof HTMLInputElement) || !setter) throw new Error('Wells Fargo activity date input unavailable');
            setter.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          };
          assign('fromDate', from); assign('toDate', to);
        }, { from: mmdd(item.from), to: mmdd(item.to) });
        const csv = page.getByRole('radio', { name: /CSV/i });
        if (await csv.count() === 1 && !(await csv.isChecked())) await csv.check();
        const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
        await page.getByTestId('download-button').click();
        await (await downloadPromise).saveAs(item.activityPath);
        output.activities.push(item.kind);
      }
      if (!await openAccount(item)) return JSON.stringify({ status: 'auth-required' });
      const statements = page.getByRole('link', { name: 'View Statements', exact: true });
      await statements.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      if (await statements.count() !== 1) throw new Error('Wells Fargo statement link unavailable for ' + item.kind);
      await statements.click(); await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(1500);
      const links = await page.locator('a').evaluateAll(anchors => anchors.map((anchor, index) => ({ index, href: anchor.getAttribute('href') || '', text: (anchor.textContent || '').replace(/\\s+/g, ' ').trim() })));
      const allDated = links.map(link => ({ ...link, date: isoDate(link.text + ' ' + link.href) })).filter(link => link.date).sort((left, right) => left.date.localeCompare(right.date));
      const dated = allDated.filter(link => link.date >= item.from && link.date <= item.to);
      const opening = allDated.filter(link => link.date < item.from).at(-1);
      if (opening) dated.unshift(opening);
      if (!dated.length) throw new Error('No dated Wells Fargo statements available for ' + item.kind);
      const seen = new Set();
      for (const link of dated) {
        if (seen.has(link.date)) throw new Error('Ambiguous Wells Fargo statement date for ' + item.kind);
        seen.add(link.date);
        const fileName = 'wells-fargo-' + item.kind + '-statement-' + link.date + '.pdf';
        if (item.existing.includes(fileName)) continue;
        const targetPath = ${JSON.stringify(options.output)} + '/' + fileName;
        const responsePromise = page.waitForResponse(response => response.url().includes('/edocs/documents/retrieve/') && (response.headers()['content-type'] || '').toLowerCase().includes('application/pdf'), { timeout: 15000 });
        await page.locator('a').nth(link.index).dispatchEvent('click');
        const response = await responsePromise;
        const documentResponse = await page.context().request.get(response.url()); const body = await documentResponse.body();
        if (!documentResponse.ok() || body.length < 100 || String.fromCharCode(...body.subarray(0, 5)) !== '%PDF-') {
          throw new Error('Wells Fargo statement response failed PDF validation: status=' + documentResponse.status() + ' type=' + (documentResponse.headers()['content-type'] || 'missing') + ' bytes=' + body.length + ' magic=' + (String.fromCharCode(...body.subarray(0, 5)) === '%PDF-' ? 'pdf' : 'other'));
        }
        await saveBase64(body.toString('base64'), fileName, targetPath, 'application/pdf');
        output.statements.push(item.kind);
      }
    }
    return JSON.stringify({ status: 'complete', downloaded: output });
  }`;
}

async function main(): Promise<void> {
  const options = args(Bun.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  const activityFiles = activities(options.output);
  if (options.clean) {
    for (const file of activityFiles) await unlink(file.path).catch(() => {});
    for (const file of await statements(options.output)) await unlink(file.path).catch(() => {});
  }
  const started = performance.now();
  const existingStatements = await statements(options.output);
  const validStatements: Statement[] = [];
  for (const file of existingStatements) if (await validateStatement(file).then(() => true).catch(() => false)) validStatements.push(file);
  const validActivities = new Set<string>();
  for (const file of activityFiles) if (await validateActivity(file).then(() => true).catch(() => false)) validActivities.add(file.path);
  const activityJobs = activityFiles.filter(file => !validActivities.has(file.path));
  if (!options.validateOnly) {
    const result = await runPlaywrightCode({ name: options.session, startUrl: LOGIN_URL }, browserProgram(options, activityJobs, validStatements));
    if (!/status.*complete/.test(result)) {
      if (/auth-required/.test(result)) throw new Error(`Authentication required in headed session ${options.session}`);
      throw new Error(`Wells Fargo Playwright run did not complete: ${safe(result)}`);
    }
  }
  const finalStatements = await statements(options.output);
  const statementSummaries = [];
  for (const account of ACCOUNTS) {
    const files = finalStatements.filter(file => file.account.kind === account.kind);
    if (!files.length) throw new Error(`No Wells Fargo statement artifact for ${account.kind}`);
    for (const file of files) statementSummaries.push({ file: basename(file.path), ...(await validateStatement(file)) });
  }
  const activitySummaries = [];
  for (const file of activityFiles) activitySummaries.push({ file: basename(file.path), ...(await validateActivity(file)) });
  console.log(JSON.stringify({ status: 'ready', from: options.from, to: options.to, artifactCount: activitySummaries.length + statementSummaries.length, artifactTypes: ['csv', 'pdf'], downloadedActivity: activityJobs.length, validatedStatementsBeforeRun: validStatements.length, statementCount: statementSummaries.length, elapsedMs: Math.round(performance.now() - started), activities: activitySummaries, statements: statementSummaries }));
}

main().catch(error => { console.error(safe(error)); process.exit(1); });
