import { expect, test, beforeAll } from "bun:test";
import { buildLedger, ledgerFingerprint, type BuiltLedger, type ParsedFile } from "./rebuild";
import { activityBucket } from "./flowClassification";
import { seedReportFixture } from "./testFixtures";

const fixtureFiles: ParsedFile[] = [
  {
    filename: "fixture-statement.csv",
    storedName: "fixture-statement.csv",
    meta: {
      id: "fixture-statement",
      institution: "Fixture Bank",
      kind: "statement",
      priority: 10,
      matches: () => false,
    },
    transactions: [
      {
        id: "fixture-summary",
        date: "2026-03-31",
        amount_cents: 1_000_000,
        description: "Statement net cash flow",
        account: "Fixture Brokerage",
        institution: "Fixture Bank",
        category: "activity",
        raw: { type: "statement-cash-flow-summary", metric: "netCashFlow" },
      },
    ],
    balances: [
      {
        date: "2026-03-31",
        account: "Fixture Brokerage",
        institution: "Fixture Bank",
        balance_cents: 2_000_000,
      },
    ],
    covered_from: "2026-03-01",
    covered_to: "2026-03-31",
  },
  {
    filename: "fixture-activity.csv",
    storedName: "fixture-activity.csv",
    meta: {
      id: "fixture-activity",
      institution: "Fixture Bank",
      kind: "activity-export",
      priority: 100,
      matches: () => false,
    },
    transactions: [
      {
        id: "fixture-detail",
        date: "2026-03-15",
        amount_cents: 1_000_000,
        description: "Transfer in from checking",
        account: "Fixture Brokerage",
        institution: "Fixture Bank",
        category: "activity",
        raw: {},
      },
    ],
    balances: [],
    covered_from: "2026-03-01",
    covered_to: "2026-03-31",
  },
];

let ledger: BuiltLedger;
beforeAll(async () => {
  seedReportFixture();
  ledger = buildLedger(fixtureFiles);
}, 120_000);

test("rebuild is independent of raw import file order", async () => {
  const forward = buildLedger(fixtureFiles);
  const reverse = buildLedger([...fixtureFiles].reverse());

  expect(forward.transactions.length).toBeGreaterThan(0);
  expect(ledgerFingerprint(forward)).toBe(ledgerFingerprint(reverse));
  expect(ledgerFingerprint(forward)).toMatch(/^[a-f0-9]{64}$/);
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
