import { createHash } from "crypto";
import { copyFile, readFile, mkdir } from "fs/promises";
import { join, basename } from "path";
import { getDb } from "./db";
import { resolveParser } from "../parsers";
import { rebuild } from "./rebuild";
import { resolveAccountId } from "./accounts";
import { saveManualFacts } from "./manualFacts";

const RAW_DIR = join(import.meta.dir, "../imports/raw");

export interface ImportReport {
  fileId: number;
  parserId: string;
  transactionsInserted: number;
  balancesInserted: number;
  unmappedAliases: Array<{ institution: string; account: string }>;
  autoCreatedAccounts: Array<{ institution: string; account: string; accountId: number }>;
}

interface StagedImport {
  fileId: number;
  parserId: string;
}

// Ingest one uploaded file: content-address it into the raw store, record it in
// import_files, confirm a committed parser handles it, then rebuild the ledger from
// the whole raw store (the canonical, order-independent set-union). Raw files are
// the source of truth, and rebuild() is the single path into the ledger cache.
export async function importFile(sourcePath: string): Promise<ImportReport> {
  const staged = await stageImportFile(sourcePath);
  const r = await rebuildWithAutoAccounts();

  return {
    fileId: staged.fileId,
    parserId: staged.parserId,
    transactionsInserted: r.tx,
    balancesInserted: r.bal,
    unmappedAliases: r.unmappedAliases,
    autoCreatedAccounts: r.autoCreatedAccounts,
  };
}

export async function importFiles(sourcePaths: string[]): Promise<ImportReport[]> {
  const staged: StagedImport[] = [];
  for (const sourcePath of sourcePaths) {
    staged.push(await stageImportFile(sourcePath));
  }
  const r = await rebuildWithAutoAccounts();
  return staged.map((file) => ({
    fileId: file.fileId,
    parserId: file.parserId,
    transactionsInserted: r.tx,
    balancesInserted: r.bal,
    unmappedAliases: r.unmappedAliases,
    autoCreatedAccounts: r.autoCreatedAccounts,
  }));
}

async function stageImportFile(sourcePath: string): Promise<StagedImport> {
  await mkdir(RAW_DIR, { recursive: true });

  const contents = await readFile(sourcePath);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const filename = basename(sourcePath);
  const destPath = join(RAW_DIR, `${sha256}-${filename}`);

  const db = getDb();
  const existing = db
    .query<{ id: number; status: string }, [string]>(
      "SELECT id, status FROM import_files WHERE sha256 = ?"
    )
    .get(sha256);
  if (existing?.status === "ok") {
    throw new Error(`File already imported (id=${existing.id})`);
  }

  // Resolve the parser BEFORE persisting anything, so an unrecognized file is
  // rejected cleanly rather than left half-imported.
  let parserId: string;
  let coverage: { covered_from: string | null; covered_to: string | null };
  try {
    const parser = await resolveParser(sourcePath);
    parserId = parser.meta.id;
    // Validate it actually parses (throws on malformed input).
    const parsed = await parser.parse(sourcePath);
    const allDates = [
      ...parsed.transactions.map((t) => t.date),
      ...parsed.balances.map((b) => b.date),
    ].sort();
    coverage = {
      covered_from: parsed.covered_from ?? allDates[0] ?? null,
      covered_to: parsed.covered_to ?? allDates[allDates.length - 1] ?? null,
    };
  } catch (err) {
    throw new Error(
      `No committed parser handles "${filename}". Author one in parsers/ and commit it. (${String(err)})`
    );
  }

  await copyFile(sourcePath, destPath);
  const fileId = existing?.id ?? insertImportFile(sha256, filename);
  db.run(
    "UPDATE import_files SET parser_id = ?, status = 'ok', covered_from = ?, covered_to = ? WHERE id = ?",
    [parserId, coverage.covered_from, coverage.covered_to, fileId]
  );
  return { fileId, parserId };
}

async function rebuildWithAutoAccounts(): Promise<{
  tx: number;
  bal: number;
  unmappedAliases: Array<{ institution: string; account: string }>;
  autoCreatedAccounts: Array<{ institution: string; account: string; accountId: number }>;
}> {
  // Rebuild the ledger from all raw files — keeps the cache a pure projection.
  // If newly imported data exposes account aliases we have never seen before,
  // create visible placeholder accounts immediately and rebuild again so the
  // import is one-step: the account appears in net worth without a separate
  // manual mapping pass. The user can still refine metadata later in Accounts.
  let r = await rebuild();
  const autoCreatedAccounts = r.unmappedAliases.map(({ institution, account }) => ({
    institution,
    account,
    accountId: resolveAccountId(institution, account),
  }));
  if (autoCreatedAccounts.length > 0) {
    await saveManualFacts();
    r = await rebuild();
  }
  return { ...r, autoCreatedAccounts };
}

function insertImportFile(sha256: string, filename: string): number {
  const db = getDb();
  db.run("INSERT INTO import_files (sha256, filename) VALUES (?, ?)", [sha256, filename]);
  return db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id;
}
