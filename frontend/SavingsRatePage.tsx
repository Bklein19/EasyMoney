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

interface SavingsRateReport {
  rows: SavingsRateMonthlyRow[];
  income_sources: SavingsRateIncomeSource[];
}

interface PeriodRow {
  period: string;
  sortKey: string;
  income: number;
  incomeExGains: number;
  marketIncome: number;
  investment: number;
  cash: number;
  poof: number;
  retained: number;
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

const periodKey = (month: string, period: Period) => {
  if (period === "month") return month;
  const year = month.slice(0, 4);
  if (period === "year") return year;
  return `${year} Q${Math.ceil(Number(month.slice(5, 7)) / 3)}`;
};

export function SavingsRatePage() {
  const [report, setReport] = useState<SavingsRateReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("year");

  useEffect(() => {
    fetch("/api/savings-rate")
      .then((r) => r.json())
      .then((data) => setReport(data as SavingsRateReport))
      .catch((e) => setError(String(e)));
  }, []);

  const rows = useMemo(() => {
    if (!report) return [];
    const byPeriod = new Map<string, PeriodRow>();
    for (const row of report.rows) {
      const key = periodKey(row.month, period);
      const point = byPeriod.get(key) ?? {
        period: key,
        sortKey: row.month,
        income: 0,
        incomeExGains: 0,
        marketIncome: 0,
        investment: 0,
        cash: 0,
        poof: 0,
        retained: 0,
      };
      if (row.month < point.sortKey) point.sortKey = row.month;
      point.income += row.income_cents / 100;
      point.incomeExGains += row.income_ex_market_gains_cents / 100;
      point.marketIncome += row.market_income_cents / 100;
      point.investment += row.investment_change_cents / 100;
      point.cash += row.cash_change_cents / 100;
      point.poof += row.poof_cents / 100;
      point.retained += row.net_retained_cents / 100;
      byPeriod.set(key, point);
    }
    return [...byPeriod.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }, [report, period]);

  const totals = useMemo(() => {
    const income = rows.reduce((sum, row) => sum + row.income, 0);
    const incomeExGains = rows.reduce((sum, row) => sum + row.incomeExGains, 0);
    const marketIncome = rows.reduce((sum, row) => sum + row.marketIncome, 0);
    const retained = rows.reduce((sum, row) => sum + row.retained, 0);
    const investment = rows.reduce((sum, row) => sum + row.investment, 0);
    const cash = rows.reduce((sum, row) => sum + row.cash, 0);
    const poof = income - retained;
    return {
      income,
      incomeExGains,
      marketIncome,
      retained,
      investment,
      cash,
      poof,
      rate: income > 0 ? retained / income : null,
      rateExGains: incomeExGains > 0 ? retained / incomeExGains : null,
    };
  }, [rows]);

  if (error) return <div className="page page-wide"><div className="meta import-error">{error}</div></div>;
  if (!report) return <div className="page page-wide"><div className="empty-state">Loading…</div></div>;

  return (
    <div className="page page-savings-rate">
      <div className="chart-section-header returns-header">
        <div>
          <div className="chart-title">Savings Rate</div>
          <div className="chart-subtitle">External income split into retained wealth and poof</div>
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
          <div className="total-meta">Ex gains {fmtPct(totals.rateExGains)}</div>
        </div>
        <div className="total-card">
          <div className="total-label">Gross income</div>
          <div className="total-value">{fmtUsd(totals.income)}</div>
        </div>
        <div className="total-card">
          <div className="total-label">Income ex gains</div>
          <div className="total-value">{fmtUsd(totals.incomeExGains)}</div>
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
            <Bar dataKey="retained" name="Net retained" fill="#7aa7ff" />
            <Bar dataKey="poof" name="Poof" fill="#777" />
          </BarChart>
        </ResponsiveContainer>
        <div className="returns-account-legend">
          <div className="returns-account-legend-item"><span style={{ background: "#7aa7ff" }} /> Net retained</div>
          <div className="returns-account-legend-item"><span style={{ background: "#6f6f6f" }} /> Poof</div>
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
                  <th className="num">Gross income</th>
                  <th className="num">Ex gains</th>
                  <th className="num">Market income</th>
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
                    <td className="num">{fmtUsd(row.incomeExGains)}</td>
                    <td className="num">{fmtUsd(row.marketIncome)}</td>
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
                {report.income_sources.slice(0, 12).map((source) => (
                  <tr key={source.label}>
                    <td>{source.label}</td>
                    <td>{source.is_market_income ? "Market" : "Income"}</td>
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
