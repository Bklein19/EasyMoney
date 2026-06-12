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
import { readdir } from "fs/promises";
import { join } from "path";
import { resolveParser } from "../parsers";
import { lookupAlias } from "./accounts";
import { getDb } from "./db";
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
export async function parseAllRawFiles(rawDir = RAW_DIR): Promise<ParsedFile[]> {
  const names = (await readdir(rawDir)).filter((n) => !n.startsWith(".")).sort();
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

const monthOf = (date: string) => date.slice(0, 7); // YYYY-MM

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

// Pure function: parsed files → canonical ledger. This is the order-independence
// guarantee, expressed without touching the database.
//
// Dedup rule (category-aware source priority):
//   - "in-kind-transfer" transactions are ALWAYS kept (they live only on statements;
//     activity-exports structurally never contain them).
//   - "activity" transactions: for each (account, month), the highest-priority source
//     KIND that covers that month wins. A statement's activity rows are dropped when an
//     activity-export (higher priority) covers the same (account, month). Coverage is
//     the file's [covered_from, covered_to] range — robust to gaps in a given month.
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
  const coverKey = (acctKey: string, month: string) => `${acctKey}\0${month}`;

  // Highest "activity"-row source priority covering each (canonical account, month).
  const bestActivityPriority = new Map<string, number>();
  for (const f of files) {
    if (!f.covered_from || !f.covered_to) continue;
    const acctKeys = new Set(
      f.transactions.filter((t) => t.category === "activity").map((t) => acctKeyOf(t.institution, t.account))
    );
    if (acctKeys.size === 0) continue;
    const fromM = monthOf(f.covered_from);
    const toM = monthOf(f.covered_to);
    for (const ak of acctKeys) {
      for (let m = fromM; m <= toM; m = nextMonth(m)) {
        const k = coverKey(ak, m);
        if (f.meta.priority > (bestActivityPriority.get(k) ?? -Infinity)) {
          bestActivityPriority.set(k, f.meta.priority);
        }
      }
    }
  }

  // Union by deterministic id, applying the category-aware drop on canonical accounts.
  const txById = new Map<string, ParsedTransaction>();
  for (const f of files) {
    for (const t of f.transactions) {
      if (t.category === "activity") {
        const best = bestActivityPriority.get(coverKey(acctKeyOf(t.institution, t.account), monthOf(t.date)));
        if (best !== undefined && f.meta.priority < best) continue; // a higher source owns this month
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

function nextMonth(ym: string): string {
  let [y, m] = ym.split("-").map(Number) as [number, number];
  m += 1;
  if (m > 12) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
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
  const { createHash } = require("crypto") as typeof import("crypto");
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

// Prove order-independence: build the ledger from files in forward order and again
// from the reverse, and assert identical fingerprints. Returns the fingerprint on
// success; throws on mismatch. Pure — does not touch the live DB.
export async function verify(): Promise<{ fingerprint: string; tx: number; bal: number }> {
  const files = await parseAllRawFiles();
  const forward = buildLedger(files);
  const reverse = buildLedger([...files].reverse());
  const fF = ledgerFingerprint(forward);
  const fR = ledgerFingerprint(reverse);
  if (fF !== fR) {
    throw new Error(`Order-dependence detected: forward ${fF.slice(0, 16)} != reverse ${fR.slice(0, 16)}`);
  }
  return { fingerprint: fF, tx: forward.transactions.length, bal: forward.balances.length };
}

// CLI: `bun src/rebuild.ts` rebuilds the live DB; `--verify` only checks order-independence.
if (import.meta.main) {
  const verifyOnly = process.argv.includes("--verify");
  if (verifyOnly) {
    const r = await verify();
    console.log(`✓ order-independent — ${r.tx} transactions, ${r.bal} balances, fingerprint ${r.fingerprint.slice(0, 16)}`);
  } else {
    // Verify first so we never write a ledger that isn't order-independent.
    const v = await verify();
    const r = await rebuild();
    console.log(`rebuilt: ${r.tx} transactions, ${r.bal} balances (verified ${v.fingerprint.slice(0, 16)})`);
    if (r.unmappedAliases.length) {
      console.log(`⚠ ${r.unmappedAliases.length} unmapped alias(es):`);
      for (const a of r.unmappedAliases) console.log(`   ${a.institution} / ${a.account}`);
    }
  }
}
