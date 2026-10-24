import React from 'react';

export interface CalendarTick {
  value: string;
  label: string;
  year?: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Calendar-aligned ticks, with room reserved for the Y axis and plot margins. */
export function calendarTicks(periods: string[], width: number): CalendarTick[] {
  const points = [...new Set(periods)].sort().map((value) => {
    const year = value.slice(0, 4);
    const quarter = / Q([1-4])$/.exec(value);
    const month = quarter ? (Number(quarter[1]) - 1) * 3 : Number(value.slice(5, 7) || 1) - 1;
    return { value, year, month, ordinal: Number(year) * 12 + month, quarter: quarter?.[1] };
  });
  if (!points.length) return [];
  const slots = Math.max(2, Math.floor((width - 100) / 90));
  const span = points.at(-1)!.ordinal - points[0]!.ordinal;
  const yearly = points.every((point) => point.value.length === 4);
  const yearsOnly = yearly || span >= 36 || points.length > slots * 6;
  const step = yearsOnly ? 12 : ([1, 2, 3, 6, 12].find((step) => span / step + 1 <= slots) ?? 12);
  let candidates = points.filter((point, index) => {
    if (yearsOnly) return index === 0 || point.year !== points[index - 1]!.year;
    return point.month % step === 0;
  });
  // Label the first partial year only if it isn't crowding the next January.
  if (
    candidates[0]?.value !== points[0]!.value &&
    (!candidates[0] || candidates[0].ordinal - points[0]!.ordinal >= step)
  ) {
    candidates.unshift(points[0]!);
  }
  if (yearsOnly && candidates.length > 1 && candidates[1]!.ordinal - candidates[0]!.ordinal < 6) {
    candidates = candidates.slice(1);
  }
  const yearStride = Math.max(1, Math.ceil(candidates.length / slots));
  if (yearsOnly) candidates = candidates.filter((_, index) => index % yearStride === 0);
  if (!candidates.length) candidates = [points[0]!];

  return candidates.map((point, index) => {
    const yearBoundary = yearsOnly || point.month === 0 || index === 0;
    return {
      value: point.value,
      label: yearsOnly ? point.year : point.quarter ? `Q${point.quarter}` : MONTHS[point.month]!,
      ...(yearBoundary && !yearsOnly ? { year: point.year } : {}),
    };
  });
}

export function CalendarAxisTick({
  x,
  y,
  payload,
  ticks,
}: {
  x?: number | string;
  y?: number | string;
  payload?: { value: string | number };
  ticks: CalendarTick[];
}) {
  const tick = ticks.find((tick) => tick.value === String(payload?.value));
  if (!tick) return null;
  const isYear = Boolean(tick.year) || /^\d{4}$/.test(tick.label);
  return (
    <g transform={`translate(${Number(x)},${Number(y)})`}>
      <text
        textAnchor="middle"
        y={13}
        fill={`var(--${isYear ? 'text-secondary' : 'text-muted'})`}
        fontSize={11}
        fontWeight={isYear ? 650 : 400}
      >
        {tick.year ?? tick.label}
      </text>
      {tick.year && (
        <text textAnchor="middle" y={28} fill="var(--text-muted)" fontSize={10}>
          {tick.label}
        </text>
      )}
    </g>
  );
}
