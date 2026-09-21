/** Shared categorical fallback. Saved user category colors remain data, not UI tokens. */
export const CHART_SERIES_COLORS = Array.from({ length: 8 }, (_, index) => `var(--data-series-${index})`);
