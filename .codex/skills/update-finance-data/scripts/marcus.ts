import { basename, join, resolve } from "node:path";
import { mkdir, stat } from "node:fs/promises";

import parseMarcusStatement, { meta as marcusMeta } from "../../../../server/app/importParsers/moneyParsers/marcus-statement-pdf.ts";

type Options = {
  from: string;
  to: string;
  output: string;
  session: string;
  validateOnly: boolean;
  timingOnly: boolean;
};

type Artifact = { path: string; statementDate: string };
const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const DEFAULT_OUTPUT = "/private/tmp/easymoney-marcus-catchup";
const PLAYWRIGHT_CLI = ["npx", "--yes", "playwright@latest", "cli"];

function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  let validateOnly = false;
  let timingOnly = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--validate-only") { validateOnly = true; continue; }
    if (arg === "--timing-only") { timingOnly = true; continue; }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun .codex/skills/update-finance-data/scripts/marcus.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--output PATH] [--session NAME] [--validate-only] [--timing-only]");
      process.exit(0);
    }
    if (!arg.startsWith("--") || !args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error(`Invalid option: ${arg}`);
    values.set(arg, args[++i]!);
  }
  const from = values.get("--from") ?? "2026-01-01";
  const to = values.get("--to") ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new Error("--from and --to must be ordered YYYY-MM-DD dates");
  return { from, to, output: resolve(values.get("--output") ?? DEFAULT_OUTPUT), session: values.get("--session") ?? "marcus-catchup", validateOnly, timingOnly };
}

function months(from: string, to: string): string[] {
  const result: string[] = [];
  const cursor = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);
  while (cursor <= end) { result.push(cursor.toISOString().slice(0, 7)); cursor.setUTCMonth(cursor.getUTCMonth() + 1); }
  return result;
}

function artifacts(options: Options): Artifact[] {
  return months(options.from, options.to).map(month => ({
    statementDate: month,
    path: join(options.output, `marcus-online-savings-statement-${month}.pdf`),
  }));
}

async function validateArtifact(artifact: Artifact): Promise<number> {
  const info = await stat(artifact.path);
  if (!info.isFile() || info.size < 32) throw new Error(`${basename(artifact.path)} is missing or too small`);
  const bytes = new Uint8Array(await Bun.file(artifact.path).slice(0, 5).arrayBuffer());
  if (new TextDecoder().decode(bytes) !== "%PDF-") throw new Error(`${basename(artifact.path)} is not a PDF`);
  const parsed = await parseMarcusStatement(artifact.path);
  if (!parsed.covered_from || !parsed.covered_to || parsed.balances.length !== 1) throw new Error(`${basename(artifact.path)} failed Marcus balance validation`);
  if (!parsed.transactions.length) throw new Error(`${basename(artifact.path)} has no Marcus activity rows`);
  if (!marcusMeta.matches({ filename: basename(artifact.path), sample: "" })) {
    console.log(`parser-validated explicit Marcus parser ${basename(artifact.path)}`);
  }
  return info.size;
}

async function validArtifacts(expected: Artifact[]): Promise<Artifact[]> {
  const valid: Artifact[] = [];
  for (const artifact of expected) { try { await validateArtifact(artifact); valid.push(artifact); } catch {} }
  return valid;
}

async function runCli(args: string[]): Promise<string> {
  const child = Bun.spawn([...PLAYWRIGHT_CLI, ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const exitCode = await child.exited;
  const [out, error] = await Promise.all([stdout, stderr]);
  if (exitCode !== 0) {
    const safe = (error || out).replace(/https?:\/\/\S+/g, "<url>").replace(/\b\d{4,}\b/g, "<digits>");
    throw new Error(safe.trim() || `Playwright CLI exited with ${exitCode}`);
  }
  return out.trim();
}

async function verifySession(name: string): Promise<void> {
  const payload = JSON.parse(await runCli(["list", "--json"])) as { browsers?: Array<{ name?: string; status?: string; headed?: boolean; persistent?: boolean }> };
  const session = payload.browsers?.find(browser => browser.name === name);
  if (!session || session.status !== "open" || !session.headed || !session.persistent) {
    throw new Error(`Existing headed persistent Playwright session ${name} is unavailable`);
  }
}

function browserProgram(pending: Artifact[], options: Options): string {
  return `async page => {
    const pending = ${JSON.stringify(pending)};
    const through = ${JSON.stringify(options.to)};
    const isLogin = await page.evaluate(() => /login|signin|logon/i.test(location.pathname) || Boolean(document.querySelector('input[type=password]')));
    if (isLogin) return JSON.stringify({ status: 'authentication-required' });
    const origin = await page.evaluate(() => location.origin);
    await page.goto(origin + '/us/en/documents');
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForFunction(() => [...document.querySelectorAll('a')].some(a => { try { return new URL(a.href).pathname.includes('/accounts/document/'); } catch { return false; } }), undefined, { timeout: 15000 });
    const findAnchor = async statementMonth => {
      await page.waitForFunction(() => [...document.querySelectorAll('a')].some(a => (a.getAttribute('href') || '').includes('/accounts/document/')), undefined, { timeout: 15000 });
      for (const link of await page.locator('a').all()) {
        const href = await link.getAttribute('href');
        if (!href || !href.includes('/accounts/document/')) continue;
        const rowText = await link.evaluate(element => {
          let node = element.parentElement;
          for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
            const text = node.textContent || '';
            if ((text.match(new RegExp('[0-9]{2}/01/[0-9]{4}', 'g')) || []).length === 1) return text;
          }
          return '';
        });
        const match = String(rowText || '').match(new RegExp('([0-9]{2})/01/([0-9]{4})'));
        if (match && match[2] + '-' + match[1] === statementMonth) return link;
      }
      return null;
    };
    if (!await findAnchor(pending[0].statementDate)) return JSON.stringify({ status: 'documents-not-found', candidates: 0 });
    const downloaded = [];
    for (const target of pending) {
      const candidate = await findAnchor(target.statementDate);
      if (!candidate) continue;
      const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
      await candidate.click();
      const download = await downloadPromise;
      await download.saveAs(target.path);
      downloaded.push({ month: target.statementDate });
      await page.goto(origin + '/us/en/documents');
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(500);
    }
    return JSON.stringify({ status: 'complete', downloaded, available: downloaded.length, through });
  }`;
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  const expected = artifacts(options);
  await mkdir(options.output, { recursive: true });
  const start = performance.now();
  const before = await validArtifacts(expected);
  const pending = expected.filter(artifact => !before.includes(artifact));
  if (options.validateOnly || options.timingOnly) {
    console.log(JSON.stringify({ status: "validated", count: before.length, total: expected.length, milliseconds: Math.round(performance.now() - start) }));
    return;
  }
  if (pending.length) {
    await verifySession(options.session);
    const result = await runCli([`-s=${options.session}`, "--raw", "run-code", browserProgram(pending, options)]);
    console.log(result.replace(/\b\d{4,}\b/g, "<digits>"));
    if (result.includes('authentication-required')) throw new Error("Interactive authentication is required in the headed session");
    if (result.includes('documents-not-found')) throw new Error("Marcus statement/document controls were not found");
  }
  const after = await validArtifacts(expected);
  if (after.length === 0) throw new Error("Marcus run produced no parser-validated PDFs");
  if (after.length !== expected.length) throw new Error(`Marcus run ended with ${after.length}/${expected.length} parser-validated PDFs`);
  console.log(JSON.stringify({ status: "complete", artifacts: after.length, pdfs: after.length, milliseconds: Math.round(performance.now() - start), importReady: false, note: "PII-free filenames require explicit Marcus parser selection; automatic filename routing expects account digits." }));
}

await main().catch(error => { console.error(String(error instanceof Error ? error.message : error).replace(/\b\d{4,}\b/g, "<digits>")); process.exit(1); });
