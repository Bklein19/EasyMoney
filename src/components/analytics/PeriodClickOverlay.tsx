// @ts-nocheck
import { Customized } from 'recharts';

function OverlayRects({ data = [], onSelectPeriod, offset, width, height }) {
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

export default function PeriodClickOverlay({ data, onSelectPeriod }) {
  return (
    <Customized
      component={(props) => (
        <OverlayRects
          {...props}
          data={data}
          onSelectPeriod={onSelectPeriod}
        />
      )}
    />
  );
}
