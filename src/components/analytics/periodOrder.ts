export function sortAnalyticsPeriodsChronologically<T extends { key: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => left.key.localeCompare(right.key));
}
