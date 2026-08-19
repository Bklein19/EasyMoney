import type { VanguardSyncProfile } from './institutions/vanguard.ts';
import type { SyncTarget } from './types.ts';

export function syncTargetsForProfiles(
  hasBankOfAmericaAccounts: boolean,
  profiles: VanguardSyncProfile[],
): SyncTarget[] {
  const targets: SyncTarget[] = [];
  if (hasBankOfAmericaAccounts) {
    targets.push({ id: 'bank-of-america', institutionId: 'bank-of-america', label: 'BofA' });
  }
  for (const profile of profiles) {
    targets.push({
      id: `vanguard:${profile.id}`,
      institutionId: 'vanguard',
      connectionId: profile.id,
      label: `Vanguard (${profile.accountHolder})`,
    });
  }
  return targets;
}

export function selectVanguardProfiles(
  profiles: VanguardSyncProfile[],
  connectionId?: string,
): VanguardSyncProfile[] {
  return connectionId ? profiles.filter(profile => profile.id === connectionId) : profiles;
}
