import { getDb } from "./db";
import { getNetWorthReport } from "./networth";

export interface SavingsRateAccount {
  id: number;
  name: string;
  institution: string;
  type: string;
}

export interface SavingsRateMonthlyRow {
  month: string;
  income_cents: number;
  retained_investment_cents: number;
  retained_cash_cents: number;
  poof_cents: number;
  net_retained_cents: number;
}

export interface SavingsRateIncomeSource {
  label: string;
  amount_cents: number;
  count: number;
}

export interface SavingsRateReport {
  accounts: SavingsRateAccount[];
  rows: SavingsRateMonthlyRow[];
  income_sources: SavingsRateIncomeSource[];
}

interface TransactionRow {
  id: string;
  date: string;
  month: string;
  account_id: number;
  amount_cents: number;
  description: string;
  raw: string;
  account_type: string;
}

const INVESTMENT_TYPES = new Set(["brokerage", "retirement"]);
const CASH_TYPES = new Set(["checking", "savings"]);

export function periodAllocation(input: {
  income_cents: number;
  investment_delta_cents: number;
  cash_delta_cents: number;
}): Omit<SavingsRateMonthlyRow, "month" | "income_cents"> {
  const net_retained_cents = input.investment_delta_cents + input.cash_delta_cents;
  let retained_investment_cents = 0;
  let retained_cash_cents = 0;

  if (net_retained_cents > 0) {
    if (input.investment_delta_cents > 0 && input.cash_delta_cents > 0) {
      retained_investment_cents = input.investment_delta_cents;
      retained_cash_cents = input.cash_delta_cents;
    } else if (input.investment_delta_cents > 0) {
      retained_investment_cents = net_retained_cents;
    } else if (input.cash_delta_cents > 0) {
      retained_cash_cents = net_retained_cents;
    }
  }

  return {
    retained_investment_cents,
    retained_cash_cents,
    net_retained_cents,
    poof_cents: Math.max(0, input.income_cents - net_retained_cents),
  };
}

export function isInternalMoneyMove(description: string): boolean {
  const d = description.toLowerCase();
  return (
    /online banking transfer/.test(d) ||
    /funds (received|paid|transferred)|fund ?transfers/.test(d) ||
    /transfer (in|out|from|to)|broker to broker|journaled/.test(d) ||
    /vanguard buy|sequoia des:investment|fid bkg svc .*moneyline/.test(d) ||
    /online payment from chk|payment from chk/.test(d) ||
    /sweep (in|out)/.test(d) ||
    /overdraft protection/.test(d)
  );
}

export function isExternalIncome(transaction: {
  amount_cents: number;
  description: string;
  raw?: string;
}): boolean {
  if (transaction.amount_cents <= 0) return false;
  if (isInternalMoneyMove(transaction.description)) return false;

  const d = transaction.description.toLowerCase();
  if (
    /401\(k\) contributions|rsu vest|espp purchase|direct deposit|payroll|salary|examplepayroll|example university uni/.test(d)
  ) {
    return true;
  }
  if (/interest|dividend|cap gain/.test(d)) return true;
  if (/\bdeposit\b/.test(d)) return true;

  try {
    const raw = transaction.raw ? JSON.parse(transaction.raw) as Record<string, unknown> : {};
    if (raw["section"] === "Deposits and other additions") return true;
  } catch {
    // Ignore malformed raw metadata; description-based classification still applies.
  }

  return false;
}

function incomeSourceLabel(description: string): string {
  const d = description.toLowerCase();
  if (/401\(k\) contributions/.test(d)) return "401(k) contributions";
  if (/rsu vest/.test(d)) return "RSU vesting";
  if (/espp purchase/.test(d)) return "ESPP purchase";
  if (/examplepayroll/.test(d)) return "Example Payroll payroll";
  if (/example university uni/.test(d)) return "Example University";
  if (/interest/.test(d)) return "Interest";
  if (/dividend|cap gain/.test(d)) return "Dividends";
  if (/\bdeposit\b/.test(d)) return "Deposits";
  return description.replace(/\s+/g, " ").slice(0, 80);
}

export function getSavingsRateReport(): SavingsRateReport {
  const db = getDb();
  const netWorth = getNetWorthReport();
  const accountById = new Map(netWorth.accounts.map((account) => [account.id, account]));
  const transferTransactionIds = new Set<string>();
  for (const link of netWorth.transfer_links) {
    for (const id of link.source_transaction_ids) transferTransactionIds.add(id);
    for (const id of link.destination_transaction_ids) transferTransactionIds.add(id);
  }

  const txs = db
    .query<TransactionRow, []>(
      `SELECT t.id, t.date, strftime('%Y-%m', t.date) as month, t.account_id, t.amount_cents,
              t.description, t.raw, a.type as account_type
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.account_id IS NOT NULL
       ORDER BY t.date`
    )
    .all();

  const incomeByMonth = new Map<string, number>();
  const sourceByLabel = new Map<string, SavingsRateIncomeSource>();
  const months = new Set<string>();

  for (const tx of txs) {
    months.add(tx.month);
    if (transferTransactionIds.has(tx.id)) continue;
    if (!isExternalIncome(tx)) continue;

    incomeByMonth.set(tx.month, (incomeByMonth.get(tx.month) ?? 0) + tx.amount_cents);
    const label = incomeSourceLabel(tx.description);
    const source = sourceByLabel.get(label) ?? { label, amount_cents: 0, count: 0 };
    source.amount_cents += tx.amount_cents;
    source.count += 1;
    sourceByLabel.set(label, source);
  }

  const deltasByMonth = new Map<string, { investment: number; cash: number }>();
  for (const row of netWorth.rows) {
    months.add(row.month);
    const account = accountById.get(row.account_id);
    if (!account) continue;

    const deltas = deltasByMonth.get(row.month) ?? { investment: 0, cash: 0 };
    if (INVESTMENT_TYPES.has(account.type)) {
      deltas.investment += row.contributions_cents;
    } else if (CASH_TYPES.has(account.type)) {
      deltas.cash += row.contributions_cents;
    }
    deltasByMonth.set(row.month, deltas);
  }

  const firstIncomeMonth = [...incomeByMonth.keys()].sort()[0] ?? null;
  const rows = [...months]
    .filter((month) => firstIncomeMonth === null || month >= firstIncomeMonth)
    .sort()
    .map((month): SavingsRateMonthlyRow => {
      const income_cents = incomeByMonth.get(month) ?? 0;
      const deltas = deltasByMonth.get(month) ?? { investment: 0, cash: 0 };
      return {
        month,
        income_cents,
        ...periodAllocation({
          income_cents,
          investment_delta_cents: deltas.investment,
          cash_delta_cents: deltas.cash,
        }),
      };
    });

  return {
    accounts: netWorth.accounts.map(({ id, name, institution, type }) => ({ id, name, institution, type })),
    rows,
    income_sources: [...sourceByLabel.values()].sort((a, b) => b.amount_cents - a.amount_cents),
  };
}
