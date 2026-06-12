import { getDb } from "./db";
import { classifyFlow } from "./flowClassification";
import { summarizeReturns, type ReturnSummary } from "./returns";
import { deriveTransferLinks, type TransferLink } from "./transferLinks";

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
  transfer_links: TransferLink[];
  returns: ReturnSummary[];
}

function isCashLikeAccount(account: { type: string }): boolean {
  return ["checking", "savings", "credit-card", "loan"].includes(account.type);
}

export function getNetWorthReport(): NetWorthReport {
  const db = getDb();

  const accounts = db
    .query<AccountSummary, []>(
      "SELECT id, name, institution, type, classification, flow_treatment FROM accounts ORDER BY institution, name"
    )
    .all();

  const txs = db
    .query<{ id: string; date: string; month: string; account_id: number; amount_cents: number; description: string }, []>(
      `SELECT id, date, strftime('%Y-%m', date) as month, account_id, amount_cents, description
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

  const balanceSnapshots = db
    .query<{ date: string; account_id: number; balance_cents: number }, []>(
      `SELECT date, account_id, balance_cents
       FROM (
         SELECT date, account_id, balance_cents FROM account_balances WHERE account_id IS NOT NULL
         UNION ALL
         SELECT date, account_id, balance_cents FROM manual_balances
       )
       ORDER BY account_id, date`
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
    const kind = classifyFlow(t.description);
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

    // --- Cash/pass-through accounts: unexplained changes are contributions, never gains ---
    if (account.flow_treatment === "contributions" || isCashLikeAccount(account)) {
      for (const [m, g] of gainsByMonth) {
        if (g !== 0) contribAdjust.set(m, (contribAdjust.get(m) ?? 0) + g);
        gainsByMonth.set(m, 0);
      }
    }

    perAccount.set(account.id, { gainsByMonth, contribAdjust, gainsAdjust, firstMonth, startingAmount });
  }

  const transferFacts = deriveTransferLinks({
    accounts,
    sortedMonths,
    flows,
    balances: balanceMap,
    seeds: new Map(
      [...perAccount].map(([account_id, pa]) => [
        account_id,
        {
          account_id,
          firstMonth: pa.firstMonth,
          startingAmount: pa.startingAmount,
          contributionAdjustments: pa.contribAdjust,
        },
      ])
    ),
    transactions: txs,
  });
  for (const adj of transferFacts.adjustments) {
    const pa = perAccount.get(adj.account_id)!;
    pa.contribAdjust.set(adj.month, (pa.contribAdjust.get(adj.month) ?? 0) + adj.contributions_cents);
    pa.gainsAdjust.set(adj.month, (pa.gainsAdjust.get(adj.month) ?? 0) + adj.gains_cents);
  }

  const returnSummaries: ReturnSummary[] = [];
  for (const account of accounts) {
    const summary = summarizeReturns({
      account_id: account.id,
      balances: balanceSnapshots
        .filter((balance) => balance.account_id === account.id)
        .map((balance) => ({ date: balance.date, balance_cents: balance.balance_cents })),
      contribution_flows: txs
        .filter((tx) => tx.account_id === account.id && classifyFlow(tx.description) === "contribution")
        .map((tx) => ({ date: tx.date, amount_cents: tx.amount_cents })),
    });
    if (summary) returnSummaries.push(summary);
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

  return { accounts, rows, transfer_links: transferFacts.links, returns: returnSummaries };
}
