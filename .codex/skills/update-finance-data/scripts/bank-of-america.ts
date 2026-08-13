#!/usr/bin/env bun

import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { createConnection } from "node:net";

type Config = {
  outputDir: string;
  through: string;
  checkingFrom: string;
  savingsFrom: string;
  cardFrom: string;
  session: string;
  scope: "checking" | "savings" | "card-activity" | "card-statements" | null;
  dryRun: boolean;
};

type ValidArtifact = {
  filename: string;
  kind: "csv" | "pdf";
  size: number;
};

type PlaywrightSession = {
  socketPath: string;
  browser?: {
    launchOptions?: {
      headless?: boolean;
    };
  };
};

const repoRoot = resolve(import.meta.dir, "../../../..");
function parseArgs(args: string[]): Config {
  const config: Config = {
    outputDir: join(
      homedir(),
      "Downloads/easymoney-imports/2026-08-12",
    ),
    through: "2026-08-13",
    checkingFrom: "2026-06-01",
    savingsFrom: "2026-05-26",
    cardFrom: "2026-05-12",
    session: "finance-catchup",
    scope: null,
    dryRun: false,
  };

  const valueFlags: Record<string, keyof Config> = {
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
      config.scope = value as Config["scope"];
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
    if (/^bofa-(checking|savings)-/i.test(filename) &&
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

async function findSession(name: string): Promise<PlaywrightSession> {
  const daemonRoot = join(homedir(), "Library/Caches/ms-playwright/daemon");
  const entries = await readdir(daemonRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(daemonRoot, entry.name, `${name}.session`);
    const text = await readFile(path, "utf8").catch(() => null);
    if (!text) continue;
    return JSON.parse(text) as PlaywrightSession;
  }
  throw new Error(`The Playwright session ${name} does not exist.`);
}

async function runSessionProgram(session: PlaywrightSession, code: string): Promise<string> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection(session.socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, result?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(result ?? "");
    };

    socket.setTimeout(120_000, () => finish(new Error("Playwright session command timed out.")));
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({
        id: 1,
        method: "run",
        params: {
          args: { _: ["run-code", code] },
          cwd: repoRoot,
          raw: true,
          json: false,
        },
      })}\n`);
    });
    socket.on("data", chunk => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        const message = JSON.parse(line) as {
          id?: number;
          error?: string;
          result?: { text?: string };
        };
        if (message.id !== 1) continue;
        if (message.error) finish(new Error(message.error));
        else finish(undefined, message.result?.text);
      }
    });
    socket.on("error", error => finish(error));
    socket.on("close", () => finish(new Error("Playwright session closed before returning a result.")));
  });
}

function completedStatementMonths(
  files: Set<string>,
  account: "checking" | "savings" | "credit-card",
): string[] {
  const months = new Set<string>();
  const pattern = new RegExp(
    `^bofa-${account}-(\\d{4})-(\\d{2})(?:-[a-z0-9-]+)?-statement\\.pdf$`,
  );
  for (const filename of files) {
    const match = filename.match(pattern);
    if (!match)
      continue;
    const month = `${match[1]}-${match[2]}`;
    months.add(month);
  }
  return [...months];
}

function buildBrowserProgram(
  config: Config,
  valid: ValidArtifact[],
  scope: Config["scope"],
): string {
  const files = new Set(valid.map((artifact) => artifact.filename));
  const checkingActivity = `bofa-checking-${config.checkingFrom}-to-${config.through}.csv`;
  const savingsActivity = `bofa-savings-${config.savingsFrom}-to-${config.through}.csv`;
  const plan = {
    scope,
    session: config.session,
    outputDir: config.outputDir,
    through: config.through,
    accounts: {
      checking: {
        from: config.checkingFrom,
        activity: checkingActivity,
        downloadActivity: !files.has(checkingActivity),
        skipStatementMonths: completedStatementMonths(files, "checking"),
      },
      savings: {
        from: config.savingsFrom,
        activity: savingsActivity,
        downloadActivity: !files.has(savingsActivity),
        skipStatementMonths: completedStatementMonths(files, "savings"),
      },
      card: {
        from: config.cardFrom,
        skipStatementMonths: completedStatementMonths(files, "credit-card"),
        existingActivity: [...files].filter((filename) => filename.startsWith("bofa-credit-card-") && filename.endsWith(".csv")),
      },
    },
  };

  return `async page => {
    const plan = ${JSON.stringify(plan)};
    const saved = [];
    const skipped = [];
    const monthNumbers = { Jan: "01", January: "01", Feb: "02", February: "02", Mar: "03", March: "03", Apr: "04", April: "04", May: "05", Jun: "06", June: "06", Jul: "07", July: "07", Aug: "08", August: "08", Sep: "09", September: "09", Oct: "10", October: "10", Nov: "11", November: "11", Dec: "12", December: "12" };

    const safeError = error => String(error && error.message || error)
      .replace(/https?:\\/\\/\\S+/g, "<redacted-url>")
      .replace(/\\b[a-f0-9]{20,}\\b/gi, "<redacted-id>")
      .replace(/\\b\\d{4,}\\b/g, "<digits>");
    const dateFromText = text => {
      const match = text.match(/\\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+(\\d{1,2}),\\s+(\\d{4})\\b/);
      return match ? \`\${match[3]}-\${monthNumbers[match[1]]}-\${match[2].padStart(2, "0")}\` : null;
    };
    const monthFromText = text => {
      const match = text.match(/\\b(January|February|March|April|May|June|July|August|September|October|November|December) Statement\\b/);
      if (!match) return null;
      const short = match[1].slice(0, 3);
      return monthNumbers[short];
    };
    const pointerClick = async locator => {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      if (!box) throw new Error("Required control is not visible");
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    const saveFetchedDownload = async (filename, fetchInPage) => {
      const promise = page.waitForEvent("download", { timeout: 15000 });
      const response = await fetchInPage();
      if (!response.ok) throw new Error(\`Download request failed with status \${response.status}\`);
      const download = await promise;
      await download.saveAs(\`\${plan.outputDir}/\${filename}\`);
      const failure = await download.failure();
      if (failure) throw new Error("Browser reported a download failure");
      saved.push(filename);
    };
    const closeDownloadDialog = async () => {
      const close = page.locator("#downloadTxnLayerSpartaUILayer button.spa-ui-layer-close");
      if (await close.count() && await close.isVisible()) await close.click();
    };
    const goToOverview = async () => {
      if ((await page.title()).includes("Accounts Overview")) return;
      await page.goto("https://secure.bankofamerica.com/myaccounts/signin/signIn.go");
      await page.waitForFunction(() => document.title.includes("Accounts Overview"), null, { timeout: 15000 });
    };
    const selectAccount = async (kind, pattern) => {
      await goToOverview();
      await page.waitForFunction(source => {
        const matcher = new RegExp(source, "i");
        return [...document.querySelectorAll("a")].some(element => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && matcher.test((element.innerText || "").trim());
        });
      }, pattern, { timeout: 15000 });
      await page.evaluate(({ kind, source }) => {
        const matcher = new RegExp(source, "i");
        const link = [...document.querySelectorAll("a")].find(element => {
          const box = element.getBoundingClientRect();
          let path = "";
          try { path = new URL(element.href, location.href).pathname; } catch {}
          return box.width > 0 && path === "/myaccounts/brain/redirect.go" && matcher.test((element.innerText || "").trim());
        });
        if (!link) throw new Error(\`\${kind} account link was not found\`);
        link.setAttribute("data-codex-bofa-account", kind);
      }, { kind, source: pattern });
      await pointerClick(page.locator(\`[data-codex-bofa-account="\${kind}"]\`));
      await page.waitForFunction(() => !document.title.includes("Accounts Overview"), null, { timeout: 15000 });
    };
    const downloadDepositActivity = async (from, to, filename) => {
      await page.locator("a.download-transactions").click();
      await page.locator('form[action*="/ogateway/addapi/v1/download/form/transaction"]').waitFor({ state: "attached" });
      await saveFetchedDownload(filename, () => page.evaluate(async ({ from, to, filename }) => {
        const form = document.querySelector('form[action*="/ogateway/addapi/v1/download/form/transaction"]');
        if (!(form instanceof HTMLFormElement)) throw new Error("Deposit download form was not found");
        const body = new FormData(form);
        body.set("payload.txnSearchCriteria.txnPeriod", "custom range");
        body.set("payload.txnSearchCriteria.startDate", from.split("-").slice(1).concat(from.slice(0, 4)).join("/"));
        body.set("payload.txnSearchCriteria.endDate", to.split("-").slice(1).concat(to.slice(0, 4)).join("/"));
        body.set("payload.txnSearchCriteria.fileType", "csv");
        const response = await fetch(form.action, { method: form.method || "POST", body, credentials: "include" });
        const blob = await response.blob();
        const href = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = filename;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
        return { ok: response.ok, status: response.status };
      }, { from, to, filename }));
      await closeDownloadDialog();
    };
    const openDepositStatements = async () => {
      await closeDownloadDialog();
      await page.waitForFunction(() => [...document.querySelectorAll("a")].some(element => {
        const text = (element.innerText || "").trim();
        const box = element.getBoundingClientRect();
        return box.width > 0 && (text === "Statements & Docs" || text === "Statements & Documents");
      }), null, { timeout: 15000 });
      await page.evaluate(() => {
        const links = [...document.querySelectorAll("a")].filter(element => {
          const text = (element.innerText || "").trim();
          const box = element.getBoundingClientRect();
          return box.width > 0 && (text === "Statements & Docs" || text === "Statements & Documents");
        });
        const link = links.at(-1);
        if (!link) throw new Error("Statements tab was not found");
        link.setAttribute("data-codex-bofa-statements", "true");
      });
      await page.locator("[data-codex-bofa-statements=true]").click();
      await page.waitForFunction(() => document.title.includes("Statements and Docs"), null, { timeout: 15000 });
    };
    const downloadStatements = async (account, from, to, productPattern, skipMonths) => {
      const button = page.getByRole("button", { name: "Statements", exact: true }).first();
      await button.waitFor({ state: "visible" });
      if (await button.getAttribute("aria-expanded") === "true") await pointerClick(button);
      const responsePromise = page.waitForResponse(response =>
        response.url().includes("/gatherDocuments") && response.request().method() === "POST",
        { timeout: 15000 },
      );
      await pointerClick(button);
      const response = await responsePromise;
      const body = await response.json();
      const documents = Array.isArray(body.documentList) ? body.documentList : [];
      for (const statement of documents) {
        if (!(new RegExp(productPattern, "i")).test(String(statement.accountDisplayName || ""))) continue;
        const statementDate = String(statement.date || "").slice(0, 10);
        const monthNumber = monthFromText(String(statement.docDisplayName || ""));
        if (!statementDate || !monthNumber || statementDate < from || statementDate > to) continue;
        const month = statementDate.slice(0, 4) + "-" + monthNumber;
        if (skipMonths.includes(month)) {
          skipped.push(\`\${account} statement \${month}\`);
          continue;
        }
        const filename = \`bofa-\${account}-\${month}-statement.pdf\`;
        await saveFetchedDownload(filename, () => page.evaluate(async ({ statement, filename }) => {
          const params = new URLSearchParams({
            adx: statement.adx,
            documentId: statement.docId,
            adaDocumentFlag: "N",
            menuFlag: "download",
            request_locale: "en-US",
          });
          const downloadResponse = await fetch(
            "/ogateway/dsviewdocuments/omni/statements/v1/docViewDownload?" + params,
            { credentials: "include" },
          );
          const blob = await downloadResponse.blob();
          const href = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = href;
          anchor.download = filename;
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(href), 1000);
          return { ok: downloadResponse.ok, status: downloadResponse.status };
        }, { statement, filename }));
      }
    };
    const downloadCardActivity = async () => {
      const currentFilename = \`bofa-credit-card-current-to-\${plan.through}.csv\`;
      const existing = new Set(plan.accounts.card.existingActivity);
      const openPanel = async () => {
        const period = page.locator("#select_transaction");
        if (!await period.isVisible()) await page.locator("a[name=download_transactions_top]").click();
        await period.waitFor({ state: "visible" });
        return period;
      };
      const period = await openPanel();
      const labels = await period.locator("option").allTextContents();
      const jobs = [{ label: "Current transactions", filename: currentFilename }];
      for (const label of labels) {
        const date = dateFromText(label);
        if (!date || date < plan.accounts.card.from || date > plan.through) continue;
        jobs.push({ label: label.trim(), filename: \`bofa-credit-card-period-ending-\${date}.csv\` });
      }
      for (const job of jobs) {
        if (existing.has(job.filename)) {
          skipped.push(job.filename);
          continue;
        }
        const select = await openPanel();
        await select.selectOption({ label: job.label });
        await page.locator("#select_filetype").selectOption({ label: "Microsoft Excel Format" });
        await saveFetchedDownload(job.filename, () => page.evaluate(async filename => {
          const period = document.querySelector("#select_transaction");
          const fileType = document.querySelector("#select_filetype");
          if (!(period instanceof HTMLSelectElement) || !(fileType instanceof HTMLSelectElement))
            throw new Error("Credit-card download controls were not found");
          const target = period.value + fileType.value;
          const response = await fetch(target, { credentials: "include" });
          const blob = await response.blob();
          const href = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = href;
          anchor.download = filename;
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(href), 1000);
          return { ok: response.ok, status: response.status };
        }, job.filename));
      }
    };

    try {
      page.setDefaultTimeout(12000);
      const authenticated = page.url().startsWith("https://secure.bankofamerica.com/") && !await page.locator('input[type="password"]').count();
      if (!authenticated) return JSON.stringify({ status: "login-required", action: \`Sign in and complete MFA in \${plan.session}, then rerun.\` });

      if (!plan.scope || plan.scope === "checking") {
        await selectAccount("checking", "Adv Plus Banking -|Checking -");
        if (plan.accounts.checking.downloadActivity)
          await downloadDepositActivity(plan.accounts.checking.from, plan.through, plan.accounts.checking.activity);
        else skipped.push(plan.accounts.checking.activity);
        await openDepositStatements();
        await downloadStatements("checking", plan.accounts.checking.from, plan.through, "Adv Plus Banking|Checking", plan.accounts.checking.skipStatementMonths);
      }
      if (!plan.scope || plan.scope === "savings") {
        await selectAccount("savings", "Advantage Savings -|Savings -");
        if (plan.accounts.savings.downloadActivity)
          await downloadDepositActivity(plan.accounts.savings.from, plan.through, plan.accounts.savings.activity);
        else skipped.push(plan.accounts.savings.activity);
        await openDepositStatements();
        await downloadStatements("savings", plan.accounts.savings.from, plan.through, "Advantage Savings|Savings", plan.accounts.savings.skipStatementMonths);
      }
      if (!plan.scope || plan.scope === "card-activity") {
        await selectAccount("credit-card", "Customized Cash Rewards Visa Signature -|Credit Card -");
        await downloadCardActivity();
      }
      if (!plan.scope || plan.scope === "card-statements") {
        await selectAccount("credit-card", "Customized Cash Rewards Visa Signature -|Credit Card -");
        await page.locator("a[name=statements_and_documents]").click();
        await page.waitForFunction(() => document.title.includes("Statements"), null, { timeout: 15000 });
        await downloadStatements("credit-card", plan.accounts.card.from, plan.through, "Customized Cash Rewards|Credit Card", plan.accounts.card.skipStatementMonths);
      }

      return JSON.stringify({ status: "complete", scope: plan.scope, saved, skipped });
    } catch (error) {
      return JSON.stringify({ status: "error", message: safeError(error), saved, skipped });
    }
  }`;
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const config = parseArgs(args);
  await mkdir(config.outputDir, { recursive: true });
  const before = await validatedArtifacts(config.outputDir);
  console.log(JSON.stringify({ phase: "validated-existing", artifacts: before }, null, 2));
  if (config.dryRun)
    return;

  const session = await findSession(config.session);
  if (session.browser?.launchOptions?.headless !== false) {
    throw new Error(`The headed persistent Playwright session ${config.session} is not open.`);
  }

  const result = await runSessionProgram(session, buildBrowserProgram(config, before, config.scope));
  console.log(result);
  const decoded = JSON.parse(result) as string | { status?: string; action?: string; message?: string };
  const parsed = typeof decoded === "string"
    ? JSON.parse(decoded) as { status?: string; action?: string; message?: string }
    : decoded;
  if (parsed.status === "login-required")
    throw new Error(parsed.action ?? "Interactive login is required.");
  if (parsed.status !== "complete")
    throw new Error(parsed.message ?? "Bank of America automation did not complete.");

  const after = await validatedArtifacts(config.outputDir);
  console.log(JSON.stringify({ phase: "validated-final", artifacts: after }, null, 2));
}

await main();
