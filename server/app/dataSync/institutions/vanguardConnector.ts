import type {
  RoutedSyncArtifact,
  SyncAccountCoverage,
  SyncConnector,
  SyncConnectorContext,
  SyncConnectorRunContext,
  SyncConnectorTarget,
} from '../connector.ts';
import { goalWindowForCoverage } from '../planning.ts';
import type { SyncGoal, SyncReporter } from '../protocol.ts';
import {
  runVanguardSync,
  type VanguardAccountKind,
  type VanguardDownloadedArtifact,
  type VanguardProgressEvent,
  type VanguardSyncProfile,
} from './vanguard.ts';

const DEFAULT_TARGET_GOAL: SyncGoal = { kind: 'current', overlapDays: 7 };
type VanguardSyncRunner = typeof runVanguardSync;

function identityTexts(account: SyncAccountCoverage): string[] {
  return [
    account.sourceAccountName,
    ...account.sourceAccountNames,
    ...account.accountAliases,
    account.name,
  ].filter((value): value is string => Boolean(value?.trim()));
}

function exactIsoDate(value: string): Date {
  const dateOnly = value.slice(0, 10);
  const parsed = new Date(`${dateOnly}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid Vanguard statement date: ${value}`);
  }
  return parsed;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function isSafeProfileId(value: string | undefined): value is string {
  return Boolean(value && /^(?:current|account-\d+|login-\d+)$/.test(value));
}

function profileIdFromFileName(fileName: string): string | null {
  const normalized = fileName.toLowerCase();
  const statement = normalized.match(/---([a-z0-9-]+)\.pdf$/);
  if (isSafeProfileId(statement?.[1])) return statement[1];

  const activity = normalized.match(
    /^vanguard-([a-z0-9-]+)-(?:brokerage|roth-ira|traditional-ira)-\d{4}-\d{2}-\d{2}-to-/,
  );
  if (isSafeProfileId(activity?.[1])) return activity[1];

  const legacyRoth = normalized.match(
    /^vanguard-roth-ira-([a-z0-9-]+)-\d{4}-\d{2}-\d{2}-to-/,
  );
  if (isSafeProfileId(legacyRoth?.[1])) return legacyRoth[1];

  return /^vanguard-brokerage-\d{4}-/.test(normalized) ? 'current' : null;
}

export function matchesVanguardAccount(account: SyncAccountCoverage): boolean {
  return /\bvanguard\b/i.test(account.institution?.trim() ?? '');
}

export function inferVanguardAccountKind(
  account: SyncAccountCoverage,
): VanguardAccountKind | null {
  const text = identityTexts(account).join(' ').toLowerCase();
  if (/roth\s*(?:-|\s)*ira/.test(text)) return 'roth-ira';
  if (/\bira\b/.test(text)) return 'traditional-ira';
  if (/brokerage|individual|joint|trust|custodial|vanguard/.test(text)) return 'brokerage';
  return null;
}

export function inferVanguardAccountLast4(account: SyncAccountCoverage): string | null {
  if (/^\d{4}$/.test(account.last4 ?? '')) return account.last4!;
  const preferred = new Set<string>();
  const fallback = new Set<string>();
  for (const text of identityTexts(account)) {
    const explicit = text.match(
      /(?:ending\s+in|account(?:\s+number)?|[x*\u2022]{2,}|-{2,})\D{0,12}(\d{4})(?!\d)/i,
    );
    if (explicit?.[1]) preferred.add(explicit[1]);
    const trailing = text.match(/(\d{4})(?!.*\d)/)?.[1];
    if (trailing) fallback.add(trailing);
  }
  const candidates = preferred.size > 0 ? preferred : fallback;
  return candidates.size === 1 ? [...candidates][0]! : null;
}

export function vanguardProfileIdFromArtifactFileNames(fileNames: readonly string[]): string | null {
  for (const fileName of fileNames) {
    const profileId = profileIdFromFileName(fileName);
    if (profileId) return profileId;
  }
  return null;
}

export function missingVanguardMonthlyStatementDates(
  startDate: string,
  endDate: string,
  existingDates: Iterable<string>,
): string[] {
  const start = exactIsoDate(startDate);
  const end = exactIsoDate(endDate);
  if (start > end) return [];
  const existing = new Set([...existingDates].map(date => isoDate(exactIsoDate(date))));
  const missing: string[] = [];

  for (
    let year = start.getUTCFullYear(), month = start.getUTCMonth();
    year < end.getUTCFullYear() || (year === end.getUTCFullYear() && month <= end.getUTCMonth());
    month += 1
  ) {
    if (month === 12) {
      year += 1;
      month = 0;
    }
    const statementDate = isoDate(new Date(Date.UTC(year, month + 1, 0)));
    if (statementDate >= startDate && statementDate <= endDate && !existing.has(statementDate)) {
      missing.push(statementDate);
    }
  }
  return missing;
}

export function planVanguardProfiles(
  context: SyncConnectorContext,
  goal: SyncGoal,
  report: SyncReporter = () => {},
): VanguardSyncProfile[] {
  const candidates = context.accounts.filter(matchesVanguardAccount).map(account => ({
    account,
    profileId: vanguardProfileIdFromArtifactFileNames(account.artifactFileNames),
    accountKind: inferVanguardAccountKind(account),
    accountLast4: inferVanguardAccountLast4(account),
    accountHolder: account.accountHolder?.trim() || null,
    holderKey: account.accountHolder?.replace(/\s+/g, ' ').trim().toLowerCase() || null,
  }));
  const holdersByProfile = new Map<string, Map<string, string>>();
  for (const candidate of candidates) {
    if (!candidate.profileId || !candidate.holderKey || !candidate.accountHolder) continue;
    const holders = holdersByProfile.get(candidate.profileId) ?? new Map<string, string>();
    holders.set(candidate.holderKey, candidate.accountHolder);
    holdersByProfile.set(candidate.profileId, holders);
  }

  const invalidProfiles = new Set<string>();
  const holderByProfile = new Map<string, { key: string; display: string }>();
  for (const [profileId, holders] of holdersByProfile) {
    if (holders.size > 1) {
      invalidProfiles.add(profileId);
      report({
        type: 'warning',
        message: `Skipped Vanguard profile ${profileId}; its accounts have conflicting account holders`,
      });
      continue;
    }
    const [key, display] = holders.entries().next().value!;
    holderByProfile.set(profileId, { key, display });
  }

  const profilesByHolder = new Map<string, Set<string>>();
  for (const [profileId, holder] of holderByProfile) {
    const profileIds = profilesByHolder.get(holder.key) ?? new Set<string>();
    profileIds.add(profileId);
    profilesByHolder.set(holder.key, profileIds);
  }

  const profiles = new Map<string, VanguardSyncProfile>();
  for (const candidate of candidates) {
    const { account, accountKind, accountLast4 } = candidate;
    let profileId = candidate.profileId;
    if (profileId && invalidProfiles.has(profileId)) continue;
    if (!profileId && candidate.holderKey) {
      const matchingProfiles = profilesByHolder.get(candidate.holderKey);
      if (matchingProfiles?.size === 1) profileId = matchingProfiles.values().next().value!;
    }
    const accountHolder = profileId
      ? holderByProfile.get(profileId)?.display ?? candidate.accountHolder
      : candidate.accountHolder;
    if (!profileId || !accountKind || !accountLast4 || !accountHolder) {
      report({
        type: 'warning',
        message: `Skipped ${account.name}; its Vanguard login profile, account number, or account holder is missing`,
        data: { accountId: account.id },
      });
      continue;
    }

    const existingProfile = profiles.get(profileId);
    if (existingProfile?.accounts.some(accountPlan => accountPlan.accountLast4 === accountLast4)) {
      profiles.delete(profileId);
      invalidProfiles.add(profileId);
      report({
        type: 'warning',
        message: `Skipped Vanguard profile ${profileId}; its account numbers are ambiguous`,
      });
      continue;
    }

    const activityWindow = goalWindowForCoverage(goal, account, context.today);
    const statementWindow = goalWindowForCoverage(goal, {
      latestFactDate: account.latestBalanceDate,
      earliestFactDate: account.earliestBalanceDate,
    }, context.today);
    const profile = existingProfile ?? {
      id: profileId,
      session: profileId === 'current' ? 'vanguard-catchup' : `vanguard-${profileId}-catchup`,
      accountHolder,
      accounts: [],
    };
    profile.accounts.push({
      accountId: account.id,
      accountKind,
      accountLast4,
      startDate: activityWindow.startDate,
      statementDates: missingVanguardMonthlyStatementDates(
        statementWindow.startDate,
        statementWindow.endDate,
        account.balanceDates,
      ),
    });
    profiles.set(profileId, profile);
  }

  return [...profiles.values()];
}

export function selectVanguardProfiles(
  profiles: readonly VanguardSyncProfile[],
  connectionId?: string,
): VanguardSyncProfile[] {
  return connectionId
    ? profiles.filter(profile => profile.id === connectionId)
    : [...profiles];
}

export function vanguardTargetsForProfiles(
  profiles: readonly VanguardSyncProfile[],
): SyncConnectorTarget[] {
  return profiles.map(profile => ({
    connectionId: profile.id,
    label: `Vanguard (${profile.accountHolder})`,
  }));
}

export function routeVanguardArtifacts(
  artifacts: readonly Pick<VanguardDownloadedArtifact, 'fileName' | 'accountId'>[],
): RoutedSyncArtifact[] {
  return artifacts.map(({ fileName, accountId }) => ({ fileName, accountId }));
}

export function reportVanguardProgress(
  context: Pick<SyncConnectorRunContext, 'report'>,
  event: VanguardProgressEvent,
): void {
  context.report({
    type: event.state === 'waiting' ? 'action' : event.state === 'error' ? 'warning' : 'phase',
    message: event.message,
    data: {
      phase: event.phase,
      state: event.state,
      ...(event.profileId ? { profileId: event.profileId } : {}),
      ...(event.elapsedMs === undefined ? {} : { elapsedMs: event.elapsedMs }),
      ...(event.data ?? {}),
    },
  });
}

export function createVanguardConnector(
  runSync: VanguardSyncRunner = runVanguardSync,
) {
  return {
    id: 'vanguard',
    label: 'Vanguard',
    matchesAccount: matchesVanguardAccount,
    listTargets(context) {
      return vanguardTargetsForProfiles(planVanguardProfiles(context, DEFAULT_TARGET_GOAL));
    },
    async run(context) {
      const plannedProfiles = planVanguardProfiles(context, context.goal, context.report);
      const profiles = selectVanguardProfiles(plannedProfiles, context.connectionId);
      if (context.connectionId && profiles.length === 0) {
        throw new Error(`Vanguard connection is unavailable: ${context.connectionId}`);
      }
      if (profiles.length === 0) {
        throw new Error('No active Vanguard accounts are associated with a known login profile');
      }
      context.report({
        type: 'phase',
        message: `Opening ${profiles.length} Vanguard login${profiles.length === 1 ? '' : 's'}`,
        data: { goal: context.goal.kind, profiles: profiles.map(profile => profile.id) },
      });
      const downloaded = await runSync(
        { outputDir: context.outputDir, through: context.today, profiles },
        event => reportVanguardProgress(context, event),
      );
      context.report({
        type: 'phase',
        message: `Validated ${downloaded.length} new artifact${downloaded.length === 1 ? '' : 's'}`,
      });
      return routeVanguardArtifacts(downloaded);
    },
  } satisfies SyncConnector<'vanguard'>;
}

export const vanguardConnector = createVanguardConnector();
