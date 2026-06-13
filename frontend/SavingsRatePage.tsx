import React, { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Period = "month" | "quarter" | "year";

interface SavingsRateMonthlyRow {
  month: string;
  income_cents: number;
  market_income_cents: number;
  income_ex_market_gains_cents: number;
  investment_change_cents: number;
  cash_change_cents: number;
  poof_cents: number;
  net_retained_cents: number;
}

interface SavingsRateIncomeSource {
  label: string;
  amount_cents: number;
  count: number;
  is_market_income: boolean;
}

interface SavingsRateAccountMonth {
  account_id: number;
  month: string;
  income_cents: number;
  market_income_cents: number;
  investment_delta_cents: number;
  cash_delta_cents: number;
}

interface SavingsRateAccountSource {
  account_id: number;
  label: string;
  amount_cents: number;
  count: number;
  is_market_income: boolean;
}

interface SavingsRateReport {
  rows: SavingsRateMonthlyRow[];
  account_months: SavingsRateAccountMonth[];
  income_sources: SavingsRateIncomeSource[];
  account_sources: SavingsRateAccountSource[];
}

// Mirror of the server's periodAllocation: poof/net_retained are non-additive across
// accounts, so we recompute them after summing the selected accounts' components.
function periodAllocation(income_cents: number, investment_delta_cents: number, cash_delta_cents: number) {
  const net_retained_cents = investment_delta_cents + cash_delta_cents;
  return {
    investment_change_cents: investment_delta_cents,
    cash_change_cents: cash_delta_cents,
    net_retained_cents,
    poof_cents: Math.max(0, income_cents - net_retained_cents),
  };
}

interface PeriodRow {
  period: string;
  sortKey: string;
  grossIncome: number;
  income: number;
  marketIncome: number;
  investment: number;
  cash: number;
  poof: number;
  poofOut: number;
  retained: number;
  retainedPositive: number | null;
  retainedNegative: number | null;
}

const fmtUsd = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const fmtPct = (v: number | null) =>
  v === null
    ? "—"
    : v.toLocaleString("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

const fmtUsdAxis = (v: number) =>
  Math.abs(v) >= 999_500
    ? `$${(v / 1_000_000).toFixed(Math.abs(v) >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`
    : Math.abs(v) >= 1000
      ? `$${(v / 1000).toFixed(0)}k`
      : `$${v.toFixed(0)}`;

const retainedColor = "#7aa7ff";
const poofColor = "#e05252";

const periodKey = (month: string, period: Period) => {
  if (period === "month") return month;
  const year = month.slice(0, 4);
  if (period === "year") return year;
  return `${year} Q${Math.ceil(Number(month.slice(5, 7)) / 3)}`;
};

export function SavingsRatePage({ selectedIds }: { selectedIds: Set<number> }) {
  const [report, setReport] = useState<SavingsRateReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("year");

  useEffect(() => {
    fetch("/api/savings-rate")
      .then((r) => r.json())
      .then((data) => setReport(data as SavingsRateReport))
      .catch((e) => setError(String(e)));
  }, []);

  // Rebuild monthly rows from per-account components, summing only the selected
  // accounts, then run the (non-additive) savings-rate allocation per month.
  const monthlyRows = useMemo<SavingsRateMonthlyRow[]>(() => {
    if (!report) return [];
    const byMonth = new Map<string, { income: number; market: number; inv: number; cash: number }>();
    for (const am of report.account_months) {
      if (!selectedIds.has(am.account_id)) continue;
      const m = byMonth.get(am.month) ?? { income: 0, market: 0, inv: 0, cash: 0 };
      m.income += am.income_cents;
      m.market += am.market_income_cents;
      m.inv += am.investment_delta_cents;
      m.cash += am.cash_delta_cents;
      byMonth.set(am.month, m);
    }
    return [...byMonth.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, m]) => ({
        month,
        income_cents: m.income,
        market_income_cents: m.market,
        income_ex_market_gains_cents: m.income - m.market,
        ...periodAllocation(m.income - m.market, m.inv, m.cash),
      }));
  }, [report, selectedIds]);

  const rows = useMemo(() => {
    if (!report) return [];
    const byPeriod = new Map<string, PeriodRow>();
    for (const row of monthlyRows) {
      const key = periodKey(row.month, period);
      const point = byPeriod.get(key) ?? {
        period: key,
        sortKey: row.month,
        grossIncome: 0,
        income: 0,
        marketIncome: 0,
        investment: 0,
        cash: 0,
        poof: 0,
        poofOut: 0,
        retained: 0,
        retainedPositive: null,
        retainedNegative: null,
      };
      if (row.month < point.sortKey) point.sortKey = row.month;
      point.grossIncome += row.income_cents / 100;
      point.income += row.income_ex_market_gains_cents / 100;
      point.marketIncome += row.market_income_cents / 100;
      point.investment += row.investment_change_cents / 100;
      point.cash += row.cash_change_cents / 100;
      point.poof += row.poof_cents / 100;
      point.poofOut -= row.poof_cents / 100;
      point.retained += row.net_retained_cents / 100;
      point.retainedPositive = point.retained > 0 ? point.retained : null;
      point.retainedNegative = point.retained < 0 ? point.retained : null;
      byPeriod.set(key, point);
    }
    return [...byPeriod.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }, [monthlyRows, period]);

  // Income sources, summed across only the selected accounts.
  const incomeSources = useMemo<SavingsRateIncomeSource[]>(() => {
    if (!report) return [];
    const byLabel = new Map<string, SavingsRateIncomeSource>();
    for (const s of report.account_sources) {
      if (!selectedIds.has(s.account_id)) continue;
      const existing = byLabel.get(s.label) ?? { label: s.label, amount_cents: 0, count: 0, is_market_income: s.is_market_income };
      existing.amount_cents += s.amount_cents;
      existing.count += s.count;
      existing.is_market_income = existing.is_market_income || s.is_market_income;
      byLabel.set(s.label, existing);
    }
    return [...byLabel.values()].sort((a, b) => b.amount_cents - a.amount_cents);
  }, [report, selectedIds]);

  const totals = useMemo(() => {
    const income = rows.reduce((sum, row) => sum + row.income, 0);
    const grossIncome = rows.reduce((sum, row) => sum + row.grossIncome, 0);
    const marketIncome = rows.reduce((sum, row) => sum + row.marketIncome, 0);
    const retained = rows.reduce((sum, row) => sum + row.retained, 0);
    const investment = rows.reduce((sum, row) => sum + row.investment, 0);
    const cash = rows.reduce((sum, row) => sum + row.cash, 0);
    const poof = income - retained;
    return {
      income,
      grossIncome,
      marketIncome,
      retained,
      investment,
      cash,
      poof,
      rate: income > 0 ? retained / income : null,
    };
  }, [rows]);

  if (error) return <div className="page page-wide"><div className="meta import-error">{error}</div></div>;
  if (!report) return <div className="page page-wide"><div className="empty-state">Loading…</div></div>;

  return (
    <div className="page page-savings-rate">
      <div className="chart-section-header returns-header">
        <div>
          <div className="chart-title">Savings Rate</div>
          <div className="chart-subtitle">Income excluding dividends and interest, split into retained wealth and poof</div>
        </div>
        <div className="segmented-control" role="group" aria-label="Savings rate period">
          {(["month", "quarter", "year"] as const).map((p) => (
            <button key={p} type="button" className={period === p ? "active" : ""} onClick={() => setPeriod(p)}>
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="totals-row savings-summary-row">
        <div className="total-card total-card-highlight">
          <div className="total-label">Savings rate</div>
          <div className="total-value">{fmtPct(totals.rate)}</div>
        </div>
        <div className="total-card">
          <div className="total-label">Income</div>
          <div className="total-value">{fmtUsd(totals.income)}</div>
        </div>
        <div className="total-card">
          <div className="total-label">Investment income</div>
          <div className="total-value">{fmtUsd(totals.marketIncome)}</div>
        </div>
        <div className="total-card">
          <div className="total-label">Retained</div>
          <div className="total-value">{fmtUsd(totals.retained)}</div>
        </div>
        <div className="total-card">
          <div className="total-label">Poof</div>
          <div className="total-value">{fmtUsd(totals.poof)}</div>
        </div>
      </div>

      <div className="chart-container savings-rate-chart">
        <ResponsiveContainer width="100%" height={380}>
          <BarChart
            data={rows}
            stackOffset="sign"
            barCategoryGap={period === "month" ? "18%" : "32%"}
            barGap={3}
            margin={{ top: 8, right: 24, bottom: 8, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis dataKey="period" stroke="#555" tick={{ fontSize: 11 }} />
            <YAxis stroke="#555" tick={{ fontSize: 11 }} tickFormatter={fmtUsdAxis} />
            <Tooltip
              formatter={(value) => fmtUsd(Number(value))}
              contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8 }}
              labelStyle={{ color: "#888" }}
            />
            <Bar dataKey="retainedPositive" name="Net retained" stackId="flow" fill={retainedColor} />
            <Bar dataKey="poofOut" name="Poof" stackId="flow" fill={poofColor} />
            <Bar dataKey="retainedNegative" name="Net retained" stackId="flow" fill={retainedColor} />
          </BarChart>
        </ResponsiveContainer>
        <div className="returns-account-legend">
          <div className="returns-account-legend-item"><span style={{ background: retainedColor }} /> Net retained</div>
          <div className="returns-account-legend-item"><span style={{ background: poofColor }} /> Poof</div>
        </div>
      </div>

      <div className="savings-grid">
        <section>
          <div className="return-subsection-title">Periods</div>
          <div className="returns-table-wrap">
            <table className="returns-table savings-table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th className="num">Income</th>
                  <th className="num">Investment income</th>
                  <th className="num">Gross income</th>
                  <th className="num">Investment change</th>
                  <th className="num">Cash change</th>
                  <th className="num">Poof</th>
                  <th className="num">Rate</th>
                </tr>
              </thead>
              <tbody>
                {[...rows].reverse().map((row) => (
                  <tr key={row.period}>
                    <td>{row.period}</td>
                    <td className="num">{fmtUsd(row.income)}</td>
                    <td className="num">{fmtUsd(row.marketIncome)}</td>
                    <td className="num">{fmtUsd(row.grossIncome)}</td>
                    <td className="num">{fmtUsd(row.investment)}</td>
                    <td className="num">{fmtUsd(row.cash)}</td>
                    <td className="num">{fmtUsd(row.poof)}</td>
                    <td className="num return-rate">{fmtPct(row.income > 0 ? row.retained / row.income : null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section>
          <div className="return-subsection-title">Income Sources</div>
          <div className="returns-table-wrap">
            <table className="returns-table savings-source-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Kind</th>
                  <th className="num">Count</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {incomeSources.slice(0, 12).map((source) => (
                  <tr key={source.label}>
                    <td>{source.label}</td>
                    <td>{source.is_market_income ? "Investment" : "Income"}</td>
                    <td className="num">{source.count}</td>
                    <td className="num">{fmtUsd(source.amount_cents / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
