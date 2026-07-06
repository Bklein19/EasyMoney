import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ComposedChart,
  Area,
  Bar,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import "./ReportPages.css";
import { trpc } from "../../api/trpc";

interface AccountSummary {
  id: number;
  name: string;
  institution: string;
  type: string;
  classification: string;
}

interface MonthlyRow {
  month: string;
  account_id: number;
  contributions_cents: number;
  dividends_cents: number;
  interest_cents: number;
  gains_cents: number | null;
  end_balance_cents: number | null;
}

interface NetWorthReport {
  accounts: AccountSummary[];
  rows: MonthlyRow[];
  returns: ReturnSummary[];
}

type Period = "month" | "quarter" | "year";

interface ChartPoint {
  month: string;
  cumulativeContributions: number;
  cumulativeGains: number;
  cumulative: number;
  hasBalance: boolean;
}

interface DerivativePoint {
  period: string;
  sortKey: string;
  contributions: number;
  marketGains: number;
}

interface ReturnSummary {
  account_id: number;
  start_date: string;
  end_date: string;
  years: number;
  initial_balance_cents: number;
  ending_balance_cents: number;
  net_cash_flow_cents: number;
  irr: number | null;
  time_weighted_return: number | null;
  annualized_time_weighted_return: number | null;
}

type PeriodReturnChartPoint = {
  period: string;
  sortKey: string;
} & Record<string, string | number | null>;

interface InvestmentReturnPoint {
  time: number;
  month: string;
  investmentReturns: number;
  positiveReturns: number | null;
  negativeReturns: number | null;
}

const fmtUsd = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const fmtPct = (v: number | null) =>
  v === null
    ? "—"
    : v.toLocaleString("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });

const isCashLikeAccount = (account: AccountSummary) =>
  ["checking", "savings", "credit-card", "loan"].includes(account.type);

const fmtUsdAxis = (v: number) =>
  Math.abs(v) >= 999_500_000
    ? `$${(v / 1_000_000_000).toFixed(Math.abs(v) >= 10_000_000_000 ? 0 : 1).replace(/\.0$/, "")}B`
    : Math.abs(v) >= 999_500
    ? `$${(v / 1_000_000).toFixed(Math.abs(v) >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`
    : Math.abs(v) >= 1000
      ? `$${(v / 1000).toFixed(0)}k`
      : `$${v.toFixed(0)}`;

const monthToTime = (month: string) => Date.parse(`${month}-01T00:00:00Z`);

const formatMonthTick = (time: number) => {
  const date = new Date(time);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};

const accountColor = (index: number) => `var(--account-series-${index % 8})`;

const chartTheme = {
  axis: "var(--chart-axis)",
  grid: "var(--chart-grid)",
  zero: "var(--chart-zero)",
  tooltipContent: { background: "var(--tooltip-bg)", border: "1px solid var(--tooltip-border)", borderRadius: 8 },
  tooltipLabel: { color: "var(--text-muted)" },
};

const series = {
  contributions: "var(--series-contributions)",
  gains: "var(--series-gains)",
  netWorth: "var(--series-net-worth)",
  positive: "var(--series-positive)",
  negative: "var(--series-negative)",
};

interface NetWorthPageProps {
  view: "networth" | "performance";
  selectedIds?: Set<number>;
}

export function NetWorthPage({ view, selectedIds: selectedIdsProp }: NetWorthPageProps) {
  const reportQuery = useQuery(trpc.reports.netWorth.queryOptions());
  const report = (reportQuery.data || null) as NetWorthReport | null;
  const [derivativePeriod, setDerivativePeriod] = useState<Period>("month");

  const allAccountIds = useMemo(
    () => new Set(report?.accounts.map((account) => account.id) ?? []),
    [report],
  );
  const selectedIds = selectedIdsProp ?? allAccountIds;

  const data: ChartPoint[] = useMemo(() => {
    if (!report) return [];
    const months = [...new Set(report.rows.map((r) => r.month))].sort();

    // Monthly deltas (summed across selected accounts) + per-account balance
    // snapshots. Accounts report on different cadences (Sequoia is quarterly),
    // so each account's last-known balance must carry forward into months where
    // it has no new snapshot — otherwise the combined total saws up and down.
    const monthlyContribs = new Map<string, number>();
    const monthlyGains = new Map<string, number>();
    const balanceByMonthAccount = new Map<string, Map<number, number>>(); // month → (account → balance)
    const accountsEverSnapped = new Set<number>();

    for (const row of report.rows) {
      if (!selectedIds.has(row.account_id)) continue;
      monthlyContribs.set(row.month, (monthlyContribs.get(row.month) ?? 0) + row.contributions_cents / 100);
      monthlyGains.set(row.month, (monthlyGains.get(row.month) ?? 0) + (row.dividends_cents + row.interest_cents + (row.gains_cents ?? 0)) / 100);
      if (row.end_balance_cents !== null) {
        let m = balanceByMonthAccount.get(row.month);
        if (!m) { m = new Map(); balanceByMonthAccount.set(row.month, m); }
        m.set(row.account_id, row.end_balance_cents / 100);
        accountsEverSnapped.add(row.account_id);
      }
    }

    let cumulativeContribs = 0;
    let cumulativeGains = 0;
    let running = 0;
    let started = false;
    const lastBalance = new Map<number, number>(); // account → most recent balance
    const points: ChartPoint[] = [];
    const accountById = new Map(report.accounts.map((account) => [account.id, account]));
    const cashOnlySelection = [...selectedIds].every((id) => {
      const account = accountById.get(id);
      return account ? isCashLikeAccount(account) : false;
    });

    for (const month of months) {
      const contribDelta = monthlyContribs.get(month) ?? 0;
      const gainsDelta = monthlyGains.get(month) ?? 0;
      cumulativeContribs += contribDelta;
      cumulativeGains += gainsDelta;

      // Return of capital: outflows draw down contributions first; anything
      // beyond that comes out of gains. Keeps a fully-emptied account at 0/0.
      if (!cashOnlySelection && cumulativeContribs < 0) {
        cumulativeGains += cumulativeContribs;
        cumulativeContribs = 0;
      }

      // Update any account that has a fresh snapshot this month.
      const snaps = balanceByMonthAccount.get(month);
      if (snaps) for (const [acct, bal] of snaps) lastBalance.set(acct, bal);

      // Net worth = sum of every account's most recent available balance.
      let hasBalance = false;
      if (snaps && accountsEverSnapped.size > 0) {
        running = [...lastBalance.values()].reduce((a, b) => a + b, 0);
        hasBalance = true;
        if (cashOnlySelection) {
          // Cash accounts have statement snapshots mid-month; transactions later
          // in the same month are timing residuals, not market gains.
          cumulativeContribs = running - cumulativeGains;
        } else {
          // Reconcile: keep contributions as-is, let gains absorb any residual.
          cumulativeGains = running - cumulativeContribs;
        }
      } else {
        running += contribDelta + gainsDelta;
      }

      // Skip leading empty months, but keep zeros once there's history —
      // a closed-out account dropping to 0 is real data.
      if (!started && cumulativeContribs === 0 && cumulativeGains === 0 && running === 0) continue;
      started = true;
      points.push({
        month,
        cumulativeContributions: cumulativeContribs,
        cumulativeGains,
        cumulative: running,
        hasBalance,
      });
    }
    return points;
  }, [report, selectedIds]);

  const totals = useMemo(() => {
    const last = data[data.length - 1];
    return {
      contributions: last?.cumulativeContributions ?? 0,
      gains: last?.cumulativeGains ?? 0,
    };
  }, [data]);

  const derivativeData: DerivativePoint[] = useMemo(() => {
    if (!report) return [];

    const periodKey = (month: string): string => {
      if (derivativePeriod === "month") return month;
      const year = month.slice(0, 4);
      if (derivativePeriod === "year") return year;
      const monthIndex = Number(month.slice(5, 7));
      return `${year} Q${Math.ceil(monthIndex / 3)}`;
    };

    const byPeriod = new Map<string, DerivativePoint>();
    for (const row of report.rows) {
      if (!selectedIds.has(row.account_id)) continue;
      const period = periodKey(row.month);
      let point = byPeriod.get(period);
      if (!point) {
        point = { period, sortKey: row.month, contributions: 0, marketGains: 0 };
        byPeriod.set(period, point);
      }
      if (row.month < point.sortKey) point.sortKey = row.month;
      point.contributions += row.contributions_cents / 100;
      point.marketGains += (row.dividends_cents + row.interest_cents + (row.gains_cents ?? 0)) / 100;
    }

    return [...byPeriod.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }, [report, selectedIds, derivativePeriod]);

  const returnRows = useMemo(() => {
    if (!report) return [];
    const accountsById = new Map(report.accounts.map((account) => [account.id, account]));
    return report.returns
      .filter((row) => selectedIds.has(row.account_id))
      .map((row) => ({ ...row, account: accountsById.get(row.account_id)! }))
      .sort((a, b) => {
        const aName = `${a.account.institution} ${a.account.name}`;
        const bName = `${b.account.institution} ${b.account.name}`;
        return aName.localeCompare(bName);
      });
  }, [report, selectedIds]);

  const periodReturnData: PeriodReturnChartPoint[] = useMemo(() => {
    if (!report) return [];

    const periodKey = (month: string): string => {
      if (derivativePeriod === "month") return month;
      const year = month.slice(0, 4);
      if (derivativePeriod === "year") return year;
      const monthIndex = Number(month.slice(5, 7));
      return `${year} Q${Math.ceil(monthIndex / 3)}`;
    };

    const returnAccountIds = new Set(returnRows.map((row) => row.account_id));
    const rowsByAccount = new Map<number, MonthlyRow[]>();
    for (const row of report.rows) {
      if (!returnAccountIds.has(row.account_id)) continue;
      if (!selectedIds.has(row.account_id)) continue;
      const rows = rowsByAccount.get(row.account_id) ?? [];
      rows.push(row);
      rowsByAccount.set(row.account_id, rows);
    }

    const byPeriod = new Map<string, PeriodReturnChartPoint>();
    for (const [accountId, rows] of rowsByAccount) {
      rows.sort((a, b) => a.month.localeCompare(b.month));

      let estimatedStartBalance: number | null = null;
      const linkedByPeriod = new Map<string, { sortKey: string; linked: number; periods: number }>();

      for (const row of rows) {
        const period = periodKey(row.month);
        const periodState = linkedByPeriod.get(period) ?? { sortKey: row.month, linked: 1, periods: 0 };
        if (row.month < periodState.sortKey) periodState.sortKey = row.month;

        const externalFlow = row.contributions_cents / 100;
        const investmentReturn = (row.dividends_cents + row.interest_cents + (row.gains_cents ?? 0)) / 100;
        const capitalBase =
          estimatedStartBalance === null
            ? Math.max(0, externalFlow)
            : estimatedStartBalance + Math.max(0, externalFlow);

        if (capitalBase > 0) {
          const monthlyReturn = investmentReturn / capitalBase;
          if (Number.isFinite(monthlyReturn) && monthlyReturn > -1) {
            periodState.linked *= 1 + monthlyReturn;
            periodState.periods += 1;
          }
        }

        if (row.end_balance_cents !== null) {
          estimatedStartBalance = row.end_balance_cents / 100;
        } else if (estimatedStartBalance !== null) {
          estimatedStartBalance += externalFlow + investmentReturn;
        }

        linkedByPeriod.set(period, periodState);
      }

      const accountKey = `account_${accountId}`;
      for (const [period, state] of linkedByPeriod) {
        if (state.periods === 0) continue;
        const point = byPeriod.get(period) ?? { period, sortKey: state.sortKey };
        if (state.sortKey < String(point.sortKey)) point.sortKey = state.sortKey;
        point[accountKey] = state.linked - 1;
        byPeriod.set(period, point);
      }
    }

    return [...byPeriod.values()].sort((a, b) => String(a.sortKey).localeCompare(String(b.sortKey)));
  }, [report, returnRows, selectedIds, derivativePeriod]);

  const returnAccountBars = useMemo(
    () =>
      returnRows.map((row, index) => ({
        key: `account_${row.account_id}`,
        label: `${row.account.institution} · ${row.account.name}`,
        color: accountColor(index),
      })),
    [returnRows],
  );
  const returnAccountLegend = (
    <div className="returns-account-legend">
      {returnAccountBars.map((account) => (
        <div key={account.key} className="returns-account-legend-item">
          <span style={{ background: account.color }} />
          {account.label}
        </div>
      ))}
    </div>
  );

  const investmentReturnData: InvestmentReturnPoint[] = useMemo(() => {
    const points: InvestmentReturnPoint[] = [];
    const makePoint = (month: string, time: number, investmentReturns: number): InvestmentReturnPoint => ({
      time,
      month,
      investmentReturns,
      positiveReturns: investmentReturns >= 0 ? investmentReturns : null,
      negativeReturns: investmentReturns <= 0 ? investmentReturns : null,
    });

    for (const point of data) {
      const current = makePoint(point.month, monthToTime(point.month), point.cumulativeGains);
      const previous = points.at(-1);
      if (
        previous &&
        previous.investmentReturns !== 0 &&
        current.investmentReturns !== 0 &&
        Math.sign(previous.investmentReturns) !== Math.sign(current.investmentReturns)
      ) {
        const ratio =
          Math.abs(previous.investmentReturns) /
          (Math.abs(previous.investmentReturns) + Math.abs(current.investmentReturns));
        const crossingTime = previous.time + (current.time - previous.time) * ratio;
        points.push(makePoint(formatMonthTick(crossingTime), crossingTime, 0));
      }
      points.push(current);
    }

    return points;
  }, [data]);

  if (reportQuery.error) return <div className="page"><div className="meta import-error">{String(reportQuery.error)}</div></div>;
  if (!report) return <div className="page"><div className="meta">Loading…</div></div>;
  if (report.rows.length === 0) {
    return (
      <div className="page">
        <div className="empty-state">No data yet. Import some files first.</div>
      </div>
    );
  }

  const hasGains = report.rows.some((r) => r.gains_cents !== null);
  const latest = data[data.length - 1];
  const totalCards = (
    <div className="totals-row">
      <div className="total-card total-card-highlight">
        <div className="total-label">Net worth</div>
        <div className="total-value">{fmtUsd(latest?.cumulative ?? 0)}</div>
        <div className="total-asof">as of {latest?.month ?? "—"}</div>
      </div>
      <div className="total-card">
        <div className="total-label">Contributions</div>
        <div className="total-value">{fmtUsd(totals.contributions)}</div>
      </div>
      <div className="total-card">
        <div className="total-label">Market gains</div>
        <div className="total-value">{hasGains ? fmtUsd(totals.gains) : "—"}</div>
      </div>
    </div>
  );
  const periodPicker = (
    <div className="segmented-control" role="group" aria-label="Period">
      {(["month", "quarter", "year"] as const).map((period) => (
        <button
          key={period}
          type="button"
          className={derivativePeriod === period ? "active" : ""}
          onClick={() => setDerivativePeriod(period)}
        >
          {period}
        </button>
      ))}
    </div>
  );

  return (
    <div className={`page page-networth ${view === "networth" ? "page-networth-dashboard" : "page-performance-dashboard"}`}>
      <div className="page__header report-page__header">
        <div>
          <h1 className="page__title">{view === "networth" ? "Net Worth" : "Performance"}</h1>
          <p className="page__subtitle">
            {view === "networth"
              ? "Ledger balances, contributions, and investment gains over time."
              : "Investment returns calculated from imported balances and cash flows."}
          </p>
        </div>
      </div>

      {view === "networth" ? (
        <div className="networth-dashboard">
          <div className="networth-dashboard-main">
            <div className="networth-summary">
              {totalCards}
            </div>

            <div className="chart-container networth-primary-chart">
              <ResponsiveContainer width="100%" height={420}>
                <ComposedChart data={data} stackOffset="sign">
                  <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
                  <XAxis dataKey="month" stroke={chartTheme.axis} tick={{ fontSize: 11 }} />
                  <YAxis
                    stroke={chartTheme.axis}
                    tick={{ fontSize: 11 }}
                    tickFormatter={fmtUsdAxis}
                  />
                  <Tooltip
                    formatter={(value) => fmtUsd(Number(value))}
                    contentStyle={chartTheme.tooltipContent}
                    labelStyle={chartTheme.tooltipLabel}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="cumulativeContributions" name="Contributions" stackId="stack" fill={series.contributions} />
                  {hasGains && <Bar dataKey="cumulativeGains" name="Market gains" stackId="stack" fill={series.gains} />}
                  <Line
                    type="monotone"
                    dataKey="cumulative"
                    name="Net worth"
                    stroke={series.netWorth}
                    strokeWidth={1.5}
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div className="chart-section-header">
              <div>
                <div className="chart-title">Change by period</div>
                <div className="chart-subtitle">Contributions and market gains</div>
              </div>
              {periodPicker}
            </div>

            <div className="chart-container derivative-chart">
              <ResponsiveContainer width="100%" height={340}>
                <ComposedChart data={derivativeData} stackOffset="sign">
                  <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
                  <XAxis dataKey="period" stroke={chartTheme.axis} tick={{ fontSize: 11 }} />
                  <YAxis
                    stroke={chartTheme.axis}
                    tick={{ fontSize: 11 }}
                    tickFormatter={fmtUsdAxis}
                  />
                  <Tooltip
                    formatter={(value) => fmtUsd(Number(value))}
                    contentStyle={chartTheme.tooltipContent}
                    labelStyle={chartTheme.tooltipLabel}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="contributions" name="Contributions" fill={series.contributions} />
                  <Bar dataKey="marketGains" name="Market gains" fill={series.gains} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      ) : (
      <section className="returns-section performance-page">
        <div className="return-subsection-title">Investment Returns</div>
        <div className="chart-container returns-investment-chart">
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={investmentReturnData} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
              <XAxis
                dataKey="time"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                stroke={chartTheme.axis}
                tick={{ fontSize: 11 }}
                tickFormatter={(value) => formatMonthTick(Number(value))}
              />
              <YAxis
                stroke={chartTheme.axis}
                tick={{ fontSize: 11 }}
                tickFormatter={fmtUsdAxis}
              />
              <Tooltip
                formatter={(value) => fmtUsd(Number(value))}
                labelFormatter={(value) => formatMonthTick(Number(value))}
                contentStyle={chartTheme.tooltipContent}
                labelStyle={chartTheme.tooltipLabel}
              />
              <ReferenceLine y={0} stroke={chartTheme.zero} />
              <Area
                type="monotone"
                dataKey="positiveReturns"
                name="Investment returns"
                stroke={series.positive}
                fill={series.positive}
                fillOpacity={0.16}
                dot={false}
                connectNulls={false}
              />
              <Area
                type="monotone"
                dataKey="negativeReturns"
                name="Investment losses"
                stroke={series.negative}
                fill={series.negative}
                fillOpacity={0.16}
                dot={false}
                connectNulls={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="return-subsection-header">
          <div className="return-subsection-title">Period Returns</div>
          {periodPicker}
        </div>
        <div className="chart-container returns-chart">
          <ResponsiveContainer width="100%" height={340}>
            <ComposedChart data={periodReturnData} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
              <XAxis dataKey="period" stroke={chartTheme.axis} tick={{ fontSize: 11 }} />
              <YAxis stroke={chartTheme.axis} tick={{ fontSize: 11 }} tickFormatter={(value) => fmtPct(Number(value))} />
              <Tooltip
                formatter={(value, name) => [fmtPct(Number(value)), name]}
                contentStyle={chartTheme.tooltipContent}
                labelStyle={chartTheme.tooltipLabel}
              />
              <ReferenceLine y={0} stroke={chartTheme.zero} />
              {returnAccountBars.map((account) => (
                <Bar key={account.key} dataKey={account.key} name={account.label} fill={account.color} />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
          {returnAccountLegend}
        </div>
        <div className="return-subsection-title">Return Details</div>
        <div className="returns-table-wrap">
          <table className="returns-table">
            <colgroup>
              <col className="c-return-account" />
              <col className="c-return-period" />
              <col className="c-return-rate" />
              <col className="c-return-rate" />
              <col className="c-return-money" />
              <col className="c-return-money" />
            </colgroup>
            <thead>
              <tr>
                <th>Account</th>
                <th>Period</th>
                <th className="num">Annual IRR</th>
                <th className="num">Annual TWR</th>
                <th className="num">Net flow</th>
                <th className="num">Ending</th>
              </tr>
            </thead>
            <tbody>
              {returnRows.map((row) => (
                <tr key={row.account_id}>
                  <td>
                    <div className="return-account">{row.account.institution}</div>
                    <div className="return-account-name">{row.account.name}</div>
                    <div className="return-meta">{row.account.type}</div>
                  </td>
                  <td>
                    <div>{row.start_date} to {row.end_date}</div>
                    <div className="return-meta">{row.years.toFixed(1)} years</div>
                  </td>
                  <td className="num return-rate">{fmtPct(row.irr)}</td>
                  <td className="num return-rate">{fmtPct(row.annualized_time_weighted_return)}</td>
                  <td className="num">{fmtUsd(row.net_cash_flow_cents / 100)}</td>
                  <td className="num">{fmtUsd(row.ending_balance_cents / 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      )}

    </div>
  );
}
