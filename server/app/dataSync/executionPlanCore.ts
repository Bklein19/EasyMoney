import { join } from 'node:path';

import { localCalendarDate } from '../calendarDate.ts';
import { syncApplicationDataRoot } from './paths.ts';
import {
  SYNC_WORKER_PROTOCOL_VERSION,
  type SyncExecutionPlan,
  type SyncRunRequest,
} from './types.ts';

export function createSyncExecutionPlanFromAccounts(
  request: SyncRunRequest,
  options: {
    accounts: SyncExecutionPlan['accounts'];
    today?: string;
    now?: Date;
    outputDir?: string;
  },
): SyncExecutionPlan {
  return {
    protocolVersion: SYNC_WORKER_PROTOCOL_VERSION,
    runId: request.runId,
    institutionId: request.institutionId,
    today: options.today ?? localCalendarDate(options.now),
    accounts: options.accounts,
    ...(request.connectionId ? { connectionId: request.connectionId } : {}),
    goal: request.goal,
    outputDir: options.outputDir ?? join(syncApplicationDataRoot(), request.runId, 'artifacts'),
  };
}
