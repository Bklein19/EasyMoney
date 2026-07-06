import { Customized } from 'recharts';

export interface AnalyticsPeriodRow {
  timeKey: string;
  [key: string]: unknown;
}

interface ChartOffset {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

interface OverlayRectsProps {
  data?: AnalyticsPeriodRow[];
  onSelectPeriod?: (period: AnalyticsPeriodRow) => void;
  offset?: ChartOffset;
  width?: number;
  height?: number;
}

interface PeriodClickOverlayProps {
  data: AnalyticsPeriodRow[];
  onSelectPeriod?: (period: AnalyticsPeriodRow) => void;
}

function OverlayRects({ data = [], onSelectPeriod, offset, width, height }: OverlayRectsProps) {
  if (!data.length || !onSelectPeriod) return null;

  const left = offset?.left ?? 0;
  const top = offset?.top ?? 0;
  const chartWidth = offset?.width ?? width ?? 0;
  const chartHeight = offset?.height ?? height ?? 0;
  const bandWidth = chartWidth / data.length;

  if (!chartWidth || !chartHeight || !bandWidth) return null;

  return (
    <g>
      {data.map((period, index) => (
        <rect
          key={period.timeKey}
          x={left + index * bandWidth}
          y={top}
          width={bandWidth}
          height={chartHeight}
          fill="rgba(255,255,255,0.001)"
          cursor="pointer"
          onClick={() => onSelectPeriod(period)}
        />
      ))}
    </g>
  );
}

export default function PeriodClickOverlay({ data, onSelectPeriod }: PeriodClickOverlayProps) {
  return (
    <Customized
      component={(props: OverlayRectsProps) => (
        <OverlayRects
          {...props}
          data={data}
          onSelectPeriod={onSelectPeriod}
        />
      )}
    />
  );
}
