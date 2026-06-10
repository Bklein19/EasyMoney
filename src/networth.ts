import { getDb } from "./db";

export interface AccountSummary {
  id: number;
  name: string;
  institution: string;
  type: string;
  classification: string;
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
function classify(description: string): "contribution" | "dividend" | "interest" | "internal" {
  const d = description.toLowerCase();
  if (d.includes("dividend")) return "dividend";
  if (d.includes("interest")) return "interest";
  if (/funds received|transfer (in|from)|contribution|rollover|\beft\b|\bach\b|direct deposit/.test(d)) {
    return "contribution";
  }
  return "internal";
}

export function getNetWorthReport(): NetWorthReport {
  const db = getDb();

  const accounts = db
    .query<AccountSummary, []>(
      "SELECT id, name, institution, type, classification FROM accounts ORDER BY institution, name"
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
       FROM account_balances WHERE account_id IS NOT NULL
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

  for (const account of accounts) {
    let prevBalance: number | null = null;
    let prevBalanceMonth: string | null = null;
    for (const month of sortedMonths) {
      const f = flows.get(flowKey(month, account.id)) ?? {
        contributions: 0,
        dividends: 0,
        interest: 0,
      };
      const endBalance = balanceMap.get(flowKey(month, account.id)) ?? null;

      // Market gains are the residual: change in value minus everything we can attribute.
      // When balance snapshots aren't consecutive months, sum all flows in the gap so
      // contributions between snapshots don't get misattributed as gains.
      let gains: number | null = null;
      if (endBalance !== null && prevBalance !== null && prevBalanceMonth !== null) {
        let totalContributions = 0, totalDividends = 0, totalInterest = 0;
        for (const m of sortedMonths) {
          if (m <= prevBalanceMonth || m > month) continue;
          const mf = flows.get(flowKey(m, account.id));
          if (mf) {
            totalContributions += mf.contributions;
            totalDividends += mf.dividends;
            totalInterest += mf.interest;
          }
        }
        gains = endBalance - prevBalance - totalContributions - totalDividends - totalInterest;
      }
      if (endBalance !== null) {
        prevBalance = endBalance;
        prevBalanceMonth = month;
      }

      const hasActivity =
        f.contributions !== 0 || f.dividends !== 0 || f.interest !== 0 || endBalance !== null;
      if (!hasActivity) continue;

      rows.push({
        month,
        account_id: account.id,
        contributions_cents: f.contributions,
        dividends_cents: f.dividends,
        interest_cents: f.interest,
        gains_cents: gains,
        end_balance_cents: endBalance,
      });
    }
  }

  return { accounts, rows };
}
