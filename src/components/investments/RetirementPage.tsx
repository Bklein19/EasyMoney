import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Info } from "lucide-react";
import "./ReportPages.css";

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

interface SavingsRateAccountMonth {
  account_id: number;
  month: string;
  income_cents: number;
  market_income_cents: number;
}

interface SavingsRateReport {
  account_months: SavingsRateAccountMonth[];
}

interface RetirementPoint {
  age: number;
  year: number;
  p5: number;
  p50: number;
  p95: number;
  cumulativeContributions: number;
  medianGains: number;
}

interface TrialResult {
  balances: number[];
  cumulativeContributions: number[];
  investmentGains: number[];
  success: boolean;
}

const CURRENT_YEAR = new Date().getFullYear();
const TRIAL_COUNT = 500;
const END_AGE = 95;

const fmtUsd = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const fmtPct = (v: number) =>
  v.toLocaleString("en-US", { style: "percent", minimumFractionDigits: 0, maximumFractionDigits: 0 });

const fmtUsdAxis = (v: number) =>
  Math.abs(v) >= 999_500_000
    ? `$${(v / 1_000_000_000).toFixed(Math.abs(v) >= 10_000_000_000 ? 0 : 1).replace(/\.0$/, "")}B`
    : Math.abs(v) >= 999_500
      ? `$${(v / 1_000_000).toFixed(Math.abs(v) >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`
      : Math.abs(v) >= 1000
        ? `$${(v / 1000).toFixed(0)}k`
        : `$${v.toFixed(0)}`;

const chartTheme = {
  axis: "var(--chart-axis)",
  grid: "var(--chart-grid)",
  zero: "var(--chart-zero)",
  tooltipContent: { background: "var(--tooltip-bg)", border: "1px solid var(--tooltip-border)", borderRadius: 8 },
  tooltipLabel: { color: "var(--text-muted)" },
};

const xorshift32 = (seed: number) => {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 4294967296);
  };
};

const normalSample = (random: () => number) => {
  const u1 = Math.max(random(), Number.EPSILON);
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower] ?? 0;
  const weight = index - lower;
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
};

const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const parseInput = (value: string, fallback: number) => {
  if (value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function inferCurrentBalance(report: NetWorthReport | null, selectedIds: Set<number>) {
  if (!report) return 0;
  const rows = [...report.rows]
    .filter((row) => selectedIds.has(row.account_id) && row.end_balance_cents !== null)
    .sort((a, b) => a.month.localeCompare(b.month));
  const latestByAccount = new Map<number, number>();
  for (const row of rows) latestByAccount.set(row.account_id, (row.end_balance_cents ?? 0) / 100);
  return [...latestByAccount.values()].reduce((sum, balance) => sum + balance, 0);
}

function inferAnnualContribution(report: NetWorthReport | null, selectedIds: Set<number>) {
  if (!report) return 0;
  const months = [...new Set(report.rows.map((row) => row.month))].sort();
  const recentMonths = new Set(months.slice(-12));
  return report.rows.reduce((sum, row) => {
    if (!selectedIds.has(row.account_id) || !recentMonths.has(row.month)) return sum;
    return sum + Math.max(0, row.contributions_cents / 100);
  }, 0);
}

function inferAnnualIncome(report: SavingsRateReport | null, selectedIds: Set<number>) {
  if (!report) return 0;
  const months = [...new Set(report.account_months.map((row) => row.month))].sort();
  const recentMonths = new Set(months.slice(-12));
  return report.account_months.reduce((sum, row) => {
    if (!selectedIds.has(row.account_id) || !recentMonths.has(row.month)) return sum;
    return sum + Math.max(0, (row.income_cents - row.market_income_cents) / 100);
  }, 0);
}

function estimateSocialSecurity(annualIncome: number) {
  if (annualIncome <= 0) return 0;
  return Math.round(Math.min(60000, Math.max(12000, annualIncome * 0.35)) / 1000) * 1000;
}

function runProjection({
  currentBalance,
  currentAge,
  retirementAge,
  annualContribution,
  annualSpend,
  annualSocialSecurity,
  socialSecurityAge,
  expectedReturn,
  volatility,
  inflation,
  contributionIncrease,
}: {
  currentBalance: number;
  currentAge: number;
  retirementAge: number;
  annualContribution: number;
  annualSpend: number;
  annualSocialSecurity: number;
  socialSecurityAge: number;
  expectedReturn: number;
  volatility: number;
  inflation: number;
  contributionIncrease: number;
}) {
  const horizonYears = Math.max(1, END_AGE - currentAge);
  const trialResults: TrialResult[] = [];

  for (let trial = 0; trial < TRIAL_COUNT; trial += 1) {
    const random = xorshift32(0x9e3779b9 + trial * 1013904223);
    let balance = Math.max(0, currentBalance);
    let contribution = Math.max(0, annualContribution);
    let spend = Math.max(0, annualSpend);
    let socialSecurity = Math.max(0, annualSocialSecurity);
    let cumulativeContributions = 0;
    let investmentGains = 0;
    let success = true;
    const balances: number[] = [];
    const cumulativeContributionHistory: number[] = [];
    const investmentGainHistory: number[] = [];

    for (let yearOffset = 0; yearOffset <= horizonYears; yearOffset += 1) {
      const age = currentAge + yearOffset;
      balances.push(Math.max(0, balance));
      cumulativeContributionHistory.push(cumulativeContributions);
      investmentGainHistory.push(investmentGains);
      if (yearOffset === horizonYears) break;

      const sampledReturn = expectedReturn + volatility * normalSample(random);
      const gain = balance * sampledReturn;
      investmentGains += gain;
      balance = Math.max(0, balance + gain);

      if (age < retirementAge) {
        balance += contribution;
        cumulativeContributions += contribution;
        contribution *= 1 + contributionIncrease;
      } else {
        const benefit = age >= socialSecurityAge ? socialSecurity : 0;
        balance -= Math.max(0, spend - benefit);
        if (balance <= 0) {
          balance = 0;
          success = false;
        }
        spend *= 1 + inflation;
        socialSecurity *= 1 + inflation;
      }
    }

    trialResults.push({
      balances,
      cumulativeContributions: cumulativeContributionHistory,
      investmentGains: investmentGainHistory,
      success,
    });
  }

  const points: RetirementPoint[] = [];
  for (let index = 0; index <= horizonYears; index += 1) {
    const balances = trialResults.map((trial) => trial.balances[index] ?? 0);
    const gains = trialResults.map((trial) => trial.investmentGains[index] ?? 0);
    points.push({
      age: currentAge + index,
      year: CURRENT_YEAR + index,
      p5: percentile(balances, 0.05),
      p50: percentile(balances, 0.5),
      p95: percentile(balances, 0.95),
      cumulativeContributions: trialResults[0]?.cumulativeContributions[index] ?? 0,
      medianGains: percentile(gains, 0.5),
    });
  }

  return {
    points,
    successRate: trialResults.filter((trial) => trial.success).length / trialResults.length,
  };
}

export function RetirementPage({ selectedIds: selectedIdsProp }: { selectedIds?: Set<number> }) {
  const [netWorthReport, setNetWorthReport] = useState<NetWorthReport | null>(null);
  const [savingsReport, setSavingsReport] = useState<SavingsRateReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentAge, setCurrentAge] = useState("35");
  const [retirementAge, setRetirementAge] = useState("65");
  const [expectedReturnPct, setExpectedReturnPct] = useState("6");
  const [volatilityPct, setVolatilityPct] = useState("12");
  const [inflationPct, setInflationPct] = useState("2.5");
  const [contributionIncreasePct, setContributionIncreasePct] = useState("2");
  const [annualContribution, setAnnualContribution] = useState("18000");
  const [annualSpend, setAnnualSpend] = useState("90000");
  const [socialSecurityAge, setSocialSecurityAge] = useState("67");
  const [annualSocialSecurity, setAnnualSocialSecurity] = useState("0");
  const [zoomRange, setZoomRange] = useState<{ left: number; right: number } | null>(null);
  const [dragStartAge, setDragStartAge] = useState<number | null>(null);
  const [dragEndAge, setDragEndAge] = useState<number | null>(null);
  const seededInputs = useRef(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/networth").then((r) => {
        if (!r.ok) throw new Error(`Net worth request failed: ${r.status}`);
        return r.json();
      }),
      fetch("/api/savings-rate").then((r) => {
        if (!r.ok) throw new Error(`Savings rate request failed: ${r.status}`);
        return r.json();
      }),
    ])
      .then(([netWorth, savings]) => {
        setNetWorthReport(netWorth as NetWorthReport);
        setSavingsReport(savings as SavingsRateReport);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const allAccountIds = useMemo(
    () => new Set(netWorthReport?.accounts.map((account) => account.id) ?? []),
    [netWorthReport],
  );
  const selectedIds = selectedIdsProp && selectedIdsProp.size > 0 ? selectedIdsProp : allAccountIds;
  const currentBalance = useMemo(() => inferCurrentBalance(netWorthReport, selectedIds), [netWorthReport, selectedIds]);
  const inferredContribution = useMemo(
    () => inferAnnualContribution(netWorthReport, selectedIds),
    [netWorthReport, selectedIds],
  );
  const inferredIncome = useMemo(() => inferAnnualIncome(savingsReport, selectedIds), [savingsReport, selectedIds]);
  const inferredSocialSecurity = useMemo(() => estimateSocialSecurity(inferredIncome), [inferredIncome]);

  useEffect(() => {
    if (seededInputs.current || !netWorthReport || !savingsReport) return;
    if (inferredContribution > 0) setAnnualContribution(String(Math.round(inferredContribution / 100) * 100));
    if (inferredIncome > 0) setAnnualSpend(String(Math.round(Math.max(40000, inferredIncome * 0.75) / 1000) * 1000));
    if (inferredSocialSecurity > 0) setAnnualSocialSecurity(String(inferredSocialSecurity));
    seededInputs.current = true;
  }, [inferredContribution, inferredIncome, inferredSocialSecurity, netWorthReport, savingsReport]);

  const sanitizedCurrentAge = clampNumber(Math.round(parseInput(currentAge, 35)), 18, 94);
  const sanitizedRetirementAge = clampNumber(Math.round(parseInput(retirementAge, 65)), sanitizedCurrentAge + 1, END_AGE);
  const annualContributionValue = Math.max(0, parseInput(annualContribution, 0));
  const annualSpendValue = Math.max(0, parseInput(annualSpend, 0));
  const annualSocialSecurityValue = Math.max(0, parseInput(annualSocialSecurity, 0));
  const expectedReturnPctValue = parseInput(expectedReturnPct, 0);
  const volatilityPctValue = Math.max(0, parseInput(volatilityPct, 0));
  const inflationPctValue = Math.max(0, parseInput(inflationPct, 0));
  const contributionIncreasePctValue = Math.max(0, parseInput(contributionIncreasePct, 0));
  const socialSecurityAgeValue = clampNumber(Math.round(parseInput(socialSecurityAge, 67)), sanitizedCurrentAge, END_AGE);

  const projection = useMemo(
    () =>
      runProjection({
        currentBalance,
        currentAge: sanitizedCurrentAge,
        retirementAge: sanitizedRetirementAge,
        annualContribution: annualContributionValue,
        annualSpend: annualSpendValue,
        annualSocialSecurity: annualSocialSecurityValue,
        socialSecurityAge: socialSecurityAgeValue,
        expectedReturn: expectedReturnPctValue / 100,
        volatility: volatilityPctValue / 100,
        inflation: inflationPctValue / 100,
        contributionIncrease: contributionIncreasePctValue / 100,
      }),
    [
      annualContributionValue,
      annualSocialSecurityValue,
      annualSpendValue,
      contributionIncreasePctValue,
      currentBalance,
      expectedReturnPctValue,
      inflationPctValue,
      sanitizedCurrentAge,
      sanitizedRetirementAge,
      socialSecurityAgeValue,
      volatilityPctValue,
    ],
  );

  const retirementPoint = projection.points.find((point) => point.age === sanitizedRetirementAge) ?? projection.points.at(-1);
  const finalPoint = projection.points.at(-1);
  const displayedPoints = useMemo(
    () =>
      zoomRange
        ? projection.points.filter((point) => point.age >= zoomRange.left && point.age <= zoomRange.right)
        : projection.points,
    [projection.points, zoomRange],
  );
  const dragLeft = dragStartAge !== null && dragEndAge !== null ? Math.min(dragStartAge, dragEndAge) : null;
  const dragRight = dragStartAge !== null && dragEndAge !== null ? Math.max(dragStartAge, dragEndAge) : null;

  const beginChartDrag = (activeLabel: unknown) => {
    const age = Number(activeLabel);
    if (!Number.isFinite(age)) return;
    setDragStartAge(age);
    setDragEndAge(age);
  };

  const updateChartDrag = (activeLabel: unknown) => {
    if (dragStartAge === null) return;
    const age = Number(activeLabel);
    if (!Number.isFinite(age)) return;
    setDragEndAge(age);
  };

  const finishChartDrag = () => {
    if (dragStartAge !== null && dragEndAge !== null && Math.abs(dragEndAge - dragStartAge) >= 1) {
      setZoomRange({
        left: Math.min(dragStartAge, dragEndAge),
        right: Math.max(dragStartAge, dragEndAge),
      });
    }
    setDragStartAge(null);
    setDragEndAge(null);
  };

  if (error) return <div className="page page-retirement"><div className="meta import-error">{error}</div></div>;
  if (!netWorthReport) return <div className="page page-retirement"><div className="empty-state">Loading...</div></div>;

  return (
    <div className="page page-retirement">
      <div className="page__header report-page__header">
        <div>
          <h1 className="page__title">Retirement</h1>
          <p className="page__subtitle">Monte Carlo style portfolio projection using selected report accounts.</p>
        </div>
      </div>

      <div className="totals-row retirement-summary-row">
        <div className="total-card total-card-highlight">
          <div className="total-label">Success probability</div>
          <div className="total-value">{fmtPct(projection.successRate)}</div>
          <div className="total-asof">balance above zero through age {END_AGE}</div>
        </div>
        <div className="total-card">
          <div className="total-label">Current portfolio</div>
          <div className="total-value">{fmtUsd(currentBalance)}</div>
          <div className="total-asof">{selectedIds.size} selected accounts</div>
        </div>
        <div className="total-card">
          <div className="total-label">Median at retirement</div>
          <div className="total-value">{fmtUsd(retirementPoint?.p50 ?? 0)}</div>
          <div className="total-asof">age {sanitizedRetirementAge}</div>
        </div>
        <div className="total-card">
          <div className="total-label">Median at age {END_AGE}</div>
          <div className="total-value">{fmtUsd(finalPoint?.p50 ?? 0)}</div>
          <div className="total-asof">5th pct {fmtUsd(finalPoint?.p5 ?? 0)}</div>
        </div>
      </div>

      <div className="retirement-grid">
        <section className="retirement-panel" aria-label="Retirement assumptions">
          <div className="retirement-panel__header">
            <div className="return-subsection-title">Assumptions</div>
            <div className="retirement-info">
              <button type="button" className="retirement-info__button" aria-label="Assumption notes">
                <Info size={16} />
              </button>
              <div className="retirement-info__bubble" role="tooltip">
                <p>Annual contribution starts from positive contribution cash flows in the last 12 imported months for the selected accounts. Projection contributions stop at retirement age.</p>
                <p>Volatility is annual return standard deviation. With a 6% expected return and 12% volatility, most simulated years land roughly between -6% and 18%, with wider tails.</p>
              </div>
            </div>
          </div>
          <div className="retirement-form-grid">
            <label className="form-group">
              <span className="form-label">Current age</span>
              <input className="input" type="number" min={18} max={94} value={currentAge} onChange={(event) => setCurrentAge(event.target.value)} />
            </label>
            <label className="form-group">
              <span className="form-label">Retirement age</span>
              <input className="input" type="number" min={sanitizedCurrentAge + 1} max={END_AGE} value={retirementAge} onChange={(event) => setRetirementAge(event.target.value)} />
            </label>
            <label className="form-group">
              <span className="form-label">Annual contribution</span>
              <input className="input" type="number" min={0} step={1000} value={annualContribution} onChange={(event) => setAnnualContribution(event.target.value)} />
            </label>
            <label className="form-group">
              <span className="form-label">Retirement spending</span>
              <input className="input" type="number" min={0} step={1000} value={annualSpend} onChange={(event) => setAnnualSpend(event.target.value)} />
            </label>
            <label className="form-group">
              <span className="form-label">Expected return %</span>
              <input className="input" type="number" min={-10} max={20} step={0.1} value={expectedReturnPct} onChange={(event) => setExpectedReturnPct(event.target.value)} />
            </label>
            <label className="form-group">
              <span className="form-label">Volatility %</span>
              <input className="input" type="number" min={0} max={40} step={0.1} value={volatilityPct} onChange={(event) => setVolatilityPct(event.target.value)} />
            </label>
            <label className="form-group">
              <span className="form-label">Inflation %</span>
              <input className="input" type="number" min={0} max={12} step={0.1} value={inflationPct} onChange={(event) => setInflationPct(event.target.value)} />
            </label>
            <label className="form-group">
              <span className="form-label">Contribution raise %</span>
              <input className="input" type="number" min={0} max={20} step={0.1} value={contributionIncreasePct} onChange={(event) => setContributionIncreasePct(event.target.value)} />
            </label>
            <label className="form-group">
              <span className="form-label">Social Security age</span>
              <input className="input" type="number" min={sanitizedCurrentAge} max={END_AGE} value={socialSecurityAge} onChange={(event) => setSocialSecurityAge(event.target.value)} />
            </label>
            <label className="form-group">
              <span className="form-label">Annual Social Security</span>
              <input className="input" type="number" min={0} step={1000} value={annualSocialSecurity} onChange={(event) => setAnnualSocialSecurity(event.target.value)} />
            </label>
          </div>
          <div className="retirement-inference">
            <div>
              <span>Trailing income</span>
              <strong>{fmtUsd(inferredIncome)}</strong>
            </div>
            <div>
              <span>Trailing contributions</span>
              <strong>{fmtUsd(inferredContribution)}</strong>
            </div>
            <div>
              <span>Estimated Social Security</span>
              <strong>{fmtUsd(inferredSocialSecurity)}</strong>
            </div>
          </div>
        </section>

        <section className="chart-container retirement-chart" aria-label="Retirement projection chart">
          <div className="chart-section-header">
            <div>
              <div className="chart-title">Portfolio range</div>
              <div className="chart-subtitle">
                {TRIAL_COUNT} deterministic trials, shown as 5th, 50th, and 95th percentiles
                {zoomRange ? `, ages ${zoomRange.left}-${zoomRange.right}` : ""}
              </div>
            </div>
            {zoomRange && (
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setZoomRange(null)}>
                Reset zoom
              </button>
            )}
          </div>
          <ResponsiveContainer width="100%" height={430}>
            <ComposedChart
              data={displayedPoints}
              margin={{ top: 8, right: 24, bottom: 8, left: 8 }}
              onMouseDown={(event) => beginChartDrag(event?.activeLabel)}
              onMouseMove={(event) => updateChartDrag(event?.activeLabel)}
              onMouseUp={finishChartDrag}
              onMouseLeave={finishChartDrag}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} />
              <XAxis dataKey="age" type="number" domain={["dataMin", "dataMax"]} stroke={chartTheme.axis} tick={{ fontSize: 11 }} />
              <YAxis stroke={chartTheme.axis} tick={{ fontSize: 11 }} tickFormatter={fmtUsdAxis} />
              <Tooltip
                formatter={(value) => fmtUsd(Number(value))}
                labelFormatter={(age) => `Age ${age}`}
                contentStyle={chartTheme.tooltipContent}
                labelStyle={chartTheme.tooltipLabel}
              />
              <ReferenceLine x={sanitizedRetirementAge} stroke={chartTheme.zero} label={{ value: "Retire", fill: "var(--text-muted)", fontSize: 11 }} />
              <Area type="monotone" dataKey="p95" name="95th percentile" stroke="var(--series-retirement-high)" fill="var(--series-retirement-band)" fillOpacity={0.16} dot={false} />
              <Line type="monotone" dataKey="p50" name="Median" stroke="var(--series-retirement-median)" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="p5" name="5th percentile" stroke="var(--series-retirement-low)" strokeWidth={2} dot={false} />
              {dragLeft !== null && dragRight !== null && dragLeft !== dragRight && (
                <ReferenceArea x1={dragLeft} x2={dragRight} strokeOpacity={0.3} fill="var(--series-retirement-band)" fillOpacity={0.12} />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </section>
      </div>

      <div className="returns-table-wrap">
        <table className="returns-table retirement-table">
          <thead>
            <tr>
              <th rowSpan={2}>Age</th>
              <th className="num" rowSpan={2}>Contributions</th>
              <th className="num" rowSpan={2}>Median gains</th>
              <th className="num retirement-table__group" colSpan={3}>Projected net worth</th>
            </tr>
            <tr>
              <th className="num">5th percentile</th>
              <th className="num">Median</th>
              <th className="num">95th percentile</th>
            </tr>
          </thead>
          <tbody>
            {projection.points
              .filter((point) => point.age === sanitizedCurrentAge || point.age === sanitizedRetirementAge || point.age % 5 === 0 || point.age === END_AGE)
              .map((point) => (
                <tr key={point.age}>
                  <td>
                    <div className="return-account">Age {point.age}</div>
                    <div className="return-meta">{point.year}</div>
                  </td>
                  <td className="num">{fmtUsd(point.cumulativeContributions)}</td>
                  <td className="num">{fmtUsd(point.medianGains)}</td>
                  <td className="num">{fmtUsd(point.p5)}</td>
                  <td className="num return-rate">{fmtUsd(point.p50)}</td>
                  <td className="num">{fmtUsd(point.p95)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
