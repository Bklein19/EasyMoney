import { expect, test, beforeAll } from "bun:test";
import { parseAllRawFiles, buildLedger, verify, type BuiltLedger } from "./rebuild";
import { activityBucket } from "./flowClassification";

// Parsing every raw file (PDFs via pdftotext) is slow; do it once for the whole suite.
let ledger: BuiltLedger;
beforeAll(async () => {
  ledger = buildLedger(await parseAllRawFiles());
}, 120_000);

test("rebuild is independent of raw import file order", async () => {
  const result = await verify({ sampleSize: 32, permutations: 8 });

  expect(result.tx).toBeGreaterThan(0);
  expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(result.seed).toMatch(/^[a-f0-9]{32}$/);
}, 60_000);

// Regression guard for cross-source double-counting (the Merrill bug): a coarse
// statement-cash-flow-summary row and itemized detail for the SAME (account, month,
// bucket) must never both survive dedup — one is a stand-in for the other. This is
// institution-agnostic: it keys on the general summary tag + flow bucket, so any
// parser whose summaries fail to dedup against detail trips it. A pure
// contributions+income+gains == balance check would NOT catch this (the derived
// gains field silently absorbs the inflated contributions), which is why this asserts
// the structural non-coexistence directly.
test("no statement summary coexists with itemized detail in the same account-month-bucket", () => {
  const seen = new Map<string, { summary: boolean; detail: boolean }>();
  for (const t of ledger.transactions) {
    const bucket = activityBucket(t);
    if (bucket === "other") continue;
    const isSummary = (t.raw as { type?: string }).type === "statement-cash-flow-summary";
    const key = `${t.account_id}|${t.date.slice(0, 7)}|${bucket}`;
    const e = seen.get(key) ?? { summary: false, detail: false };
    if (isSummary) e.summary = true;
    else e.detail = true;
    seen.set(key, e);
  }
  const collisions = [...seen.entries()]
    .filter(([, e]) => e.summary && e.detail)
    .map(([k]) => k);
  expect(collisions, `summary+detail double-count in: ${collisions.join(", ")}`).toEqual([]);
}, 20_000);

// Reconciliation sanity: for every investment account with balance snapshots, the
// cumulative contributions + income + gains must equal the latest balance. Gains are
// derived to make this hold, so a failure means a structural bug in the report
// pipeline itself (e.g. a balance dropped, or a row attributed to the wrong account).
test("investment accounts reconcile: contributions + income + gains == latest balance", async () => {
  const { getNetWorthReport } = await import("./networth");
  const report = getNetWorthReport();
  const offenders: string[] = [];
  for (const a of report.accounts) {
    if (!["brokerage", "retirement"].includes(a.type)) continue;
    const rows = report.rows
      .filter((r) => r.account_id === a.id)
      .sort((x, y) => (x.month < y.month ? -1 : 1));
    const withBalance = rows.filter((r) => r.end_balance_cents !== null);
    if (withBalance.length === 0) continue;
    const lastBalanceMonth = withBalance[withBalance.length - 1]!.month;
    // Only sum flows up to (and including) the last balance snapshot — contributions
    // recorded in a later month than the last statement legitimately won't reconcile.
    const sum = rows
      .filter((r) => r.month <= lastBalanceMonth)
      .reduce(
        (s, r) => s + r.contributions_cents + r.dividends_cents + r.interest_cents + (r.gains_cents ?? 0),
        0
      );
    const balance = withBalance[withBalance.length - 1]!.end_balance_cents!;
    if (Math.abs(sum - balance) > 100) {
      offenders.push(`${a.institution}/${a.name}: sum ${sum} vs balance ${balance}`);
    }
  }
  expect(offenders, offenders.join("; ")).toEqual([]);
}, 20_000);
