#!/usr/bin/env bun

import { initDatabase } from '../server/database.ts';
import { loadLocalEnv } from '../server/app/localEnv.ts';
import { runSync } from '../server/app/dataSync/runner.ts';
import type { SyncEvent, SyncGoal, SyncRunRequest } from '../server/app/dataSync/types.ts';

function valueAfter(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseGoal(args: string[]): SyncGoal {
  const kind = valueAfter(args, '--goal') ?? 'current';
  if (kind === 'current') return { kind, overlapDays: Number(valueAfter(args, '--overlap-days') ?? 7) };
  if (kind === 'backfill') return { kind, stopAt: valueAfter(args, '--stop-at') };
  if (kind === 'range') {
    const startDate = valueAfter(args, '--from');
    const endDate = valueAfter(args, '--to');
    if (!startDate || !endDate) throw new Error('--goal range requires --from and --to');
    return { kind, startDate, endDate };
  }
  throw new Error(`Unknown sync goal: ${kind}`);
}

loadLocalEnv();
initDatabase();

const args = Bun.argv.slice(2);
const institution = valueAfter(args, '--institution');
if (institution !== 'bank-of-america' && institution !== 'vanguard') {
  throw new Error('Use --institution bank-of-america or vanguard');
}
const runId = valueAfter(args, '--run-id') ?? `sync-${Date.now()}`;
const request: SyncRunRequest = {
  runId,
  institutionId: institution,
  connectionId: valueAfter(args, '--connection'),
  goal: parseGoal(args),
};
const emit = (event: Omit<SyncEvent, 'runId' | 'timestamp'>) => {
  console.log(JSON.stringify({ ...event, runId, timestamp: new Date().toISOString() } satisfies SyncEvent));
};

try {
  await runSync(request, emit);
} catch (error) {
  emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
