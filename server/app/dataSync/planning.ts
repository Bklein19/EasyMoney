import type { SyncGoal } from './protocol.ts';

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
