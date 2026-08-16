import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { fidelityInvestmentReportParser } from "../../../../server/app/importParsers/fidelityInvestmentReport.ts";

type ArtifactKind = "csv" | "pdf";

interface Options {
  from: string;
  to: string;
  output: string;
  session: string;
  validateOnly: boolean;
}

interface Artifact {
  kind: ArtifactKind;
  path: string;
}

const PUBLIC_HOME = "https://www.fidelity.com/";
const DEFAULT_OUTPUT = "/private/tmp/easymoney-fidelity-catchup";
const CLI = ["npx", "--yes", "-p", "@playwright/cli@latest", "playwright-cli"];
const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const CONFIG_PATH = "/tmp/easymoney-fidelity-playwright.json";
const MIN_BYTES = 100;

function usage(): never {
  console.log([
    "Usage:",
    "  bun .codex/skills/update-finance-data/scripts/fidelity.ts [options]",
    "",
    "Options:",
    "  --from YYYY-MM-DD       Activity start date (required)",
    "  --to YYYY-MM-DD         Activity end date (required)",
    `  --output PATH           Staging directory (default: ${DEFAULT_OUTPUT})`,
    "  --session NAME          Persistent headed session (default: fidelity-catchup)",
    "  --validate-only         Validate completed outputs without using the browser",
  ].join("\n"));
  process.exit(0);
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  let validateOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--validate-only") {
      validateOnly = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    values.set(arg, value);
    index += 1;
  }

  const from = values.get("--from") ?? "2026-05-24";
  const to = values.get("--to") ?? "2026-08-13";
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(from) || !datePattern.test(to) || from > to) {
    throw new Error("Expected an ordered --from and --to in YYYY-MM-DD format");
  }

  return {
    from,
    to,
    output: resolve(values.get("--output") ?? DEFAULT_OUTPUT),
    session: values.get("--session") ?? "fidelity-catchup",
    validateOnly,
  };
}

function sanitizeError(value: string): string {
  return value
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\$[\d,]+(?:\.\d{2})?/g, "[amount]")
    .replace(/\b\d{4,}\b/g, "[number]")
    .slice(0, 1_000);
}

async function runCli(args: string[], timeoutMs = 30_000): Promise<string> {
  const child = Bun.spawn([...CLI, ...args], {
    cwd: REPO_ROOT,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const exitCode = await child.exited;
  clearTimeout(timer);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (exitCode !== 0) {
    throw new Error(sanitizeError(stderr || stdout || `playwright-cli exited ${exitCode}`));
  }
  return stdout.trim();
}

async function inspectArtifact(path: string, kind: ArtifactKind, requireExtension = true): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < MIN_BYTES) return false;
    if (requireExtension && extname(path).toLowerCase() !== `.${kind}`) return false;
    const bytes = new Uint8Array(await Bun.file(path).slice(0, 4_096).arrayBuffer());
    if (kind === "pdf") {
      return new TextDecoder("ascii").decode(bytes.slice(0, 5)) === "%PDF-";
    }
    if (bytes.includes(0)) return false;
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes).includes(",");
  } catch {
    return false;
  }
}

async function validateArtifact(artifact: Artifact): Promise<void> {
  if (!await inspectArtifact(artifact.path, artifact.kind)) {
    throw new Error(`Invalid ${artifact.kind.toUpperCase()} artifact: ${basename(artifact.path)}`);
  }
  if (artifact.kind === "pdf") {
    const fileName = basename(artifact.path);
    const fileBytes = new Uint8Array(await Bun.file(artifact.path).arrayBuffer());
    const parsed = await fidelityInvestmentReportParser.parse({
      fileName,
      headers: [],
      rows: [],
      text: "",
      filePath: artifact.path,
      fileBytes,
    });
    if (parsed.balances.length === 0) {
      throw new Error(`Fidelity investment report has no balance: ${fileName}`);
    }
  }
}

function previousMonth(value: string): string {
  const date = new Date(`${value.slice(0, 7)}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7);
}

function statementMonths(from: string, to: string): string[] {
  const months: string[] = [];
  const cursor = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const todayMonth = new Date().toISOString().slice(0, 7);
  const finalMonth = to.slice(0, 7) === todayMonth ? previousMonth(to) : to.slice(0, 7);
  while (cursor.toISOString().slice(0, 7) <= finalMonth) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function artifacts(options: Options): Artifact[] {
  const result: Artifact[] = [
    {
      kind: "csv",
      path: resolve(options.output, `fidelity-investment-activity-${options.from}-to-${options.to}.csv`),
    },
    {
      kind: "csv",
      path: resolve(options.output, `fidelity-retirement-activity-${options.from}-to-${options.to}.csv`),
    },
  ];
  for (const month of statementMonths(options.from, options.to)) {
    result.push({
      kind: "pdf",
      path: resolve(options.output, `fidelity-investment-report-${month}.pdf`),
    });
  }
  return result;
}

async function ensureSession(options: Options): Promise<void> {
  const list = await runCli(["list"]);
  if (list.includes(`- ${options.session}:`)) return;

  await writeFile(CONFIG_PATH, JSON.stringify({
    browser: {
      browserName: "chromium",
      launchOptions: {
        channel: "chrome",
        headless: false,
        args: ["--disable-http2"],
        downloadsPath: options.output,
      },
      contextOptions: { acceptDownloads: true },
    },
  }));
  await runCli([
    `-s=${options.session}`,
    "open",
    PUBLIC_HOME,
    "--persistent",
    `--config=${CONFIG_PATH}`,
  ]);
}

async function clickText(options: Options, label: string): Promise<void> {
  const expression = `(() => {
    const target = [...document.querySelectorAll('a,button')]
      .find(element => (element.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(label)});
    if (!target) return false;
    target.click();
    return true;
  })()`;
  const result = await runCli([`-s=${options.session}`, "--raw", "eval", expression]);
  if (!result.includes("true")) throw new Error(`Fidelity control not found: ${label}`);
  await Bun.sleep(1_500);
}

async function openPortfolio(options: Options): Promise<void> {
  await runCli([`-s=${options.session}`, "--raw", "goto", PUBLIC_HOME]);
  await clickText(options, "Portfolio");
  const signedIn = await runCli([
    `-s=${options.session}`,
    "--raw",
    "eval",
    "!/signin|login/i.test(location.pathname)",
  ]);
  if (!signedIn.includes("true")) {
    console.log(`Authentication required. Complete login and MFA in headed session ${options.session}, then rerun.`);
    process.exit(2);
  }
}

async function openActivity(options: Options): Promise<void> {
  await openPortfolio(options);
  await clickText(options, "Activity & Orders");
}

async function openDocuments(options: Options): Promise<void> {
  await openPortfolio(options);
  await clickText(options, "Documents");
}

async function selectAccount(options: Options, kind: "investment" | "retirement"): Promise<void> {
  const selectorOpen = await runCli([
    `-s=${options.session}`,
    "--raw",
    "eval",
    "document.querySelector('#account-selector')?.checkVisibility() === true",
  ]);
  if (!selectorOpen.includes("true")) {
    await runCli([
      `-s=${options.session}`,
      "--raw",
      "click",
      "button[aria-label=\"account selector\"]:visible",
    ]);
  }

  const pattern = kind === "investment" ? "/brokerage|individual|IRA/i" : "/401\\(k\\)|retirement/i";
  await runCli([
    `-s=${options.session}`,
    "--raw",
    "click",
    `locator('#account-selector:visible a').filter({ hasText: ${pattern} }).first()`,
  ]);
}

async function setActivityRange(options: Options): Promise<void> {
  await runCli([
    `-s=${options.session}`,
    "--raw",
    "click",
    "getByRole('button', { name: /Open time filter/ })",
  ]);
  await runCli([
    `-s=${options.session}`,
    "--raw",
    "click",
    "getByText('Custom', { exact: true })",
  ]);
  await runCli([`-s=${options.session}`, "--raw", "fill", "#input-from-date", options.from]);
  await runCli([`-s=${options.session}`, "--raw", "fill", "#input-to-date", options.to]);
  await runCli([
    `-s=${options.session}`,
    "--raw",
    "click",
    "getByRole('button', { name: 'Apply', exact: true })",
  ]);
}

async function downloadNewArtifact(
  options: Options,
  target: Artifact,
  trigger: () => Promise<void>,
): Promise<void> {
  if (await inspectArtifact(target.path, target.kind)) {
    console.log(`skip ${basename(target.path)}`);
    return;
  }

  const before = new Set(await readdir(options.output));
  const startedAt = Date.now();
  await trigger();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const candidates: string[] = [];
    for (const entry of await readdir(options.output)) {
      if (before.has(entry) || entry.endsWith(".crdownload")) continue;
      const path = resolve(options.output, entry);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || info.mtimeMs < startedAt - 1_000) continue;
      if (await inspectArtifact(path, target.kind, false)) candidates.push(path);
    }
    if (candidates.length === 1) {
      await rename(candidates[0]!, target.path);
      await validateArtifact(target);
      console.log(`saved ${basename(target.path)}`);
      return;
    }
    if (candidates.length > 1) {
      throw new Error(`Ambiguous ${target.kind.toUpperCase()} downloads; rerun after isolating the staging folder`);
    }
    await Bun.sleep(500);
  }
  throw new Error(`Fidelity did not produce ${basename(target.path)}`);
}

async function downloadActivity(
  options: Options,
  kind: "investment" | "retirement",
  target: Artifact,
): Promise<void> {
  if (await inspectArtifact(target.path, target.kind)) {
    console.log(`skip ${basename(target.path)}`);
    return;
  }
  await openActivity(options);
  await selectAccount(options, kind);
  await setActivityRange(options);
  await downloadNewArtifact(options, target, async () => {
    await runCli([
      `-s=${options.session}`,
      "--raw",
      "click",
      "getByRole('button', { name: 'Download', exact: true })",
    ]);
    await runCli([
      `-s=${options.session}`,
      "--raw",
      "click",
      "getByRole('button', { name: 'Download as CSV', exact: true })",
    ]);
  });
}

function statementLabel(month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  return `${date.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${date.getUTCFullYear()}`;
}

async function downloadStatements(options: Options, targets: Artifact[]): Promise<void> {
  const pdfTargets = targets.filter(target => target.kind === "pdf");
  const pending: Artifact[] = [];
  for (const target of pdfTargets) {
    if (!await inspectArtifact(target.path, target.kind)) pending.push(target);
  }
  if (pending.length === 0) {
    for (const target of pdfTargets) console.log(`skip ${basename(target.path)}`);
    return;
  }

  await openDocuments(options);
  for (const target of pdfTargets) {
    const month = basename(target.path).match(/\d{4}-\d{2}/)?.[0];
    if (!month) throw new Error(`Missing statement month in ${basename(target.path)}`);
    const label = statementLabel(month);
    await downloadNewArtifact(options, target, async () => {
      await runCli([
        `-s=${options.session}`,
        "--raw",
        "click",
        `locator('a').filter({ hasText: /${label}.*Statement/ }).first().locator('xpath=following::a[@aria-label="Download Document"][1]')`,
      ]);
    });
  }
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  await mkdir(options.output, { recursive: true });
  const expected = artifacts(options);

  if (options.validateOnly) {
    for (const artifact of expected) await validateArtifact(artifact);
    console.log(`validated ${expected.length} Fidelity artifacts`);
    return;
  }

  const incomplete = [];
  for (const artifact of expected) {
    if (!await inspectArtifact(artifact.path, artifact.kind)) incomplete.push(artifact);
  }
  if (incomplete.length > 0) await ensureSession(options);

  await downloadActivity(options, "investment", expected[0]!);
  await downloadActivity(options, "retirement", expected[1]!);
  await downloadStatements(options, expected);
  for (const artifact of expected) await validateArtifact(artifact);
  console.log(`validated ${expected.length} Fidelity artifacts`);
}

await main().catch(error => {
  console.error(sanitizeError(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
