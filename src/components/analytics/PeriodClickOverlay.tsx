import { useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
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

export function getAnalyticsPeriodRange(
  data: AnalyticsPeriodRow[],
  firstIndex: number,
  lastIndex: number
): AnalyticsPeriodRow | null {
  const startIndex = Math.min(firstIndex, lastIndex);
  const endIndex = Math.max(firstIndex, lastIndex);
  const startPeriod = data[startIndex];
  const endPeriod = data[endIndex];
  if (!startPeriod || !endPeriod) return null;

  const startLabel = String(startPeriod.displayLabel ?? startPeriod.label ?? startPeriod.timeKey);
  const endLabel = String(endPeriod.displayLabel ?? endPeriod.label ?? endPeriod.timeKey);
  return {
    timeKey: `${startPeriod.timeKey}:${endPeriod.timeKey}`,
    label: `${startLabel} to ${endLabel}`,
    displayLabel: `${startLabel} to ${endLabel}`,
    startDate: startPeriod.startDate,
    endDate: endPeriod.endDate,
  };
}

export default function PeriodClickOverlay({ data, onSelectPeriod }: PeriodClickOverlayProps) {
  const plotArea = usePlotArea();
  const xScale = useXAxisScale();
  const dragStartRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const [dragRange, setDragRange] = useState<[number, number] | null>(null);

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

  const startDrag = (index: number, event: PointerEvent<SVGRectElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragStartRef.current = index;
    suppressClickRef.current = false;
    setDragRange([index, index]);
  };

  const extendDrag = (index: number, event: PointerEvent<SVGRectElement>) => {
    if (dragStartRef.current === null || event.buttons === 0) return;
    event.stopPropagation();
    setDragRange([dragStartRef.current, index]);
  };

  const finishDrag = (index: number, event: PointerEvent<SVGRectElement>) => {
    const startIndex = dragStartRef.current;
    if (startIndex === null) return;

    event.preventDefault();
    event.stopPropagation();
    dragStartRef.current = null;
    setDragRange(null);

    if (startIndex === index) return;
    suppressClickRef.current = true;
    const periodRange = getAnalyticsPeriodRange(
      positionedPeriods.map(({ period }) => period),
      startIndex,
      index
    );
    if (periodRange) onSelectPeriod(periodRange);
  };

  const cancelDrag = () => {
    dragStartRef.current = null;
    setDragRange(null);
  };

  return (
    <g className="period-click-overlay">
      {positionedPeriods.map(({ period }, index) => {
        const isInDragRange = dragRange !== null &&
          index >= Math.min(...dragRange) &&
          index <= Math.max(...dragRange);

        return (
          <rect
            key={period.timeKey}
            x={bands[index]!.start}
            y={plotArea.y}
            width={bands[index]!.width}
            height={plotArea.height}
            fill={isInDragRange ? 'rgba(59, 130, 246, 0.18)' : 'rgba(255,255,255,0.001)'}
            cursor="pointer"
            role="button"
            tabIndex={0}
            aria-label={`Filter to ${String(period.displayLabel)}`}
            onPointerDown={event => startDrag(index, event)}
            onPointerEnter={event => extendDrag(index, event)}
            onPointerUp={event => finishDrag(index, event)}
            onPointerCancel={cancelDrag}
            onClick={event => {
              if (suppressClickRef.current) {
                event.stopPropagation();
                suppressClickRef.current = false;
                return;
              }
              selectPeriod(period, event);
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') selectPeriod(period, event);
            }}
          />
        );
      })}
    </g>
  );
}
