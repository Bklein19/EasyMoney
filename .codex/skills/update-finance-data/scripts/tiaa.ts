import { mkdir, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import parseActivity from "../../../../server/app/importParsers/moneyParsers/tiaa-activity-csv.ts";
import parseStatement, { meta as statementMeta } from "../../../../server/app/importParsers/moneyParsers/tiaa-statement-pdf.ts";
import { runPlaywrightCode } from "./playwrightSession.ts";

type Kind = "csv" | "pdf";
type Artifact = { fileName: string; kind: Kind; path: string };
const SESSION_NAME = "tiaa-catchup";
const HOME_URL = "https://my.tiaa.org/private/participant/home";
const DEFAULT_OUTPUT = "/private/tmp/easymoney-tiaa-catchup";
const DEFAULT_FROM = "2026-01-01";
const DEFAULT_TO = new Date().toISOString().slice(0, 10);

function option(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return Bun.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function sanitizeBrowserError(value: string): string {
  return value.replace(/https?:\/\/\S+/g, "[url]").replace(/\$[\d,]+(?:\.\d{2})?/g, "[amount]").replace(/\b\d{4,}\b/g, "[number]").slice(0, 800);
}

function iso(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
}

function quarterEnds(from: string, to: string): Array<{ date: string; quarter: number; year: number }> {
  const result: Array<{ date: string; quarter: number; year: number }> = [];
  const startYear = Number(from.slice(0, 4));
  const endYear = Number(to.slice(0, 4));
  for (let year = startYear; year <= endYear; year++) {
    for (const [month, quarter] of [[3, 1], [6, 2], [9, 3], [12, 4]] as const) {
      const date = `${year}-${String(month).padStart(2, "0")}-${month === 3 || month === 12 ? "31" : "30"}`;
      if (date >= from && date <= to) result.push({ date, quarter, year });
    }
  }
  return result;
}

function artifacts(output: string, from: string, to: string): Artifact[] {
  const result: Artifact[] = [{ fileName: `tiaa-retirement-annuity-${from}-to-${to}.csv`, kind: "csv", path: resolve(output, `tiaa-retirement-annuity-${from}-to-${to}.csv`) }];
  for (const item of quarterEnds(from, to)) {
    result.push({ fileName: `tiaa-${item.date}-retirement-q${item.quarter}-${item.year}-0000.pdf`, kind: "pdf", path: resolve(output, `tiaa-${item.date}-retirement-q${item.quarter}-${item.year}-0000.pdf`) });
  }
  return result;
}

async function validate(artifact: Artifact): Promise<void> {
  const file = Bun.file(artifact.path);
  if (!(await file.exists()) || file.size < (artifact.kind === "pdf" ? 10_000 : 100)) throw new Error(`Invalid ${artifact.kind} artifact: ${artifact.fileName}`);
  if (extname(artifact.path).toLowerCase() !== `.${artifact.kind}`) throw new Error(`Invalid extension: ${artifact.fileName}`);
  const bytes = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  if (artifact.kind === "csv") {
    const text = new TextDecoder().decode(bytes);
    if (bytes.includes(0) || !text.includes("Date,AccountId,Action,Security,Price,Quantity,Amount,Text,Memo,Commission")) throw new Error(`TIAA CSV shape mismatch: ${artifact.fileName}`);
    const parsed = await parseActivity(artifact.path);
    if (!parsed.transactions.length) throw new Error(`TIAA CSV has no activity rows: ${artifact.fileName}`);
    return;
  }
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error(`TIAA PDF signature mismatch: ${artifact.fileName}`);
  if (!statementMeta.matches({ filename: basename(artifact.path), sample: "" })) throw new Error(`TIAA PDF filename mismatch: ${artifact.fileName}`);
  const parsed = await parseStatement(artifact.path);
  if (!parsed.balances.length) throw new Error(`TIAA PDF has no balance: ${artifact.fileName}`);
}

async function isValid(artifact: Artifact): Promise<boolean> {
  try { await validate(artifact); return true; } catch { return false; }
}

function browserProgram(requested: Artifact[]): string {
  return `async page => {
    const requested = ${JSON.stringify(requested)};
    const phase = async (name, operation) => {
      try { return await operation(); } catch (error) { throw new Error(name + ': browser operation failed'); }
    };
    const login = async () => /login|signin|authenticate/i.test(page.url().split('?')[0]) || await page.locator('input[type=password]').count() > 0;
    const save = async (bytes, mime, filename, path) => {
      const event = page.waitForEvent('download');
      await page.evaluate(({ bytes, mime, filename }) => { const raw = atob(bytes); const data = Uint8Array.from(raw, c => c.charCodeAt(0)); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: mime })); a.download = filename; a.click(); }, { bytes, mime, filename });
      const download = await event; await download.saveAs(path); if (await download.failure()) throw new Error('TIAA download failed');
    };
    const settle = async () => {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForLoadState('load').catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(2000);
    };
    await phase('home navigation', async () => { await page.goto('https://my.tiaa.org/private/participant/home', { waitUntil: 'commit' }); await settle(); });
    if (await login()) return JSON.stringify({ status: 'authentication-required' });
    const links = await page.evaluate(() => [...document.querySelectorAll('a')].map(a => ({ text: (a.textContent || '').replace(/\\s+/g, ' ').trim(), href: a.href })).filter(x => x.href));
    const activityLink = links.find(x => /my\\.tiaa\\.org/i.test(x.href) && /quickendownload|transactionhistory|activity|transaction/i.test(x.href));
    const statementLink = links.find(x => /my\\.tiaa\\.org/i.test(x.href) && /account-statements|statements|documents/i.test(x.href));
    if (!activityLink && !statementLink) throw new Error('TIAA activity and statement controls were not found');
    const downloaded = [];
    const activity = requested.find(x => x.kind === 'csv');
    if (activity) {
      if (!activityLink) throw new Error('TIAA activity control was not found');
      await phase('activity navigation', async () => { await page.goto(activityLink.href, { waitUntil: 'commit' }); await settle(); });
      let activityFrame = page.mainFrame();
      let activityControls = activityFrame.locator('button, input, a');
      let activityControlIndex = -1;
      let activityDownloaded = false;
      for (const frame of page.frames()) {
        const controls = frame.locator('button, input, a');
        for (let i = 0; i < await controls.count(); i++) {
          const matches = await controls.nth(i).evaluate((element) => /download|export|csv/i.test((element.textContent || '') + ' ' + element.getAttribute('value') + ' ' + element.getAttribute('aria-label') + ' ' + element.getAttribute('title'))).catch(() => false);
          if (matches) { activityFrame = frame; activityControls = controls; activityControlIndex = i; break; }
        }
        if (activityControlIndex >= 0) break;
      }
      if (activityControlIndex < 0) {
        const submit = page.locator('form button[type=submit], form input[type=submit], form input[type=button]');
        if (await submit.count()) {
          await phase('activity form submit', async () => { await submit.first().click(); await settle(); });
          for (const frame of page.frames()) {
            const controls = frame.locator('button, input, a');
            for (let i = 0; i < await controls.count(); i++) {
              const matches = await controls.nth(i).evaluate((element) => /download|export|csv/i.test((element.textContent || '') + ' ' + element.getAttribute('value') + ' ' + element.getAttribute('aria-label') + ' ' + element.getAttribute('title'))).catch(() => false);
              if (matches) { activityControls = controls; activityControlIndex = i; break; }
            }
            if (activityControlIndex >= 0) break;
          }
        }
      }
      if (activityControlIndex < 0) {
        const downloadText = page.getByText(/download/i).first();
        if (await downloadText.count()) {
          await phase('activity text download', async () => {
            await downloadText.click();
            await page.waitForTimeout(500);
            const csvText = page.getByText(/csv/i).first();
            if (!(await csvText.count())) throw new Error('TIAA CSV choice was unavailable');
            const event = page.waitForEvent('download');
            await csvText.click();
            const download = await event;
            await download.saveAs(activity.path);
            if (await download.failure()) throw new Error('TIAA activity download failed');
          });
          activityControlIndex = -2;
          activityDownloaded = true;
        }
      }
      if (activityControlIndex >= 0) {
        const activityButton = activityControls.nth(activityControlIndex);
        await phase('activity button download', async () => {
          const event = page.waitForEvent('download');
          await activityButton.click();
          const download = await event;
          await download.saveAs(activity.path);
          if (await download.failure()) throw new Error('TIAA activity download failed');
        });
        downloaded.push(activity.fileName);
      } else if (!activityDownloaded) {
      const control = await phase('activity control', () => page.evaluate(() => {
        const form = [...document.querySelectorAll('form')].find(x => /csv|download|activity|transaction/i.test(x.action + ' ' + x.textContent));
        const link = [...document.querySelectorAll('a')].find(x => /csv|download|export/i.test((x.textContent || '') + ' ' + x.href));
        const href = link?.href || form?.action;
        if (!href) throw new Error('TIAA activity export control was not found');
        const fields = form ? [...form.elements].filter(x => 'name' in x && x.name).map(x => ({ name: x.name, value: 'value' in x ? x.value : '' })) : [];
        return { href, method: form?.method?.toUpperCase() === 'POST' ? 'POST' : 'GET', fields, source: link ? 'link' : 'form', path: new URL(href).pathname };
      }));
      const response = await phase('activity export', () => page.context().request.fetch(control.href, { method: control.method, form: control.method === 'POST' ? Object.fromEntries(control.fields.map(x => [x.name, x.value])) : undefined }));
      const bytes = await response.body();
      const headerMatched = bytes.toString('utf8', 0, 512).includes('Date,AccountId,Action,Security,Price,Quantity,Amount,Text,Memo,Commission');
      if (!response.ok() || bytes.length < 100 || bytes.includes(0) || !headerMatched) {
        const shape = await page.evaluate(() => ({ forms: document.forms.length, selects: document.querySelectorAll('select').length, submits: document.querySelectorAll('button, input[type=submit], input[type=button]').length, hasDownloadWord: /download/i.test(document.body.textContent || ''), hasExportWord: /export/i.test(document.body.textContent || ''), hasCsvWord: /csv/i.test(document.body.textContent || '') })).catch(() => ({ forms: -1, selects: -1, submits: -1, hasDownloadWord: false, hasExportWord: false, hasCsvWord: false }));
        throw new Error('TIAA activity response failed validation status=' + response.status() + ' contentType=' + (response.headers()['content-type'] ?? 'unknown') + ' bytes=' + bytes.length + ' headerMatched=' + headerMatched + ' source=' + control.source + ' path=' + control.path + ' forms=' + shape.forms + ' selects=' + shape.selects + ' submits=' + shape.submits + ' keywords=' + [shape.hasDownloadWord, shape.hasExportWord, shape.hasCsvWord].join('/'));
      }
      const result = { base64: bytes.toString('base64'), bytes: bytes.length };
      await phase('activity save', () => save(result.base64, 'text/csv', activity.fileName, activity.path)); downloaded.push(activity.fileName);
      }
    }
    const statements = requested.filter(x => x.kind === 'pdf');
    if (statements.length) {
      if (!statementLink) throw new Error('TIAA statement control was not found');
      await phase('statement navigation', async () => { await page.goto(statementLink.href, { waitUntil: 'commit' }); await settle(); });
      for (const target of statements) {
        const match = await phase('statement lookup', () => page.evaluate((name) => {
          const m = name.match(/tiaa-(\\d{4})-\\d{2}-\\d{2}-retirement-q(\\d)-/); if (!m) return null;
          const year = m[1], quarter = m[2];
          return [...document.querySelectorAll('a')].find(x => {
            const label = ((x.textContent || '') + ' ' + x.href).replace(/\\s+/g, ' ');
            return x.href && new RegExp(year).test(label) && new RegExp('(q|quarter)[ -]?' + quarter, 'i').test(label) && /statement|document|pdf/i.test(label);
          })?.href ?? null;
        }, target.fileName));
        if (!match) throw new Error('Requested TIAA statement is unavailable');
        const response = await phase('statement download', () => page.context().request.get(match)); const body = await response.body();
        if (!response.ok() || body.length < 10000 || body.subarray(0, 5).toString() !== '%PDF-') throw new Error('TIAA statement response failed validation');
        await phase('statement save', () => save(body.toString('base64'), 'application/pdf', target.fileName, target.path)); downloaded.push(target.fileName);
      }
    }
    return JSON.stringify({ status: 'complete', downloaded });
  }`;
}

function contractProbeProgram(): string {
  return `async page => {
    const scrubPath = value => new URL(value).pathname.split('/').map(segment => /\\d{6,}|[A-Za-z0-9_-]{24,}/.test(segment) ? '[segment]' : segment).join('/');
    const settle = async () => {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForLoadState('load').catch(() => {});
      await page.waitForTimeout(1500);
    };
    await page.goto('https://my.tiaa.org/private/participant/home', { waitUntil: 'commit' });
    await settle();
    if (/login|signin|authenticate/i.test(page.url().split('?')[0]) || await page.locator('input[type=password]').count()) return JSON.stringify({ status: 'authentication-required' });
    const links = await page.evaluate(() => [...document.querySelectorAll('a')].map(a => ({ text: (a.textContent || '').replace(/\\s+/g, ' ').trim(), href: a.href })).filter(x => x.href));
    const activityLink = links.find(x => /my\\.tiaa\\.org/i.test(x.href) && /quickendownload|transactionhistory|activity|transaction/i.test(x.href));
    const statementLink = links.find(x => /my\\.tiaa\\.org/i.test(x.href) && /account-statements|statements|documents/i.test(x.href));
    if (!activityLink) return JSON.stringify({ status: 'activity-link-missing', statementLink: Boolean(statementLink) });
    await page.goto(activityLink.href, { waitUntil: 'commit' });
    await settle();
    const observed = [];
    const listener = response => {
      const headers = response.headers();
      const type = headers['content-type'] || '';
      const disposition = headers['content-disposition'] || '';
      if (/csv|pdf|octet-stream|attachment/i.test(type + ' ' + disposition)) observed.push({ method: response.request().method(), path: scrubPath(response.url()), status: response.status(), type: type.split(';')[0], attachment: /attachment/i.test(disposition) });
    };
    page.on('response', listener);
    const before = await page.evaluate(() => ({
      frames: document.querySelectorAll('iframe').length,
      exactDownload: [...document.querySelectorAll('*')].filter(x => /^download$/i.test((x.textContent || '').trim())).length,
      exactCsv: [...document.querySelectorAll('*')].filter(x => /^csv$/i.test((x.textContent || '').trim())).length,
      downloadAttrs: [...document.querySelectorAll('[download]')].length,
      forms: document.forms.length,
    }));
    let downloadClicked = false, csvClicked = false, downloadEvent = false;
    const downloadPromise = page.waitForEvent('download', { timeout: 10000 }).then(() => { downloadEvent = true; }).catch(() => {});
    for (const frame of page.frames()) {
      const exact = frame.getByText(/^download$/i).last();
      if (await exact.count()) { await exact.click().catch(() => {}); downloadClicked = true; break; }
    }
    await page.waitForTimeout(750);
    for (const frame of page.frames()) {
      const exact = frame.getByText(/^csv$/i).last();
      if (await exact.count()) { await exact.click().catch(() => {}); csvClicked = true; break; }
    }
    await Promise.race([downloadPromise, page.waitForTimeout(10000)]);
    await page.waitForTimeout(1000);
    page.off('response', listener);
    return JSON.stringify({ status: 'observed', statementLink: Boolean(statementLink), before, downloadClicked, csvClicked, downloadEvent, responses: observed.slice(-20) });
  }`;
}

const from = option("from", DEFAULT_FROM); const to = option("to", DEFAULT_TO); const output = resolve(option("output-dir", DEFAULT_OUTPUT)); const validateOnly = Bun.argv.includes("--validate-only"); const probeOnly = Bun.argv.includes("--probe-contract");
iso(from, "from"); iso(to, "to"); if (from > to) throw new Error("from must not be after to");
await mkdir(output, { recursive: true });
const expected = artifacts(output, from, to);
const started = performance.now();
if (probeOnly) {
  console.log(await runPlaywrightCode({ name: SESSION_NAME, startUrl: HOME_URL }, contractProbeProgram()));
} else if (!validateOnly) {
  const requested = []; for (const artifact of expected) if (!(await isValid(artifact))) requested.push(artifact);
  if (requested.length) {
    const raw = await runPlaywrightCode({ name: SESSION_NAME, startUrl: HOME_URL }, browserProgram(requested));
    if (/authentication-required/.test(raw)) throw new Error(`Authentication required in headed session ${SESSION_NAME}`);
    if (!/complete/.test(raw)) throw new Error(`TIAA browser workflow did not complete: ${sanitizeBrowserError(raw)}`);
  }
}
if (!probeOnly) {
  for (const artifact of expected) await validate(artifact);
  console.log(JSON.stringify({ status: "ready", artifacts: expected.length, csv: expected.filter(x => x.kind === "csv").length, pdf: expected.filter(x => x.kind === "pdf").length, elapsedMs: Math.round(performance.now() - started) }));
}
