import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

import parseVanguardStatement, {
  meta as vanguardStatementMeta,
} from '../../../../server/app/importParsers/moneyParsers/vanguard-statement-pdf.ts';
import { runPlaywrightCode } from '../../../../server/app/dataSync/browserSession.ts';

const LOGIN_URL = 'https://investor.vanguard.com/my-account/log-on';
const HOME_DIR = Bun.env.HOME;
if (!HOME_DIR) throw new Error('HOME is required');
const DEFAULT_OUTPUT_DIR = resolve(HOME_DIR, 'Downloads/easymoney-imports/2026-08-12');
const DEFAULT_THROUGH = '2026-08-13';

type ArtifactKind = 'csv' | 'pdf';

type Artifact = {
  fileName: string;
  kind: ArtifactKind;
};

type ActivityJob = Artifact & {
  accountKind: 'brokerage' | 'roth-ira';
  startDate: string;
  targetPath: string;
};

type StatementJob = Artifact & {
  accountKind: 'brokerage' | 'roth-ira';
  statementDate: string;
  targetPath: string;
};

function option(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return Bun.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function assertIsoDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be an ISO date (YYYY-MM-DD)`);
  }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function parseSessionJson<T>(result: string): T {
  const safeErrors = [
    'Activity link is unavailable',
    'Download Center link is unavailable',
    'Expected exactly two current Vanguard download-account rows',
    'The requested Vanguard account type is not selectable',
    'Vanguard CSV export option is unavailable',
    'Vanguard activity download failed',
    'Statements link is unavailable',
    'Multiple Vanguard statement rows matched one target',
    'A required Vanguard statement row is unavailable',
    'Vanguard statement download control is unavailable',
    'Vanguard statement download failed',
  ];
  const safeError = safeErrors.find(message => result.includes(message));
  if (safeError) throw new Error(safeError);

  const candidates = [result.trim(), ...result.split('\n').map(line => line.trim()).reverse()];
  for (const candidate of candidates) {
    try {
      const decoded = JSON.parse(candidate) as string | T;
      return typeof decoded === 'string' ? JSON.parse(decoded) as T : decoded;
    } catch {
      // Browser programs may return a JSON string or a serialized JSON string.
    }
  }
  throw new Error('Playwright session returned no parseable JSON result');
}

async function validateCsv(path: string): Promise<void> {
  const data = await readFile(path);
  if (data.includes(0)) throw new Error(`${basename(path)} contains binary NUL bytes`);
  const text = decode(data);
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headerIndex = lines.findIndex(line => /date/i.test(line) && line.includes(','));
  if (headerIndex < 0) throw new Error(`${basename(path)} has no recognizable activity header`);
  const header = lines[headerIndex]!.toLowerCase();
  const required = ['date', 'account', 'transaction', 'amount'];
  if (header.split(',').length < 10 || !required.every(token => header.includes(token))) {
    throw new Error(`${basename(path)} does not match the observed Vanguard activity CSV shape`);
  }
  if (lines.length <= headerIndex + 1) throw new Error(`${basename(path)} contains no activity rows`);
}

async function validatePdf(path: string): Promise<void> {
  const data = await readFile(path);
  if (decode(data.subarray(0, 5)) !== '%PDF-') {
    throw new Error(`${basename(path)} does not have PDF magic`);
  }
  if (!vanguardStatementMeta.matches({ filename: basename(path), sample: '' })) {
    throw new Error(`${basename(path)} does not match EasyMoney's Vanguard statement filename pattern`);
  }
  const parsed = await parseVanguardStatement(path);
  if (parsed.balances.length === 0) {
    throw new Error(`${basename(path)} has no Vanguard statement balance record`);
  }
}

async function validateArtifact(path: string, kind: ArtifactKind): Promise<number> {
  if (extname(path).toLowerCase() !== `.${kind}`) {
    throw new Error(`${basename(path)} has the wrong extension`);
  }
  const info = await stat(path);
  const minimum = kind === 'pdf' ? 10_000 : 100;
  if (!info.isFile() || info.size < minimum) {
    throw new Error(`${basename(path)} is smaller than the ${minimum}-byte minimum`);
  }
  if (kind === 'pdf') await validatePdf(path);
  else await validateCsv(path);
  return info.size;
}

async function isValid(path: string, kind: ArtifactKind): Promise<boolean> {
  try {
    await validateArtifact(path, kind);
    return true;
  } catch {
    return false;
  }
}

function browserProgram(activityJobs: ActivityJob[], statementJobs: StatementJob[]): string {
  return `async page => {
    const activityJobs = ${JSON.stringify(activityJobs)};
    const statementJobs = ${JSON.stringify(statementJobs)};

    const onLoginPath = await page.evaluate(() => /log-on|login|signin/i.test(location.pathname));
    if (onLoginPath) return JSON.stringify({ status: 'auth-required' });

    const gotoVisibleLink = async (pattern, label) => {
      const links = await page.locator('a').filter({ hasText: pattern }).all();
      for (const link of links) {
        if (!(await link.isVisible())) continue;
        const href = await link.getAttribute('href');
        if (!href) continue;
        await page.goto(href);
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(800);
        return;
      }
      throw new Error(label + ' link is unavailable');
    };

    const clickAssociatedLabel = async input => {
      const id = await input.getAttribute('id');
      if (!id) throw new Error('Vanguard form control has no associated label');
      await page.locator('label[for="' + id + '"]').click();
    };

    const downloadedActivity = [];
    if (activityJobs.length) {
      if (!(await page.locator('select[name=downloadDateOption]:visible').count())) {
        if (!(await page.locator('a').filter({ hasText: /Download center/i }).count())) {
          await gotoVisibleLink(/^Activity$/i, 'Activity');
        }
        await gotoVisibleLink(/Download center/i, 'Download Center');
      }

      const accountBoxes = page.locator('input[name=check-box]');
      for (let attempt = 0; attempt < 20 && await accountBoxes.count() !== 2; attempt++) {
        await page.waitForTimeout(500);
      }
      if (await accountBoxes.count() !== 2) {
        throw new Error('Expected exactly two current Vanguard download-account rows');
      }

      const accountIndex = async kind => {
        for (let index = 0; index < await accountBoxes.count(); index++) {
          const box = accountBoxes.nth(index);
          const row = box.locator('xpath=ancestor::*[self::tr or @role="row"][1]');
          const text = ((await row.textContent()) || '').toLowerCase();
          if (kind === 'roth-ira' && /roth/.test(text) && /ira/.test(text)) return index;
          if (kind === 'brokerage' && /brokerage/.test(text) && !/roth|traditional/.test(text)) return index;
        }
        throw new Error('The requested Vanguard account type is not selectable');
      };

      const formatRadios = page.locator('input[name=download-option]');
      let csvRadio = null;
      for (let index = 0; index < await formatRadios.count(); index++) {
        const radio = formatRadios.nth(index);
        const id = await radio.getAttribute('id');
        const label = id ? ((await page.locator('label[for="' + id + '"]').textContent()) || '') : '';
        if (/csv/i.test(label)) csvRadio = radio;
      }
      if (!csvRadio) throw new Error('Vanguard CSV export option is unavailable');

      for (const job of activityJobs) {
        const selectedIndex = await accountIndex(job.accountKind);
        for (let index = 0; index < await accountBoxes.count(); index++) {
          const box = accountBoxes.nth(index);
          const shouldBeChecked = index === selectedIndex;
          if (await box.isChecked() !== shouldBeChecked) await clickAssociatedLabel(box);
        }
        if (!(await csvRadio.isChecked())) await clickAssociatedLabel(csvRadio);

        await page.locator('select[name=downloadDateOption]:visible').selectOption({ label: 'Custom' });
        await page.locator('input[name=fromDatePicker]:visible').fill(job.startDate);
        await page.locator('input[name=toDatePicker]:visible').fill('${option('through', DEFAULT_THROUGH)}');

        const event = page.waitForEvent('download');
        await page.getByRole('button', { name: /download/i }).click();
        const download = await event;
        await download.saveAs(job.targetPath);
        const failure = await download.failure();
        if (failure) throw new Error('Vanguard activity download failed');
        downloadedActivity.push(job.fileName);
      }
    }

    const downloadedStatements = [];
    const unavailableStatements = [];
    if (statementJobs.length) {
      const statementRowsReady = await page.locator('tbody tr').count() > 0 &&
        await page.locator('#select-year-id').count() > 0;
      if (!statementRowsReady) {
        const documentButtons = await page.locator('button:visible').all();
        for (const button of documentButtons) {
          const label = (((await button.textContent()) || '') + ' ' + ((await button.getAttribute('aria-label')) || '')).toLowerCase();
          if (label.includes('statement') && label.includes('document')) {
            await button.click();
            break;
          }
        }
        await gotoVisibleLink(/^Statements$/i, 'Statements');
      }

      const yearSelect = page.locator('#select-year-id:visible');
      if (await yearSelect.count()) await yearSelect.selectOption({ label: '2026' });
      await page.waitForTimeout(500);
      const rows = page.locator('tbody tr');

      for (const job of statementJobs) {
        const displayDate = job.statementDate.slice(5).replace('-', '/') + '/' + job.statementDate.slice(0, 4);
        let match = null;
        for (let attempt = 0; attempt < 20 && !match; attempt++) {
          for (let index = 0; index < await rows.count(); index++) {
            const row = rows.nth(index);
            const text = ((await row.textContent()) || '').toLowerCase();
            const dateMatches = text.includes(displayDate);
            const typeMatches = job.accountKind === 'roth-ira'
              ? /roth/.test(text) && /ira/.test(text)
              : /brokerage/.test(text) && !/roth|traditional/.test(text);
            if (dateMatches && typeMatches) {
              if (match) throw new Error('Multiple Vanguard statement rows matched one target');
              match = row;
            }
          }
          if (!match) await page.waitForTimeout(500);
        }
        if (!match) {
          unavailableStatements.push(job.fileName);
          continue;
        }
        const icon = match.locator('c11n-icon[name=download]');
        if (await icon.count() !== 1) throw new Error('Vanguard statement download control is unavailable');
        const event = page.waitForEvent('download');
        await icon.click();
        const download = await event;
        await download.saveAs(job.targetPath);
        const failure = await download.failure();
        if (failure) throw new Error('Vanguard statement download failed');
        downloadedStatements.push(job.fileName);
      }
    }

    return JSON.stringify({
      status: 'complete',
      downloadedActivity,
      downloadedStatements,
      unavailableStatements,
      liveAccountOptions: 2,
      legacyAccountOptions: 0,
    });
  }`;
}

const outputDir = option('output-dir', DEFAULT_OUTPUT_DIR);
const through = option('through', DEFAULT_THROUGH);
const sessionName = option('session', 'vanguard-catchup');
const accountSet = option('account-set', 'current');
assertIsoDate(through, 'through');
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(accountSet)) {
  throw new Error('account-set must be a kebab-case, PII-free label');
}
await mkdir(outputDir, { recursive: true });

const activityJobs: ActivityJob[] = ([
  {
    accountKind: 'brokerage',
    startDate: '2026-05-25',
    fileName: `vanguard-${accountSet}-brokerage-2026-05-25-to-${through}-activity.csv`,
    kind: 'csv',
  },
  {
    accountKind: 'roth-ira',
    startDate: '2026-05-25',
    fileName: `vanguard-${accountSet}-roth-ira-2026-05-25-to-${through}-activity.csv`,
    kind: 'csv',
  },
] satisfies Array<Omit<ActivityJob, 'targetPath'>>).map(job => ({ ...job, targetPath: resolve(outputDir, job.fileName) }));

const statementJobs: StatementJob[] = [
  ['brokerage', '2026-06-30', `2026-06-30-Brokerage---${accountSet}.pdf`],
  ['roth-ira', '2026-06-30', `2026-06-30-Roth-IRA---${accountSet}.pdf`],
  ['brokerage', '2026-07-31', `2026-07-31-Brokerage---${accountSet}.pdf`],
  ['roth-ira', '2026-07-31', `2026-07-31-Roth-IRA---${accountSet}.pdf`],
].map(([accountKind, statementDate, fileName]) => ({
  accountKind: accountKind as StatementJob['accountKind'],
  statementDate,
  fileName,
  kind: 'pdf' as const,
  targetPath: resolve(outputDir, fileName),
}));

const artifacts: Array<ActivityJob | StatementJob> = [...activityJobs, ...statementJobs];
const pendingActivity = [];
for (const job of activityJobs) {
  if (!(await isValid(job.targetPath, job.kind))) pendingActivity.push(job);
}
const pendingStatements = [];
for (const job of statementJobs) {
  if (!(await isValid(job.targetPath, job.kind))) pendingStatements.push(job);
}

if (pendingActivity.length || pendingStatements.length) {
  const result = await runPlaywrightCode({ name: sessionName, startUrl: LOGIN_URL }, browserProgram(pendingActivity, pendingStatements));
  const payload = parseSessionJson<{ status?: string }>(result);
  if (payload.status === 'auth-required') {
    console.log(`Complete Vanguard login and MFA in the headed ${sessionName} window, then rerun this command.`);
    process.exit(2);
  }
  if (payload.status !== 'complete') throw new Error('Vanguard workflow did not complete');
}

const validatedStatementKinds = new Set<StatementJob['accountKind']>();
for (const artifact of artifacts) {
  if (artifact.kind === 'pdf' && !(await Bun.file(artifact.targetPath).exists())) continue;
  const size = await validateArtifact(artifact.targetPath, artifact.kind);
  if (artifact.kind === 'pdf') validatedStatementKinds.add((artifact as StatementJob).accountKind);
  console.log(`validated ${artifact.fileName} (${size} bytes)`);
}
for (const accountKind of new Set(statementJobs.map(job => job.accountKind))) {
  if (!validatedStatementKinds.has(accountKind)) {
    throw new Error(`No valid Vanguard statement was available for ${accountKind}`);
  }
}

console.log(`Vanguard ${accountSet} account activity and missing statements are staged.`);
