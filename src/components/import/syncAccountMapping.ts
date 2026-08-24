import {
  commonSafeSyncAccountDestination,
} from '../../../server/app/dataSync/accountMapping.ts';
import type { SyncAccountClaim } from '../../../server/app/dataSync/types.ts';

export function syncAccountGroupAutoDestination(claims: SyncAccountClaim[]): number | null {
  return commonSafeSyncAccountDestination(claims);
}
