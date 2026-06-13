// rebuild() — reconstructs the transaction/balance ledger purely from the raw files
// in imports/raw/ plus the manual-facts store (account aliases, etc). The ledger is a
// SET-UNION of deterministic per-file parser outputs, so the result is independent of
// import order. No step here reads mutable ledger state or insertion order.
//
// Source-priority dedup: each parser declares a kind (activity-export | statement) and
// priority. For any (account, month), TRANSACTIONS come only from the highest-priority
// source kind that covers that month; lower-priority sources' transactions for that span
// are dropped. BALANCES always come from statements. Transactions a higher-priority source
// simply doesn't contain (e.g. statement-only security transfers) are NOT dropped — they're
// only dropped when a higher-priority source covers the same (account, month).

import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "crypto";
import { readdir } from "fs/promises";
import { join } from "path";
import { resolveParser } from "../parsers";
import { lookupAlias } from "./accounts";
import { getDb } from "./db";
import { activityBucket } from "./flowClassification";
import type { ParsedTransaction, ParsedBalance, ParserMeta } from "./types";

const RAW_DIR = join(import.meta.dir, "../imports/raw");

export interface ParsedFile {
  filename: string;       // original filename (sha prefix stripped)
  storedName: string;     // on-disk name (<sha>-<filename>)
  meta: ParserMeta;
  transactions: ParsedTransaction[];
  balances: ParsedBalance[];
  covered_from: string | null;
  covered_to: string | null;
}

// Parse every raw file through its registry-resolved parser. Pure: depends only on
// file bytes + committed parser code. Returns results sorted by storedName for a
// canonical (but irrelevant — the union is order-independent) processing order.
export async function parseAllRawFiles(rawDir = RAW_DIR, storedNames?: string[]): Promise<ParsedFile[]> {
  const names = (storedNames ?? (await readdir(rawDir)).filter((n) => !n.startsWith("."))).sort();
  const out: ParsedFile[] = [];
  for (const storedName of names) {
    const path = join(rawDir, storedName);
    const parser = await resolveParser(path);
    const result = await parser.parse(path);
    const filename = storedName.replace(/^[0-9a-f]{64}-/, "");
    const allDates = [
      ...result.transactions.map((t) => t.date),
      ...result.balances.map((b) => b.date),
    ].sort();
    out.push({
      filename,
      storedName,
      meta: parser.meta,
      transactions: result.transactions,
      balances: result.balances,
      covered_from: result.covered_from ?? allDates[0] ?? null,
      covered_to: result.covered_to ?? allDates[allDates.length - 1] ?? null,
    });
  }
  return out;
}

function deterministicSample(names: string[], size: number, seed: string): string[] {
  if (size >= names.length) return names;
  return [...names]
    .sort((a, b) => {
      const aHash = createHash("sha256").update(`${seed}\0${a}`).digest("hex");
      const bHash = createHash("sha256").update(`${seed}\0${b}`).digest("hex");
      return aHash.localeCompare(bHash);
    })
    .slice(0, size);
}

function deterministicShuffle<T>(values: T[], seed: string, key: (value: T) => string): T[] {
  return [...values].sort((a, b) => {
    const aHash = createHash("sha256").update(`${seed}\0${key(a)}`).digest("hex");
    const bHash = createHash("sha256").update(`${seed}\0${key(b)}`).digest("hex");
    return aHash.localeCompare(bHash);
  });
}

export interface LedgerRow {
  id: string;
  date: string;
  amount_cents: number;
  description: string;
  account: string;
  institution: string;
  account_id: number | null;
  raw: Record<string, unknown>;
}

export interface BalanceRow {
  date: string;
  account: string;
  institution: string;
  account_id: number | null;
  balance_cents: number;
}

export interface BuiltLedger {
  transactions: LedgerRow[];   // sorted, deduped — canonical form
  balances: BalanceRow[];      // sorted, deduped
  unmappedAliases: Array<{ institution: string; account: string }>;
}

// A coarse monthly aggregate (e.g. a Merrill statement's single "Net Cash Flow" row)
// rather than an itemized transaction. These yield to any higher-priority source that
// itemizes the same month, but survive where no detailed source covers the month.
function isStatementSummary(t: ParsedTransaction): boolean {
  return (t.raw as { type?: string }).type === "statement-cash-flow-summary";
}

// Pure function: parsed files → canonical ledger. This is the order-independence
// guarantee, expressed without touching the database.
//
// Dedup rules (all keyed on canonical account id, so differing alias strings collapse):
//   - "in-kind-transfer" rows are ALWAYS kept (statement-only; exports never have them).
//   - statement-cash-flow-summary rows (coarse monthly aggregates) are dropped when a
//     higher-priority source itemizes that (account, month) — even if dates/amounts
//     differ — but kept where no detailed source covers the month.
//   - other "activity" rows are dropped only when a strictly-higher-priority source has
//     a row at the same exact (account, date, amount), collapsing genuine duplicates
//     while preserving rows a higher source simply lacks.
export function buildLedger(files: ParsedFile[]): BuiltLedger {
  // Resolve account ids FIRST so coverage/dedup work on canonical accounts, not on
  // the differing alias strings each source uses ("Brokerage - 34702059" from the
  // activity export vs "Individual brokerage account-XXXX2059" from statements).
  // Rebuild never creates accounts — unmapped aliases are reported, not invented.
  const unmapped = new Map<string, { institution: string; account: string }>();
  const resolve = (institution: string, account: string): number | null => {
    const id = lookupAlias(institution, account);
    if (id === null) unmapped.set(`${institution}\0${account}`, { institution, account });
    return id;
  };
  // Canonical account key: prefer resolved id; fall back to the raw string so an
  // unmapped account still dedupes against itself.
  const acctKeyOf = (institution: string, account: string): string => {
    const id = resolve(institution, account);
    return id !== null ? `id:${id}` : `str:${institution}\0${account}`;
  };

  // Exact-match source-priority dedup. A higher-priority source should only shadow
  // rows it actually carries — not every row in a month it happens to cover. So we
  // index the highest priority at which each EXACT (account, date, amount) appears,
  // and drop a lower-priority "activity" row only when a strictly-higher-priority
  // source has a row with the same (account, date, amount). This collapses genuine
  // cross-source duplicates (e.g. a Vanguard buy in both the statement and the
  // activity export) while preserving rows a higher source simply lacks (e.g. TIAA
  // statement contributions, which the CSV activity export never records).
  // "in-kind-transfer" rows are never dropped — they exist only on statements.
  const exactKey = (ak: string, date: string, amount: number) => `${ak}\0${date}\0${amount}`;
  const bestExactPriority = new Map<string, number>();
  // For coarse statement summaries: track the highest priority at which DETAILED
  // activity of the SAME BUCKET (contribution vs income) exists per (account, month).
  // A monthly net-cash-flow summary must yield only to a higher-priority source that
  // actually itemizes cash flow that month — not merely one that itemizes interest.
  // This keeps an early-month deposit summary the CSV doesn't cover, while dropping
  // the summary once the CSV starts itemizing that bucket.
  const monthBucketKey = (ak: string, date: string, bucket: string) => `${ak}\0${date.slice(0, 7)}\0${bucket}`;
  const bestMonthBucketDetailPriority = new Map<string, number>();
  for (const f of files) {
    for (const t of f.transactions) {
      if (t.category !== "activity") continue;
      const ak = acctKeyOf(t.institution, t.account);
      const ek = exactKey(ak, t.date, t.amount_cents);
      if (f.meta.priority > (bestExactPriority.get(ek) ?? -Infinity)) bestExactPriority.set(ek, f.meta.priority);
      if (!isStatementSummary(t)) {
        const mk = monthBucketKey(ak, t.date, activityBucket(t));
        if (f.meta.priority > (bestMonthBucketDetailPriority.get(mk) ?? -Infinity)) {
          bestMonthBucketDetailPriority.set(mk, f.meta.priority);
        }
      }
    }
  }

  // Union by deterministic id, applying the drop rules on canonical accounts.
  const txById = new Map<string, ParsedTransaction>();
  for (const f of files) {
    for (const t of f.transactions) {
      if (t.category === "activity") {
        const ak = acctKeyOf(t.institution, t.account);
        if (isStatementSummary(t)) {
          // Drop a monthly summary when a higher-priority source itemizes the SAME
          // bucket (contribution/income) that month.
          const best = bestMonthBucketDetailPriority.get(monthBucketKey(ak, t.date, activityBucket(t)));
          if (best !== undefined && f.meta.priority < best) continue;
        } else {
          const best = bestExactPriority.get(exactKey(ak, t.date, t.amount_cents));
          if (best !== undefined && f.meta.priority < best) continue; // a higher source carries this exact row
        }
      }
      txById.set(t.id, t); // same id from two sources → identical row, idempotent
    }
  }

  // Balances: statements only, union by canonical (account, date).
  const balByKey = new Map<string, ParsedBalance>();
  for (const f of files) {
    if (f.meta.kind !== "statement") continue;
    for (const b of f.balances) {
      balByKey.set(`${acctKeyOf(b.institution, b.account)}\0${b.date}`, b);
    }
  }

  const transactions: LedgerRow[] = [...txById.values()]
    .map((t) => ({
      id: t.id,
      date: t.date,
      amount_cents: t.amount_cents,
      description: t.description,
      account: t.account,
      institution: t.institution,
      account_id: resolve(t.institution, t.account),
      raw: t.raw,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const balances: BalanceRow[] = [...balByKey.values()]
    .map((b) => ({
      date: b.date,
      account: b.account,
      institution: b.institution,
      account_id: resolve(b.institution, b.account),
      balance_cents: b.balance_cents,
    }))
    .sort((a, b) =>
      `${a.institution}\0${a.account}\0${a.date}`.localeCompare(`${b.institution}\0${b.account}\0${b.date}`)
    );

  return { transactions, balances, unmappedAliases: [...unmapped.values()] };
}

// Write a built ledger into a database's transactions + account_balances tables,
// replacing whatever was there. Returns counts. The caller controls the DB so this
// can target a temp DB for --verify.
export function writeLedger(db: Database, ledger: BuiltLedger): { tx: number; bal: number } {
  db.transaction(() => {
    db.run("DELETE FROM transactions");
    db.run("DELETE FROM account_balances");
    const insTx = db.prepare(
      `INSERT INTO transactions (id, import_file_id, date, amount_cents, description, account, institution, account_id, raw)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const t of ledger.transactions) {
      insTx.run(t.id, t.date, t.amount_cents, t.description, t.account, t.institution, t.account_id, JSON.stringify(t.raw));
    }
    const insBal = db.prepare(
      `INSERT INTO account_balances (import_file_id, date, account, institution, account_id, balance_cents)
       VALUES (NULL, ?, ?, ?, ?, ?)`
    );
    for (const b of ledger.balances) {
      insBal.run(b.date, b.account, b.institution, b.account_id, b.balance_cents);
    }
  })();
  return { tx: ledger.transactions.length, bal: ledger.balances.length };
}

// Order-insensitive fingerprint of a ledger — sorts rows so two ledgers with the
// same content but different row order hash identically.
export function ledgerFingerprint(ledger: BuiltLedger): string {
  const tx = ledger.transactions.map((t) => `${t.id}|${t.account_id}|${t.amount_cents}`).sort().join("\n");
  const bal = ledger.balances
    .map((b) => `${b.institution}\0${b.account}\0${b.date}|${b.balance_cents}|${b.account_id}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(`${tx}\n##\n${bal}`).digest("hex");
}

// Rebuild the live DB's ledger from raw files. Returns counts + any unmapped aliases.
export async function rebuild(): Promise<{ tx: number; bal: number; unmappedAliases: BuiltLedger["unmappedAliases"] }> {
  const files = await parseAllRawFiles();
  const ledger = buildLedger(files);
  const counts = writeLedger(getDb(), ledger);
  return { ...counts, unmappedAliases: ledger.unmappedAliases };
}

// Prove order-independence: build the ledger from multiple seeded shuffles and
// assert identical fingerprints. Returns the fingerprint on success; throws on
// mismatch with the seed needed to reproduce the failure. Pure — does not touch
// the live DB.
export async function verify(options: { sampleSize?: number; seed?: string; permutations?: number } = {}): Promise<{ fingerprint: string; tx: number; bal: number; seed: string }> {
  const seed = options.seed ?? randomBytes(16).toString("hex");
  const permutations = options.permutations ?? 8;
  if (permutations < 2) throw new Error("verify requires at least two permutations");

  let storedNames: string[] | undefined;
  if (options.sampleSize !== undefined) {
    const names = (await readdir(RAW_DIR)).filter((n) => !n.startsWith(".")).sort();
    storedNames = deterministicSample(names, options.sampleSize, seed);
  }
  const files = await parseAllRawFiles(RAW_DIR, storedNames);
  const first = buildLedger(deterministicShuffle(files, `${seed}:0`, (file) => file.storedName));
  const firstFingerprint = ledgerFingerprint(first);
  for (let i = 1; i < permutations; i++) {
    const next = buildLedger(deterministicShuffle(files, `${seed}:${i}`, (file) => file.storedName));
    const nextFingerprint = ledgerFingerprint(next);
    if (firstFingerprint !== nextFingerprint) {
      throw new Error(
        `Order-dependence detected with seed ${seed}: permutation 0 ${firstFingerprint.slice(0, 16)} != permutation ${i} ${nextFingerprint.slice(0, 16)}`
      );
    }
  }
  return { fingerprint: firstFingerprint, tx: first.transactions.length, bal: first.balances.length, seed };
}

// CLI: `bun src/rebuild.ts` rebuilds the live DB; `--verify` only checks order-independence.
if (import.meta.main) {
  const verifyOnly = process.argv.includes("--verify");
  if (verifyOnly) {
    const r = await verify();
    console.log(`✓ order-independent — ${r.tx} transactions, ${r.bal} balances, fingerprint ${r.fingerprint.slice(0, 16)}`);
  } else {
    const r = await rebuild();
    console.log(`rebuilt: ${r.tx} transactions, ${r.bal} balances`);
    if (r.unmappedAliases.length) {
      console.log(`⚠ ${r.unmappedAliases.length} unmapped alias(es):`);
      for (const a of r.unmappedAliases) console.log(`   ${a.institution} / ${a.account}`);
    }
  }
}
