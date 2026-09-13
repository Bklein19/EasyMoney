/** Preserve a source calendar day without a local-timezone conversion. */
export function calendarDate(value: string | undefined, allowShortYear = false): string | null {
  const text = value?.trim() ?? '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/.exec(text);
  if (!iso && !slash) return null;
  if (slash?.[3]?.length === 2 && !allowShortYear) return null;
  const year = iso ? Number(iso[1]) : Number(slash![3]) + (slash![3]!.length === 2 ? 2000 : 0);
  const month = Number(iso ? iso[2] : slash![1]);
  const day = Number(iso ? iso[3] : slash![2]);
  if (year < 1000 || year > 9999) return null;
  const result = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${result}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === result ? result : null;
}
