import { localCalendarDate } from '../calendarDate.ts';
import type { SyncConnector } from './connector.ts';
import { loadSyncAccountCoverage } from './coverage.ts';
import { createSyncExecutionPlanFromAccounts } from './executionPlanCore.ts';
import { syncConnectors } from './registry.ts';
import {
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
  return createSyncExecutionPlanFromAccounts(request, {
    ...options,
    accounts: options.accounts ?? loadSyncAccountCoverage(),
  });
}
