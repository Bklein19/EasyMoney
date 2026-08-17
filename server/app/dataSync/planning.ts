import type { SyncGoal } from './types.ts';

interface CoverageWindow {
  latestFactDate: string | null;
  earliestFactDate: string | null;
}

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function shiftDays(date: string, days: number) {
  const dateOnly = date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) throw new Error(`Invalid source fact date: ${date}`);
  const value = new Date(`${dateOnly}T00:00:00Z`);
  if (Number.isNaN(value.getTime()) || value.toISOString().slice(0, 10) !== dateOnly) {
    throw new Error(`Invalid source fact date: ${date}`);
  }
  value.setUTCDate(value.getUTCDate() + days);
  return isoDate(value);
}

export function goalWindowForCoverage(goal: SyncGoal, account: CoverageWindow, today: string) {
  if (goal.kind === 'range') return { startDate: goal.startDate, endDate: goal.endDate };
  if (goal.kind === 'backfill') {
    return {
      startDate: goal.stopAt ?? '2000-01-01',
      endDate: account.earliestFactDate ? shiftDays(account.earliestFactDate, 7) : today,
    };
  }
  return {
    startDate: account.latestFactDate ? shiftDays(account.latestFactDate, -goal.overlapDays) : shiftDays(today, -365),
    endDate: today,
  };
}

function monthEnd(year: number, monthIndex: number) {
  return isoDate(new Date(Date.UTC(year, monthIndex + 1, 0)));
}

export function missingMonthlyStatementDates(startDate: string, endDate: string, existingDates: Iterable<string>) {
  const existing = new Set([...existingDates].map(date => date.slice(0, 10)));
  const start = new Date(`${startDate.slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${endDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error('Invalid Vanguard statement window');
  const dates: string[] = [];
  for (
    let year = start.getUTCFullYear(), month = start.getUTCMonth();
    year < end.getUTCFullYear() || (year === end.getUTCFullYear() && month <= end.getUTCMonth());
    month += 1
  ) {
    if (month === 12) { year += 1; month = 0; }
    const date = monthEnd(year, month);
    if (date >= startDate && date <= endDate && !existing.has(date)) dates.push(date);
  }
  return dates;
}

export function vanguardProfileIdFromFileNames(fileNames: string[]) {
  const safeProfile = (value: string | undefined) => {
    const normalized = value?.toLowerCase();
    return normalized && /^(?:current|account-\d+|login-\d+)$/.test(normalized) ? normalized : null;
  };
  for (const fileName of fileNames) {
    const statement = fileName.match(/---([a-z0-9-]+)\.pdf$/i);
    if (statement && safeProfile(statement[1])) return safeProfile(statement[1]);
    const explicit = fileName.match(/^vanguard-([a-z0-9-]+)-(?:brokerage|roth-ira|traditional-ira)-\d{4}-\d{2}-\d{2}-to-/i);
    if (explicit && safeProfile(explicit[1])) return safeProfile(explicit[1]);
    const roth = fileName.match(/^vanguard-roth-ira-([a-z0-9-]+)-\d{4}-\d{2}-\d{2}-to-/i);
    if (roth && safeProfile(roth[1])) return safeProfile(roth[1]);
    if (/^vanguard-brokerage-\d{4}-/i.test(fileName)) return 'current';
  }
  return null;
}
