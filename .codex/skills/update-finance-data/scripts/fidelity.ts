import { mkdir, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { Page } from "playwright";
import { fidelityInvestmentReportParser } from "../../../../server/app/importParsers/fidelityInvestmentReport.ts";
import { withPlaywrightPage } from "./playwrightSession.ts";

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

async function inspectArtifact(path: string, kind: ArtifactKind): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < MIN_BYTES) return false;
    if (extname(path).toLowerCase() !== `.${kind}`) return false;
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

async function clickText(page: Page, label: string): Promise<void> {
  const target = page.locator('a,button').filter({ hasText: label }).first();
  if (!await target.count()) throw new Error(`Fidelity control not found: ${label}`);
  await target.click();
  await page.waitForTimeout(1_500);
}

async function openPortfolio(page: Page, options: Options): Promise<void> {
  await page.goto(PUBLIC_HOME, { waitUntil: 'domcontentloaded' });
  await clickText(page, "Portfolio");
  if (/signin|login/i.test(new URL(page.url()).pathname) || await page.locator('input[type=password]').count()) {
    console.log(`Authentication required. Complete login and MFA in the open ${options.session} browser.`);
    await page.waitForFunction(
      () => !/signin|login/i.test(location.pathname) && !document.querySelector('input[type=password]'),
      undefined,
      { timeout: 10 * 60_000 },
    );
    await page.goto(PUBLIC_HOME, { waitUntil: 'domcontentloaded' });
    await clickText(page, "Portfolio");
  }
}

async function openActivity(page: Page, options: Options): Promise<void> {
  await openPortfolio(page, options);
  await clickText(page, "Activity & Orders");
}

async function openDocuments(page: Page, options: Options): Promise<void> {
  await openPortfolio(page, options);
  await clickText(page, "Documents");
}

async function selectAccount(page: Page, kind: "investment" | "retirement"): Promise<void> {
  if (!await page.locator('#account-selector:visible').count()) {
    await page.locator('button[aria-label="account selector"]:visible').click();
  }
  const pattern = kind === "investment" ? /brokerage|individual|IRA/i : /401\(k\)|retirement/i;
  await page.locator('#account-selector:visible a').filter({ hasText: pattern }).first().click();
}

async function setActivityRange(page: Page, options: Options): Promise<void> {
  await page.getByRole('button', { name: /Open time filter/ }).click();
  await page.getByText('Custom', { exact: true }).click();
  await page.locator('#input-from-date').fill(options.from);
  await page.locator('#input-to-date').fill(options.to);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
}

async function downloadNewArtifact(
  page: Page,
  target: Artifact,
  trigger: () => Promise<void>,
): Promise<void> {
  if (await inspectArtifact(target.path, target.kind)) {
    console.log(`skip ${basename(target.path)}`);
    return;
  }

  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await trigger();
  const download = await downloadPromise;
  await download.saveAs(target.path);
  if (await download.failure()) throw new Error(`Fidelity did not produce ${basename(target.path)}`);
  await validateArtifact(target);
  console.log(`saved ${basename(target.path)}`);
}

async function downloadActivity(
  options: Options,
  page: Page,
  kind: "investment" | "retirement",
  target: Artifact,
): Promise<void> {
  if (await inspectArtifact(target.path, target.kind)) {
    console.log(`skip ${basename(target.path)}`);
    return;
  }
  await openActivity(page, options);
  await selectAccount(page, kind);
  await setActivityRange(page, options);
  await downloadNewArtifact(page, target, async () => {
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    await page.getByRole('button', { name: 'Download as CSV', exact: true }).click();
  });
}

function statementLabel(month: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  return `${date.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${date.getUTCFullYear()}`;
}

async function downloadStatements(options: Options, page: Page, targets: Artifact[]): Promise<void> {
  const pdfTargets = targets.filter(target => target.kind === "pdf");
  const pending: Artifact[] = [];
  for (const target of pdfTargets) {
    if (!await inspectArtifact(target.path, target.kind)) pending.push(target);
  }
  if (pending.length === 0) {
    for (const target of pdfTargets) console.log(`skip ${basename(target.path)}`);
    return;
  }

  await openDocuments(page, options);
  for (const target of pdfTargets) {
    const month = basename(target.path).match(/\d{4}-\d{2}/)?.[0];
    if (!month) throw new Error(`Missing statement month in ${basename(target.path)}`);
    const label = statementLabel(month);
    await downloadNewArtifact(page, target, async () => {
      await page.locator('a').filter({ hasText: new RegExp(`${label}.*Statement`) }).first()
        .locator('xpath=following::a[@aria-label="Download Document"][1]').click();
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
  if (incomplete.length > 0) {
    await withPlaywrightPage({
      name: options.session,
      startUrl: PUBLIC_HOME,
      contextOptions: { downloadsPath: options.output },
      launchArgs: ['--disable-http2'],
    }, async page => {
      await downloadActivity(options, page, "investment", expected[0]!);
      await downloadActivity(options, page, "retirement", expected[1]!);
      await downloadStatements(options, page, expected);
    });
  }
  for (const artifact of expected) await validateArtifact(artifact);
  console.log(`validated ${expected.length} Fidelity artifacts`);
}

await main().catch(error => {
  console.error(sanitizeError(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
