import { createHash } from "crypto";
import { copyFile, readFile, mkdir } from "fs/promises";
import { join, basename } from "path";
import { getDb } from "./db";
import { runIngestionAgent } from "./agent";
import type { ParseResult } from "./types";

const RAW_DIR = join(import.meta.dir, "../imports/raw");

export interface ImportReport {
  fileId: number;
  parserId: string;
  transactionsInserted: number;
  balancesInserted: number;
}

export async function importFile(sourcePath: string): Promise<ImportReport> {
  await mkdir(RAW_DIR, { recursive: true });

  const contents = await readFile(sourcePath);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const filename = basename(sourcePath);
  const destPath = join(RAW_DIR, `${sha256}-${filename}`);

  await copyFile(sourcePath, destPath);

  const db = getDb();

  const existing = db
    .query<{ id: number; parser_id: string | null; status: string }, [string]>(
      "SELECT id, parser_id, status FROM import_files WHERE sha256 = ?"
    )
    .get(sha256);

  if (existing?.status === "ok") {
    throw new Error(`File already imported (id=${existing.id})`);
  }

  const fileId = existing?.id ?? insertImportFile(sha256, filename);

  let parserId: string;
  let parseResult: ParseResult;

  try {
    ({ parserId, parseResult } = await runIngestionAgent(destPath));
  } catch (err) {
    db.run("UPDATE import_files SET status = 'failed' WHERE id = ?", [fileId]);
    throw err;
  }

  db.run("UPDATE import_files SET parser_id = ? WHERE id = ?", [parserId, fileId]);

  const { transactionsInserted, balancesInserted } = commitToDb(fileId, parseResult);
  db.run("UPDATE import_files SET status = 'ok' WHERE id = ?", [fileId]);

  return { fileId, parserId, transactionsInserted, balancesInserted };
}

function insertImportFile(sha256: string, filename: string): number {
  const db = getDb();
  db.run("INSERT INTO import_files (sha256, filename) VALUES (?, ?)", [sha256, filename]);
  return db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id;
}

function commitToDb(
  fileId: number,
  result: ParseResult
): { transactionsInserted: number; balancesInserted: number } {
  const db = getDb();

  const insertTx = db.prepare(`
    INSERT OR IGNORE INTO transactions
      (id, import_file_id, date, amount_cents, description, account, institution, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertBal = db.prepare(`
    INSERT OR REPLACE INTO account_balances
      (import_file_id, date, account, institution, balance_cents)
    VALUES (?, ?, ?, ?, ?)
  `);

  let transactionsInserted = 0;
  let balancesInserted = 0;

  db.transaction(() => {
    for (const t of result.transactions) {
      const info = insertTx.run(
        t.id, fileId, t.date, t.amount_cents,
        t.description, t.account, t.institution,
        JSON.stringify(t.raw)
      );
      transactionsInserted += info.changes;
    }
    for (const b of result.balances) {
      const info = insertBal.run(fileId, b.date, b.account, b.institution, b.balance_cents);
      balancesInserted += info.changes;
    }
  })();

  return { transactionsInserted, balancesInserted };
}
