import type { KeyboardEvent, MouseEvent } from 'react';
import { usePlotArea, useXAxisScale } from 'recharts';

export interface AnalyticsPeriodRow {
  timeKey: string;
  [key: string]: unknown;
}

interface PeriodClickOverlayProps {
  data: AnalyticsPeriodRow[];
  onSelectPeriod?: (period: AnalyticsPeriodRow) => void;
}

interface PeriodClickBand {
  start: number;
  width: number;
}

export function getPeriodClickBands(centers: number[], plotStart: number, plotWidth: number): PeriodClickBand[] {
  if (centers.length === 0 || plotWidth <= 0) return [];

  const plotEnd = plotStart + plotWidth;
  return centers.map((center, index) => {
    const start = index === 0 ? plotStart : (centers[index - 1]! + center) / 2;
    const end = index === centers.length - 1 ? plotEnd : (center + centers[index + 1]!) / 2;
    return { start, width: Math.max(0, end - start) };
  });
}

export default function PeriodClickOverlay({ data, onSelectPeriod }: PeriodClickOverlayProps) {
  const plotArea = usePlotArea();
  const xScale = useXAxisScale();

  if (!data.length || !onSelectPeriod || !plotArea || !xScale) return null;

  const positionedPeriods = data.flatMap(period => {
    const center = xScale(period.displayLabel, { position: 'middle' });
    return typeof center === 'number' ? [{ center, period }] : [];
  });
  const bands = getPeriodClickBands(
    positionedPeriods.map(({ center }) => center),
    plotArea.x,
    plotArea.width
  );

  const selectPeriod = (
    period: AnalyticsPeriodRow,
    event: MouseEvent<SVGRectElement> | KeyboardEvent<SVGRectElement>
  ) => {
    event.stopPropagation();
    onSelectPeriod(period);
  };

  return (
    <g className="period-click-overlay">
      {positionedPeriods.map(({ period }, index) => (
        <rect
          key={period.timeKey}
          x={bands[index]!.start}
          y={plotArea.y}
          width={bands[index]!.width}
          height={plotArea.height}
          fill="rgba(255,255,255,0.001)"
          cursor="pointer"
          role="button"
          tabIndex={0}
          aria-label={`Filter to ${String(period.displayLabel)}`}
          onClick={event => selectPeriod(period, event)}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') selectPeriod(period, event);
          }}
        />
      ))}
    </g>
  );
}
