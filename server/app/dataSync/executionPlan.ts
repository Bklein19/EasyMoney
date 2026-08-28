import { join } from 'node:path';

import { localCalendarDate } from '../calendarDate.ts';
import type { SyncConnector } from './connector.ts';
import { loadSyncAccountCoverage } from './coverage.ts';
import { syncApplicationDataRoot } from './paths.ts';
import { syncConnectors } from './registry.ts';
import {
  SYNC_WORKER_PROTOCOL_VERSION,
  type SyncExecutionPlan,
  type SyncInstitutionId,
  type SyncRunRequest,
  type SyncTarget,
} from './types.ts';

export function listSyncTargets(): SyncTarget[] {
  const context = {
    today: localCalendarDate(),
    accounts: loadSyncAccountCoverage(),
  };
  const connectors: readonly SyncConnector<SyncInstitutionId>[] = syncConnectors;
  return connectors.flatMap(connector => connector.listTargets(context).map(target => ({
    id: target.connectionId ? `${connector.id}:${target.connectionId}` : connector.id,
    institutionId: connector.id,
    ...(target.connectionId ? { connectionId: target.connectionId } : {}),
    label: target.label,
  })));
}

export function createSyncExecutionPlan(
  request: SyncRunRequest,
  options: {
    today?: string;
    now?: Date;
    accounts?: SyncExecutionPlan['accounts'];
    outputDir?: string;
  } = {},
): SyncExecutionPlan {
  return {
    protocolVersion: SYNC_WORKER_PROTOCOL_VERSION,
    runId: request.runId,
    institutionId: request.institutionId,
    today: options.today ?? localCalendarDate(options.now),
    accounts: options.accounts ?? loadSyncAccountCoverage(),
    ...(request.connectionId ? { connectionId: request.connectionId } : {}),
    goal: request.goal,
    outputDir: options.outputDir ?? join(syncApplicationDataRoot(), request.runId, 'artifacts'),
  };
}
