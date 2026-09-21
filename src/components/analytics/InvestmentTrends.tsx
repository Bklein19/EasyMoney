import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import type { AnalyticsPeriodRow } from './PeriodClickOverlay';

interface InvestmentTrendRow {
  key: string;
  label: string;
  amount: number;
}

interface InvestmentTrendChartRow extends InvestmentTrendRow, AnalyticsPeriodRow {
  displayLabel: string;
  Investments: number;
}

interface InvestmentTrendsProps {
  rows?: InvestmentTrendRow[];
  onSelectPeriod?: (period: AnalyticsPeriodRow) => void;
}

interface TooltipPayloadEntry {
  color?: string;
  value: number;
  payload: InvestmentTrendChartRow;
}

interface TooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
}

function getActivePeriodPayload(state: unknown) {
  if (!state || typeof state !== 'object') return null;
  const activePayload = (state as { activePayload?: Array<{ payload?: AnalyticsPeriodRow }> }).activePayload;
  return activePayload?.[0]?.payload ?? null;
}

const formatCurrency = (val: number) => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
}).format(val);

const CustomTooltip = ({ active, payload }: TooltipProps) => {
  if (active && payload && payload.length) {
    return (
      <div className="custom-tooltip">
        <div className="label">{payload[0].payload.displayLabel}</div>
        <div className="value-row">
          <span style={{ color: payload[0].color }}>Investments:</span>
          <span className="amount amount--neutral">{formatCurrency(payload[0].value)}</span>
        </div>
      </div>
    );
  }
  return null;
};

export default function InvestmentTrends({ rows = [], onSelectPeriod }: InvestmentTrendsProps) {
  const data = rows.map(row => ({
    ...row,
    timeKey: row.key,
    displayLabel: row.label,
    Investments: row.amount,
  }));

  if (data.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon">$</div>
        <p className="empty-state__description">No investment transfers to display for this period.</p>
      </div>
    );
  }

  return (
    <div className="chart-container">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 10, right: 10, left: 12, bottom: 0 }}
          onClick={(state: unknown) => {
            const period = getActivePeriodPayload(state);
            if (period && onSelectPeriod) {
              onSelectPeriod(period);
            }
          }}
        >
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid)" />
          <XAxis
            dataKey="displayLabel"
            stroke="var(--chart-axis)"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            dy={10}
          />
          <YAxis
            tickFormatter={formatCurrency}
            stroke="var(--chart-axis)"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            width={72}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--chart-cursor)' }} />
          <Bar dataKey="Investments" fill="var(--data-investment)" radius={[4, 4, 0, 0]} maxBarSize={44} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
