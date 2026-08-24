import type { SyncConnector } from './connector.ts';
import { bankOfAmericaConnector } from './institutions/bankOfAmericaConnector.ts';
import { sequoiaFundConnector } from './institutions/sequoiaFundConnector.ts';
import { vanguardConnector } from './institutions/vanguardConnector.ts';

export const syncConnectors = [
  bankOfAmericaConnector,
  vanguardConnector,
  sequoiaFundConnector,
] as const satisfies readonly SyncConnector[];

export type SyncInstitutionId = (typeof syncConnectors)[number]['id'];

export const syncInstitutionIds: SyncInstitutionId[] = syncConnectors.map(connector => connector.id);

export function isSyncInstitutionId(value: unknown): value is SyncInstitutionId {
  return typeof value === 'string' && syncInstitutionIds.some(id => id === value);
}

export function getSyncConnector(id: SyncInstitutionId): SyncConnector<SyncInstitutionId> {
  const connector = syncConnectors.find(candidate => candidate.id === id);
  if (!connector) throw new Error(`Unsupported institution connector: ${id}`);
  return connector as SyncConnector<SyncInstitutionId>;
}
