import { join } from 'node:path';

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

function isoDate(value = new Date()): string {
  return value.toISOString().slice(0, 10);
}

export function listSyncTargets(): SyncTarget[] {
  const context = {
    today: isoDate(),
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
    accounts?: SyncExecutionPlan['accounts'];
    outputDir?: string;
  } = {},
): SyncExecutionPlan {
  return {
    protocolVersion: SYNC_WORKER_PROTOCOL_VERSION,
    runId: request.runId,
    institutionId: request.institutionId,
    today: options.today ?? isoDate(),
    accounts: options.accounts ?? loadSyncAccountCoverage(),
    ...(request.connectionId ? { connectionId: request.connectionId } : {}),
    goal: request.goal,
    outputDir: options.outputDir ?? join(syncApplicationDataRoot(), request.runId, 'artifacts'),
  };
}
