import React, { useEffect, useMemo, useState } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";

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
}

interface ChartPoint {
  month: string;
  cumulativeContributions: number;
  cumulativeGains: number;
  cumulative: number;
  hasBalance: boolean;
}

const fmtUsd = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const fmtUsdAxis = (v: number) =>
  Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v.toFixed(0)}`;

export function NetWorthPage() {
  const [report, setReport] = useState<NetWorthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number> | null>(null); // null = all

  useEffect(() => {
    fetch("/api/networth")
      .then((r) => r.json())
      .then((data) => setReport(data as NetWorthReport))
      .catch((e) => setError(String(e)));
  }, []);

  const selectedIds = useMemo(() => {
    if (!report) return new Set<number>();
    return selected ?? new Set(report.accounts.map((a) => a.id));
  }, [report, selected]);

  const data: ChartPoint[] = useMemo(() => {
    if (!report) return [];
    const months = [...new Set(report.rows.map((r) => r.month))].sort();

    // Monthly deltas per (month, account)
    const monthlyContribs = new Map<string, number>();
    const monthlyGains = new Map<string, number>();
    const balanceByMonth = new Map<string, number>();

    for (const row of report.rows) {
      if (!selectedIds.has(row.account_id)) continue;
      monthlyContribs.set(row.month, (monthlyContribs.get(row.month) ?? 0) + row.contributions_cents / 100);
      monthlyGains.set(row.month, (monthlyGains.get(row.month) ?? 0) + (row.dividends_cents + row.interest_cents + (row.gains_cents ?? 0)) / 100);
      if (row.end_balance_cents !== null) {
        balanceByMonth.set(row.month, (balanceByMonth.get(row.month) ?? 0) + row.end_balance_cents / 100);
      }
    }

    let cumulativeContribs = 0;
    let cumulativeGains = 0;
    let running = 0;
    const points: ChartPoint[] = [];

    for (const month of months) {
      const contribDelta = monthlyContribs.get(month) ?? 0;
      const gainsDelta = monthlyGains.get(month) ?? 0;
      cumulativeContribs += contribDelta;
      cumulativeGains += gainsDelta;

      const snapped = balanceByMonth.get(month);
      let hasBalance = false;
      if (snapped !== undefined) {
        running = snapped;
        hasBalance = true;
        // Reconcile: keep contributions as-is, let gains absorb any rounding
        cumulativeGains = running - cumulativeContribs;
      } else {
        running += contribDelta + gainsDelta;
      }

      if (cumulativeContribs !== 0 || cumulativeGains !== 0 || running !== 0) {
        points.push({
          month,
          cumulativeContributions: cumulativeContribs,
          cumulativeGains: Math.max(0, cumulativeGains),
          cumulative: running,
          hasBalance,
        });
      }
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

  const toggleAccount = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  if (error) return <div className="page"><div className="meta" style={{ color: "#e05252" }}>{error}</div></div>;
  if (!report) return <div className="page"><div className="meta">Loading…</div></div>;
  if (report.rows.length === 0) {
    return (
      <div className="page">
        <div className="empty-state">No data yet. Import some files first.</div>
      </div>
    );
  }

  const hasGains = report.rows.some((r) => r.gains_cents !== null);

  return (
    <div className="page page-wide">
      <div className="account-filter">
        {report.accounts.map((a) => (
          <label key={a.id} className={`account-chip${selectedIds.has(a.id) ? " active" : ""}`}>
            <input
              type="checkbox"
              checked={selectedIds.has(a.id)}
              onChange={() => toggleAccount(a.id)}
            />
            {a.institution} · {a.name}
            <span className="account-type">{a.type}</span>
          </label>
        ))}
      </div>

      <div className="totals-row">
        <div className="total-card total-card-highlight">
          <div className="total-label">Net worth</div>
          <div className="total-value">{fmtUsd(data[data.length - 1]?.cumulative ?? 0)}</div>
          <div className="total-asof">as of {data[data.length - 1]?.month ?? "—"}</div>
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

      <div className="chart-container">
        <ResponsiveContainer width="100%" height={420}>
          <ComposedChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis dataKey="month" stroke="#555" tick={{ fontSize: 11 }} />
            <YAxis stroke="#555" tick={{ fontSize: 11 }} tickFormatter={fmtUsdAxis} />
            <Tooltip
              formatter={(value) => fmtUsd(Number(value))}
              contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8 }}
              labelStyle={{ color: "#888" }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="cumulativeContributions" name="Contributions" stackId="stack" fill="#4a8fff" />
            {hasGains && <Bar dataKey="cumulativeGains" name="Market gains" stackId="stack" fill="#ffb74a" />}
            <Line
              type="monotone"
              dataKey="cumulative"
              name="Net worth"
              stroke="#e8e8e8"
              strokeWidth={1.5}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

    </div>
  );
}
