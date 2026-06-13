// Run via: bun scripts/download-vanguard-statements.ts
// Requires an active @playwright/cli session already on the Vanguard statements page.
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { importFile } from "../src/importer";

const OUT_DIR = join(import.meta.dir, "../imports/statements");
await mkdir(OUT_DIR, { recursive: true });

async function playwrightEval(js: string): Promise<unknown> {
  const proc = Bun.spawn(["npx", "@playwright/cli", "eval", js, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  // CLI wraps result as { "result": "<json-encoded-string>" }
  try {
    const wrapper = JSON.parse(out);
    if (wrapper?.result !== undefined) {
      try { return JSON.parse(wrapper.result); } catch { return wrapper.result; }
    }
    return wrapper;
  } catch {
    return out.trim();
  }
}

const BASE = "https://personal1.vanguard.com/usa/api/lah-statements-consumer";
const YEARS = [2020, 2021, 2022, 2023, 2024, 2025, 2026];

interface Statement {
  statementId: string;
  endDate: string;
  statementDescription: string;
}

// Fetch all statements across all years using the browser's authenticated session
const allStatements: Statement[] = [];
for (const year of YEARS) {
  console.log(`Fetching statements for ${year}...`);
  const result = await playwrightEval(`async () => {
    const res = await fetch('${BASE}/statements/consumer?year=${year}', {
      credentials: 'include',
      headers: { urlflag: 'getStatements', accept: 'application/json' }
    });
    const data = await res.json();
    return data.statements ?? [];
  }`) as { result?: Statement[] } | Statement[];

  const statements: Statement[] = Array.isArray(result)
    ? result
    : (result as any)?.result ?? [];

  console.log(`  ${year}: ${statements.length} statements`);
  allStatements.push(...statements);
}

console.log(`\nTotal statements: ${allStatements.length}`);

// Download each PDF via browser fetch (uses session cookies)
let downloaded = 0;
let skipped = 0;
for (const stmt of allStatements) {
  const safeName = stmt.statementDescription
    .replace(/[^a-zA-Z0-9 \-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60);
  const filename = `${stmt.endDate}-${safeName}.pdf`;
  const outPath = join(OUT_DIR, filename);

  const existing = Bun.file(outPath);
  if (await existing.exists() && existing.size > 0) {
    console.log(`  skip (exists): ${filename}`);
    skipped++;
    continue;
  }

  console.log(`  downloading: ${filename}`);

  // Fetch as base64 via browser eval so cookies are included
  // Chunk the btoa conversion to avoid stack overflow on large ArrayBuffers
  const b64 = await playwrightEval(`async () => {
    const res = await fetch('${BASE}/statements/pdf', {
      credentials: 'include',
      headers: { urlflag: 'getPdf', statementid: '${stmt.statementId}', accept: 'application/pdf' }
    });
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
    }
    return btoa(binary);
  }`) as { result?: string } | string;

  const base64 = typeof b64 === "string" ? b64 : (b64 as any)?.result ?? "";
  const bytes = Buffer.from(base64, "base64");
  await writeFile(outPath, bytes);
  downloaded++;
  console.log(`    saved (${Math.round(bytes.length / 1024)}KB)`);
  await Bun.sleep(300);
}

console.log(`\nDownloaded: ${downloaded}, skipped: ${skipped}`);
console.log(`Files saved to: ${OUT_DIR}`);

// Import all downloaded PDFs
console.log("\nImporting into database...");
const files = (await Array.fromAsync(new Bun.Glob("*.pdf").scan(OUT_DIR))).sort();

let imported = 0;
let failed = 0;
for (const filename of files) {
  const filePath = join(OUT_DIR, filename);
  console.log(`\nImporting: ${filename}`);
  try {
    const report = await importFile(filePath);
    console.log(`  ✓ ${report.transactionsInserted} txns, ${report.balancesInserted} balances`);
    imported++;
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.includes("already imported") || msg.includes("Overlap")) {
      console.log(`  skip: ${msg.slice(0, 120)}`);
    } else {
      console.error(`  ✗ ${msg}`);
      failed++;
    }
  }
}

console.log(`\nDone. Imported: ${imported}, failed: ${failed}`);
