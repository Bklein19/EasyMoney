import { mkdir, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { join } from "path";
import { tmpdir } from "os";
import { getDb } from "./db";
import type { ParseResult } from "./types";

export interface StoredParser {
  id: string;
  institution: string;
  file_type: string;
  code: string;
}

export function listParserIds(): string[] {
  const db = getDb();
  return db
    .query<{ id: string }, []>("SELECT id FROM parsers ORDER BY id")
    .all()
    .map((r) => r.id);
}

export function getParser(id: string): StoredParser | null {
  const db = getDb();
  return db
    .query<StoredParser, [string]>(
      "SELECT id, institution, file_type, code FROM parsers WHERE id = ?"
    )
    .get(id);
}

export function upsertParser(parser: StoredParser): void {
  const db = getDb();
  db.run(
    `INSERT INTO parsers (id, institution, file_type, code)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       institution = excluded.institution,
       file_type = excluded.file_type,
       code = excluded.code,
       updated_at = datetime('now')`,
    [parser.id, parser.institution, parser.file_type, parser.code]
  );
}

export async function executeParser(parserId: string, filePath: string): Promise<ParseResult> {
  const parser = getParser(parserId);
  if (!parser) throw new Error(`Parser not found in database: ${parserId}`);

  // Write to a content-addressed temp file so Bun's module cache works in our favor:
  // same code → same path → cached import; new code → new path → fresh import.
  const hash = createHash("sha256").update(parser.code).digest("hex").slice(0, 16);
  const dir = join(tmpdir(), "money-parsers");
  await mkdir(dir, { recursive: true });
  const modPath = join(dir, `${parserId}-${hash}.ts`);
  await writeFile(modPath, parser.code, "utf8");

  const mod = await import(modPath);
  return (mod.default ?? mod.parse)(filePath) as Promise<ParseResult>;
}
