import { getDb } from "./db";

export interface AccountSummary {
  id: number;
  name: string;
  institution: string;
  type: string;
  classification: string;
  flow_treatment: string;
}

export interface MonthlyRow {
  month: string; // YYYY-MM
  account_id: number;
  contributions_cents: number;
  dividends_cents: number;
  interest_cents: number;
  gains_cents: number | null; // null when no balance snapshots exist for the account
  end_balance_cents: number | null;
}

export interface NetWorthReport {
  accounts: AccountSummary[];
  rows: MonthlyRow[];
}

// Classify a transaction as an external flow or investment income based on its description.
// "internal" covers buys, sells, sweeps, reinvestments — money moving within the account.
// Transfers between own accounts count as (signed) contributions on both sides so they
// cancel in aggregate: out of one account (−), into the other (+).
function classify(description: string): "contribution" | "dividend" | "interest" | "internal" {
  const d = description.toLowerCase();
  if (/dividend|cap gain rein|cg rein|income rein/.test(d)) return "dividend";
  if (d.includes("interest")) return "interest";
  if (
    /funds received|funds transferred|transfer (in|out|from)|contribution|conversion|rollover|broker to broker|journaled|rsu vest|espp purchase|shares purchased|shares redeemed|fund purchase|\beft\b|\bach\b|direct deposit/.test(d)
  ) {
    return "contribution";
  }
  return "internal";
}

export function getNetWorthReport(): NetWorthReport {
  const db = getDb();

  const accounts = db
    .query<AccountSummary, []>(
      "SELECT id, name, institution, type, classification, flow_treatment FROM accounts ORDER BY institution, name"
    )
    .all();

  const txs = db
    .query<{ month: string; account_id: number; amount_cents: number; description: string }, []>(
      `SELECT strftime('%Y-%m', date) as month, account_id, amount_cents, description
       FROM transactions WHERE account_id IS NOT NULL ORDER BY date`
    )
    .all();

  const balances = db
    .query<{ month: string; account_id: number; balance_cents: number }, []>(
      `SELECT strftime('%Y-%m', date) as month, account_id, balance_cents
       FROM (
         SELECT date, account_id, balance_cents FROM account_balances WHERE account_id IS NOT NULL
         UNION ALL
         SELECT date, account_id, balance_cents FROM manual_balances
       )
       GROUP BY month, account_id HAVING date = MAX(date)`
    )
    .all();

  // Aggregate flows per (month, account)
  const flowKey = (m: string, a: number) => `${m}|${a}`;
  const flows = new Map<string, { contributions: number; dividends: number; interest: number }>();
  const months = new Set<string>();

  for (const t of txs) {
    months.add(t.month);
    const key = flowKey(t.month, t.account_id);
    let f = flows.get(key);
    if (!f) {
      f = { contributions: 0, dividends: 0, interest: 0 };
      flows.set(key, f);
    }
    const kind = classify(t.description);
    if (kind === "contribution") f.contributions += t.amount_cents;
    else if (kind === "dividend") f.dividends += t.amount_cents;
    else if (kind === "interest") f.interest += t.amount_cents;
  }

  const balanceMap = new Map<string, number>();
  const accountsWithBalances = new Set<number>();
  for (const b of balances) {
    months.add(b.month);
    balanceMap.set(flowKey(b.month, b.account_id), b.balance_cents);
    accountsWithBalances.add(b.account_id);
  }

  const sortedMonths = [...months].sort();
  const rows: MonthlyRow[] = [];

  interface AccountAttribution {
    gainsByMonth: Map<string, number>;
    contribAdjust: Map<string, number>;
    gainsAdjust: Map<string, number>;
    firstMonth: string | null;
    startingAmount: number;
  }
  const perAccount = new Map<number, AccountAttribution>();

  for (const account of accounts) {
    // --- Pass 1: identify snapshot gaps and compute total gains per gap ---
    // gainsByMonth[month] = gains_cents to attribute to that month (spread evenly across gap)
    const gainsByMonth = new Map<string, number>();

    let prevBalance: number | null = null;
    let prevBalanceMonth: string | null = null;
    for (const month of sortedMonths) {
      const endBalance = balanceMap.get(flowKey(month, account.id)) ?? null;
      if (endBalance !== null && prevBalance !== null && prevBalanceMonth !== null) {
        // Sum all flows between the two snapshots (exclusive of prevBalanceMonth, inclusive of month)
        let totalFlows = 0;
        const gapMonths: string[] = [];
        for (const m of sortedMonths) {
          if (m <= prevBalanceMonth || m > month) continue;
          gapMonths.push(m);
          const mf = flows.get(flowKey(m, account.id));
          if (mf) totalFlows += mf.contributions + mf.dividends + mf.interest;
        }
        const totalGains = endBalance - prevBalance - totalFlows;
        // Spread gains exponentially across the gap: assume a constant monthly growth rate r
        // such that prevBalance * (1+r)^n = endBalance (ignoring flows for the rate estimate).
        // Each month's gain slice is proportional to the account value at the start of that month.
        const n = gapMonths.length;
        if (n > 0) {
          // Monthly growth rate from balance ratio (flows affect absolute values but not the rate shape)
          const r = Math.pow(endBalance / Math.max(prevBalance, 1), 1 / n) - 1;
          // Simulated balance at start of each month (just for weighting, ignoring intra-gap flows)
          const weights: number[] = [];
          let sim = prevBalance;
          for (let i = 0; i < n; i++) {
            weights.push(sim * r); // gain attributed to this month ∝ balance * rate
            sim *= (1 + r);
          }
          const weightSum = weights.reduce((a, b) => a + b, 0);
          let distributed = 0;
          for (let i = 0; i < n; i++) {
            const slice = i < n - 1
              ? Math.round(totalGains * (weightSum === 0 ? 1 / n : weights[i]! / weightSum))
              : totalGains - distributed;
            gainsByMonth.set(gapMonths[i]!, (gainsByMonth.get(gapMonths[i]!) ?? 0) + slice);
            if (i < n - 1) distributed += slice;
          }
        }
      }
      if (endBalance !== null) {
        prevBalance = endBalance;
        prevBalanceMonth = month;
      }
    }

    // --- Starting balance: history predating our data is contributions, not gains ---
    // The first snapshot's level, minus any flows we already know about up to that
    // month, represents money the user put in before imports began.
    const contribAdjust = new Map<string, number>();
    const gainsAdjust = new Map<string, number>();
    let firstMonth: string | null = null;
    let firstBalance = 0;
    for (const month of sortedMonths) {
      const b = balanceMap.get(flowKey(month, account.id));
      if (b !== undefined) {
        firstMonth = month;
        firstBalance = b;
        break;
      }
    }
    let startingAmount = 0;
    if (firstMonth !== null) {
      let flowsThrough = 0;
      for (const m of sortedMonths) {
        if (m > firstMonth) break;
        const mf = flows.get(flowKey(m, account.id));
        if (mf) flowsThrough += mf.contributions + mf.dividends + mf.interest;
      }
      startingAmount = firstBalance - flowsThrough;
      if (startingAmount !== 0) contribAdjust.set(firstMonth, startingAmount);
    }

    // --- Pass-through accounts: unexplained changes are contributions, never gains ---
    if (account.flow_treatment === "contributions") {
      for (const [m, g] of gainsByMonth) {
        if (g !== 0) contribAdjust.set(m, (contribAdjust.get(m) ?? 0) + g);
        gainsByMonth.set(m, 0);
      }
    }

    perAccount.set(account.id, { gainsByMonth, contribAdjust, gainsAdjust, firstMonth, startingAmount });
  }

  // --- In-kind transfer linking ---
  // When an account's starting balance matches another account's transfer-out in the
  // same (or previous) month, the money isn't new: carry the source's cost basis over.
  // The source's cumulative contributions arrive as contributions; the rest is gains
  // that transferred with the position.
  const monthBefore = (m: string) => sortedMonths[sortedMonths.indexOf(m) - 1] ?? null;

  // Cumulative contributions for an account through the end of `beforeMonth` (exclusive),
  // with return-of-capital ordering (never below zero).
  const basisThrough = (accountId: number, beforeMonth: string): number => {
    const pa = perAccount.get(accountId)!;
    let cum = 0;
    for (const m of sortedMonths) {
      if (m >= beforeMonth) break;
      const f = flows.get(flowKey(m, accountId));
      cum += (f?.contributions ?? 0) + (pa.contribAdjust.get(m) ?? 0);
      if (cum < 0) cum = 0;
    }
    return cum;
  };

  for (const account of accounts) {
    const pa = perAccount.get(account.id)!;
    if (pa.firstMonth === null || pa.startingAmount < 100_000) continue; // ignore < $1k

    // Candidate sources: accounts with a matching net transfer-out around the start month
    const candidates: Array<{ id: number; outflowMonth: string }> = [];
    for (const other of accounts) {
      if (other.id === account.id) continue;
      for (const m of [pa.firstMonth, monthBefore(pa.firstMonth)]) {
        if (!m) continue;
        const out = flows.get(flowKey(m, other.id))?.contributions ?? 0;
        if (out < 0 && Math.abs(out) >= pa.startingAmount * 0.95 && Math.abs(out) <= pa.startingAmount * 1.05) {
          candidates.push({ id: other.id, outflowMonth: m });
          break;
        }
      }
    }
    if (candidates.length !== 1) continue;

    const source = candidates[0]!;
    const sourceBasis = basisThrough(source.id, source.outflowMonth);
    const basisCarried = Math.min(pa.startingAmount, sourceBasis);
    const gainsCarried = pa.startingAmount - basisCarried;

    pa.contribAdjust.set(pa.firstMonth, basisCarried);
    if (gainsCarried !== 0) pa.gainsAdjust.set(pa.firstMonth, gainsCarried);

    // Split the source's outflow the same way: basis comes out of contributions,
    // the rest out of gains — so the two sides cancel when viewed together.
    const spa = perAccount.get(source.id)!;
    const outflow = flows.get(flowKey(source.outflowMonth, source.id))?.contributions ?? 0; // negative
    const basisPart = -Math.min(-outflow, sourceBasis);
    const gainsPart = outflow - basisPart; // negative remainder beyond basis
    if (gainsPart !== 0) {
      spa.contribAdjust.set(source.outflowMonth, (spa.contribAdjust.get(source.outflowMonth) ?? 0) - gainsPart);
      spa.gainsAdjust.set(source.outflowMonth, (spa.gainsAdjust.get(source.outflowMonth) ?? 0) + gainsPart);
    }
  }

  // --- Emit rows ---
  for (const account of accounts) {
    const pa = perAccount.get(account.id)!;
    for (const month of sortedMonths) {
      const f = flows.get(flowKey(month, account.id)) ?? {
        contributions: 0,
        dividends: 0,
        interest: 0,
      };
      const adjust = pa.contribAdjust.get(month) ?? 0;
      const gAdjust = pa.gainsAdjust.get(month) ?? 0;
      const endBalance = balanceMap.get(flowKey(month, account.id)) ?? null;
      // gains_cents is null for months outside any snapshot gap (no balance data at all)
      const gapGains = pa.gainsByMonth.has(month) ? pa.gainsByMonth.get(month)! : null;
      const gains = gAdjust !== 0 ? (gapGains ?? 0) + gAdjust : gapGains;

      const hasActivity =
        f.contributions !== 0 || f.dividends !== 0 || f.interest !== 0 ||
        adjust !== 0 || endBalance !== null || gains !== null;
      if (!hasActivity) continue;

      rows.push({
        month,
        account_id: account.id,
        contributions_cents: f.contributions + adjust,
        dividends_cents: f.dividends,
        interest_cents: f.interest,
        gains_cents: gains,
        end_balance_cents: endBalance,
      });
    }
  }

  return { accounts, rows };
}
