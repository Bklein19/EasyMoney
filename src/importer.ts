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

// Ingest one uploaded file: content-address it into the raw store, record it in
// import_files, confirm a committed parser handles it, then rebuild the ledger from
// the whole raw store (the canonical, order-independent set-union). Raw files are
// the source of truth, and rebuild() is the single path into the ledger cache.
export async function importFile(sourcePath: string): Promise<ImportReport> {
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
  try {
    const parser = await resolveParser(sourcePath);
    parserId = parser.meta.id;
    // Validate it actually parses (throws on malformed input).
    await parser.parse(sourcePath);
  } catch (err) {
    throw new Error(
      `No committed parser handles "${filename}". Author one in parsers/ and commit it. (${String(err)})`
    );
  }

  await copyFile(sourcePath, destPath);
  const fileId = existing?.id ?? insertImportFile(sha256, filename);
  db.run(
    "UPDATE import_files SET parser_id = ?, status = 'ok' WHERE id = ?",
    [parserId, fileId]
  );

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

  return {
    fileId,
    parserId,
    transactionsInserted: r.tx,
    balancesInserted: r.bal,
    unmappedAliases: r.unmappedAliases,
    autoCreatedAccounts,
  };
}

function insertImportFile(sha256: string, filename: string): number {
  const db = getDb();
  db.run("INSERT INTO import_files (sha256, filename) VALUES (?, ?)", [sha256, filename]);
  return db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id;
}
