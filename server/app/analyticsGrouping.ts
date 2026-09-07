export function resolveAutoGrouping(diffDays: number) {
  return diffDays > 400
    ? { labelFormat: 'yyyy', keyFormat: 'yyyy' }
    : diffDays > 60
      ? { labelFormat: 'MMM yyyy', keyFormat: 'yyyy-MM' }
      : diffDays > 31
        ? { labelFormat: 'week', keyFormat: 'week' }
        : { labelFormat: 'MMM d', keyFormat: 'yyyy-MM-dd' };
}
