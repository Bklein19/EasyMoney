import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

import parseVanguardStatement, {
  meta as vanguardStatementMeta,
} from '../../importParsers/moneyParsers/vanguard-statement-pdf.ts';
import { runInstitutionBrowserProgram } from '../browserSession.ts';

const LOGIN_URL = 'https://investor.vanguard.com/my-account/log-on';
const TRANSACTION_HISTORY_URL = 'https://www.vanguard.com/en/investor/portfolio/transactions/history';
const AUTHENTICATED_PATH_PATTERN = '^/en/investor/portfolio(?:/|$)';

export function isVanguardAuthenticatedPath(pathname: string): boolean {
  return new RegExp(AUTHENTICATED_PATH_PATTERN, 'i').test(pathname);
}

export type VanguardAccountKind = 'brokerage' | 'roth-ira' | 'traditional-ira';

export interface VanguardSyncAccount {
  accountId: number;
  accountKind: VanguardAccountKind;
  accountLast4: string;
  startDate: string;
  statementDates: string[];
}

export interface VanguardSyncProfile {
  id: string;
  session: string;
  accounts: VanguardSyncAccount[];
}

export interface VanguardSyncConfig {
  outputDir: string;
  through: string;
  profiles: VanguardSyncProfile[];
}

export interface VanguardDownloadedArtifact {
  fileName: string;
  accountId: number;
}

type ArtifactKind = 'csv' | 'pdf';

interface ArtifactJob {
  fileName: string;
  kind: ArtifactKind;
  accountId: number;
  accountKind: VanguardAccountKind;
  accountLast4: string;
  targetPath: string;
  startDate?: string;
  statementDate?: string;
}

function accountLabel(kind: VanguardAccountKind) {
  if (kind === 'roth-ira') return 'Roth-IRA';
  if (kind === 'traditional-ira') return 'Trad-IRA';
  return 'Brokerage';
}

function validateProfileId(value: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`Vanguard profile id must be a PII-free kebab-case label: ${value}`);
  }
}

async function validateCsv(path: string) {
  const data = await readFile(path);
  if (data.includes(0)) throw new Error(`${basename(path)} contains binary NUL bytes`);
  const lines = new TextDecoder().decode(data).split(/\r?\n/).filter(Boolean);
  const headerIndex = lines.findIndex(line => /date/i.test(line) && line.includes(','));
  if (headerIndex < 0) throw new Error(`${basename(path)} has no recognizable activity header`);
  const header = lines[headerIndex]!.toLowerCase();
  if (header.split(',').length < 10 || !['date', 'account', 'transaction', 'amount'].every(token => header.includes(token))) {
    throw new Error(`${basename(path)} does not match the observed Vanguard activity CSV shape`);
  }
}

async function validatePdf(path: string) {
  const data = await readFile(path);
  if (new TextDecoder().decode(data.subarray(0, 5)) !== '%PDF-') {
    throw new Error(`${basename(path)} does not have PDF magic`);
  }
  if (!vanguardStatementMeta.matches({ filename: basename(path), sample: '' })) {
    throw new Error(`${basename(path)} does not match EasyMoney's Vanguard statement filename pattern`);
  }
  const parsed = await parseVanguardStatement(path);
  if (parsed.balances.length === 0) throw new Error(`${basename(path)} has no Vanguard statement balance record`);
}

async function validateArtifact(path: string, kind: ArtifactKind) {
  if (extname(path).toLowerCase() !== `.${kind}`) throw new Error(`${basename(path)} has the wrong extension`);
  const info = await stat(path);
  const minimum = kind === 'pdf' ? 10_000 : 100;
  if (!info.isFile() || info.size < minimum) throw new Error(`${basename(path)} is smaller than the ${minimum}-byte minimum`);
  if (kind === 'pdf') await validatePdf(path);
  else await validateCsv(path);
}

async function isValid(path: string, kind: ArtifactKind) {
  try {
    await validateArtifact(path, kind);
    return true;
  } catch {
    return false;
  }
}

function jobsForProfile(config: VanguardSyncConfig, profile: VanguardSyncProfile): ArtifactJob[] {
  validateProfileId(profile.id);
  const jobs: ArtifactJob[] = [];
  for (const account of profile.accounts) {
    if (!/^\d{4}$/.test(account.accountLast4)) {
      throw new Error(`Vanguard account ${account.accountId} is missing a usable last four digits`);
    }
    const activityFileName = `vanguard-${profile.id}-${account.accountKind}-${account.startDate}-to-${config.through}-activity.csv`;
    jobs.push({
      fileName: activityFileName,
      kind: 'csv',
      accountId: account.accountId,
      accountKind: account.accountKind,
      accountLast4: account.accountLast4,
      startDate: account.startDate,
      targetPath: resolve(config.outputDir, activityFileName),
    });
    for (const statementDate of account.statementDates) {
      const fileName = `${statementDate}-${accountLabel(account.accountKind)}---${profile.id}.pdf`;
      jobs.push({
        fileName,
        kind: 'pdf',
        accountId: account.accountId,
        accountKind: account.accountKind,
        accountLast4: account.accountLast4,
        statementDate,
        targetPath: resolve(config.outputDir, fileName),
      });
    }
  }
  return jobs;
}

function browserProgram(through: string, activityJobs: ArtifactJob[], statementJobs: ArtifactJob[]) {
  return `async page => {
    const through = ${JSON.stringify(through)};
    const transactionHistoryUrl = ${JSON.stringify(TRANSACTION_HISTORY_URL)};
    const authenticatedPath = new RegExp(${JSON.stringify(AUTHENTICATED_PATH_PATTERN)}, 'i');
    const activityJobs = ${JSON.stringify(activityJobs)};
    const statementJobs = ${JSON.stringify(statementJobs)};

    const authenticationFields = await page.locator('input[type=password], input[autocomplete=username]').count() > 0;
    if (!authenticatedPath.test(new URL(page.url()).pathname) || authenticationFields) {
      return JSON.stringify({
        status: 'login-required',
        action: 'Sign in to Vanguard and complete MFA. EasyMoney will continue automatically.',
      });
    }

    const gotoVisibleLink = async (pattern, label) => {
      const links = await page.locator('a').filter({ hasText: pattern }).all();
      for (const link of links) {
        if (!(await link.isVisible())) continue;
        const href = await link.getAttribute('href');
        if (!href) continue;
        await page.goto(href);
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(500);
        return;
      }
      throw new Error(label + ' link is unavailable');
    };
    const clickAssociatedLabel = async input => {
      const id = await input.getAttribute('id');
      if (!id) throw new Error('Vanguard form control has no associated label');
      await page.locator('label[for="' + id + '"]').click();
    };
    const accountRow = input => input.locator('xpath=ancestor::*[self::tr or @role="row"][1]');
    const matchesKind = (text, kind) => kind === 'roth-ira'
      ? /roth/i.test(text) && /ira/i.test(text)
      : kind === 'traditional-ira'
        ? /traditional/i.test(text) && /ira/i.test(text)
        : /brokerage/i.test(text) && !/roth|traditional/i.test(text);
    const accountIndex = async (boxes, job) => {
      const kindMatches = [];
      for (let index = 0; index < await boxes.count(); index++) {
        const text = ((await accountRow(boxes.nth(index)).textContent()) || '').replace(/\\s+/g, ' ');
        if (text.includes(job.accountLast4)) return index;
        if (matchesKind(text, job.accountKind)) kindMatches.push(index);
      }
      if (kindMatches.length === 1) return kindMatches[0];
      throw new Error('Vanguard account ending in ' + job.accountLast4 + ' is not selectable in this login');
    };

    const downloaded = [];
    if (activityJobs.length) {
      await page.screencast.showChapter('Download Vanguard activity', {
        description: 'Downloading current account activity.', duration: 2500,
      });
      if (!(await page.locator('select[name=downloadDateOption]:visible').count())) {
        if (!new URL(page.url()).pathname.includes('/portfolio/transactions/history')) {
          await page.goto(transactionHistoryUrl, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(800);
        }
        if (!(await page.locator('select[name=downloadDateOption]:visible').count())) {
          const controls = await page.locator('a:visible, button:visible').all();
          let opened = false;
          for (const control of controls) {
            const label = [
              await control.textContent(),
              await control.getAttribute('aria-label'),
              await control.getAttribute('title'),
            ].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
            if (!/download center|download (?:transactions|activity)|^download$/i.test(label)) continue;
            await control.click();
            opened = true;
            break;
          }
          if (!opened) throw new Error('Vanguard activity download control is unavailable');
          for (let attempt = 0; attempt < 20 && !(await page.locator('select[name=downloadDateOption]:visible').count()); attempt++) {
            await page.waitForTimeout(500);
          }
        }
      }
      if (!(await page.locator('select[name=downloadDateOption]:visible').count())) {
        throw new Error('Vanguard activity download form did not open');
      }
      const boxes = page.locator('input[name=check-box]');
      for (let attempt = 0; attempt < 20 && await boxes.count() === 0; attempt++) await page.waitForTimeout(500);
      if (await boxes.count() === 0) throw new Error('Vanguard download accounts are unavailable');

      const radios = page.locator('input[name=download-option]');
      let csvRadio = null;
      for (let index = 0; index < await radios.count(); index++) {
        const radio = radios.nth(index);
        const id = await radio.getAttribute('id');
        const label = id ? ((await page.locator('label[for="' + id + '"]').textContent()) || '') : '';
        if (/csv/i.test(label)) csvRadio = radio;
      }
      if (!csvRadio) throw new Error('Vanguard CSV export option is unavailable');

      for (const job of activityJobs) {
        const selectedIndex = await accountIndex(boxes, job);
        for (let index = 0; index < await boxes.count(); index++) {
          const box = boxes.nth(index);
          if (await box.isChecked() !== (index === selectedIndex)) await clickAssociatedLabel(box);
        }
        if (!(await csvRadio.isChecked())) await clickAssociatedLabel(csvRadio);
        await page.locator('select[name=downloadDateOption]:visible').selectOption({ label: 'Custom' });
        await page.locator('input[name=fromDatePicker]:visible').fill(job.startDate);
        await page.locator('input[name=toDatePicker]:visible').fill(through);
        const button = page.getByRole('button', { name: /^download$/i }).last();
        await button.waitFor({ state: 'visible' });
        if (await button.isDisabled()) throw new Error('Vanguard Download button remained disabled after selecting account, format, and dates');
        const event = page.waitForEvent('download', { timeout: 60000 });
        await button.click();
        const download = await event;
        await download.saveAs(job.targetPath);
        const failure = await download.failure();
        if (failure) throw new Error('Vanguard activity download failed');
        downloaded.push(job.fileName);
      }
    }

    const unavailable = [];
    if (statementJobs.length) {
      await page.screencast.showChapter('Download Vanguard statements', {
        description: 'Downloading missing monthly statements.', duration: 2500,
      });
      const statementsReady = await page.locator('tbody tr').count() > 0 && await page.locator('#select-year-id').count() > 0;
      if (!statementsReady) {
        const buttons = await page.locator('button:visible').all();
        for (const button of buttons) {
          const label = (((await button.textContent()) || '') + ' ' + ((await button.getAttribute('aria-label')) || '')).toLowerCase();
          if (label.includes('statement') && label.includes('document')) { await button.click(); break; }
        }
        await gotoVisibleLink(/^Statements$/i, 'Statements');
      }
      const yearSelect = page.locator('#select-year-id:visible');
      for (const job of statementJobs) {
        const year = job.statementDate.slice(0, 4);
        if (await yearSelect.count()) await yearSelect.selectOption({ label: year }).catch(() => yearSelect.selectOption(year));
        await page.waitForTimeout(350);
        const displayDate = job.statementDate.slice(5).replace('-', '/') + '/' + year;
        const rows = page.locator('tbody tr');
        const dateMatches = [];
        for (let index = 0; index < await rows.count(); index++) {
          const row = rows.nth(index);
          const text = ((await row.textContent()) || '').replace(/\\s+/g, ' ');
          if (!text.includes(displayDate)) continue;
          dateMatches.push({ row, text });
        }
        const exactMatches = dateMatches.filter(candidate => candidate.text.includes(job.accountLast4));
        const kindMatches = dateMatches.filter(candidate => matchesKind(candidate.text, job.accountKind));
        const candidates = exactMatches.length > 0 ? exactMatches : kindMatches;
        if (candidates.length > 1) throw new Error('Multiple Vanguard statement rows matched one target');
        const match = candidates[0]?.row ?? null;
        if (!match) { unavailable.push(job.fileName); continue; }
        const icon = match.locator('c11n-icon[name=download]');
        if (await icon.count() !== 1) throw new Error('Vanguard statement download control is unavailable');
        const event = page.waitForEvent('download');
        await icon.click();
        const download = await event;
        await download.saveAs(job.targetPath);
        const failure = await download.failure();
        if (failure) throw new Error('Vanguard statement download failed');
        downloaded.push(job.fileName);
      }
    }
    return JSON.stringify({ status: 'complete', downloaded, unavailable });
  }`;
}

async function runProfile(config: VanguardSyncConfig, profile: VanguardSyncProfile) {
  const jobs = jobsForProfile(config, profile);
  const pending: ArtifactJob[] = [];
  for (const job of jobs) if (!(await isValid(job.targetPath, job.kind))) pending.push(job);
  if (pending.length === 0) return [];

  let result;
  try {
    result = await runInstitutionBrowserProgram<{ downloaded: string[]; unavailable: string[] }>(
      { name: profile.session, startUrl: LOGIN_URL },
      browserProgram(
        config.through,
        pending.filter(job => job.kind === 'csv'),
        pending.filter(job => job.kind === 'pdf'),
      ),
      { completionDescription: `Vanguard ${profile.id} downloads are complete.` },
    );
  } catch (error) {
    throw new Error(`Vanguard ${profile.id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (result.status === 'error') throw new Error(result.message ?? `Vanguard ${profile.id} sync failed`);
  if (result.status !== 'complete') throw new Error(`Vanguard ${profile.id} authentication did not complete`);

  const byName = new Map(jobs.map(job => [job.fileName, job]));
  const downloaded: VanguardDownloadedArtifact[] = [];
  for (const fileName of result.downloaded) {
    const job = byName.get(fileName);
    if (!job) throw new Error(`Vanguard returned an unplanned artifact: ${fileName}`);
    await validateArtifact(job.targetPath, job.kind);
    downloaded.push({ fileName, accountId: job.accountId });
  }
  return downloaded;
}

export async function runVanguardSync(config: VanguardSyncConfig) {
  await mkdir(config.outputDir, { recursive: true });
  const results = await Promise.all(config.profiles.map(profile => runProfile(config, profile)));
  return results.flat();
}
