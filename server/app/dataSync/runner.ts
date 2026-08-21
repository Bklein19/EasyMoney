import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getDb } from '../../database.ts';
import {
  runBankOfAmericaSync,
  type BankOfAmericaSyncConfig,
} from './institutions/bankOfAmerica.ts';
import {
  runVanguardSync,
  type VanguardAccountKind,
  type VanguardSyncProfile,
} from './institutions/vanguard.ts';
import type { SyncGoal, SyncReporter, SyncRunRequest, SyncTarget } from './types.ts';
import {
  goalWindowForCoverage,
  missingMonthlyStatementDates,
  vanguardProfileIdFromFileNames,
} from './planning.ts';
import { syncApplicationDataRoot } from './paths.ts';
import { stageSyncArtifact } from './review.ts';
import { selectVanguardProfiles, syncTargetsForProfiles } from './targets.ts';
import type { SyncArtifactReview, SyncRunReview } from './types.ts';

export { syncApplicationDataRoot } from './paths.ts';

interface AccountCoverageRow {
  id: number;
  name: string;
  type: string;
  latestFactDate: string | null;
  earliestFactDate: string | null;
  latestBalanceDate?: string | null;
  earliestBalanceDate?: string | null;
  balanceDates?: string | null;
  sourceAccountName?: string | null;
  accountHolder?: string | null;
}

function isoDate(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

function institutionCoverage(institutionPattern: string): AccountCoverageRow[] {
  return getDb().prepare(`
    WITH facts AS (
      SELECT sa.accountId, st.date, 'transaction' AS factType
      FROM sourceTransactions st
      JOIN sourceAccounts sa ON sa.id = st.sourceAccountId
      JOIN sourceFiles sf ON sf.id = st.sourceFileId AND sf.status = 'committed'
      UNION ALL
      SELECT sa.accountId, sb.date, 'balance' AS factType
      FROM sourceBalances sb
      JOIN sourceAccounts sa ON sa.id = sb.sourceAccountId
      JOIN sourceFiles sf ON sf.id = sb.sourceFileId AND sf.status = 'committed'
    )
    SELECT
      a.id,
      a.name,
      a.type,
      a.accountHolder,
      MIN(f.date) AS earliestFactDate,
      MAX(f.date) AS latestFactDate,
      MIN(CASE WHEN f.factType = 'balance' THEN f.date END) AS earliestBalanceDate,
      MAX(CASE WHEN f.factType = 'balance' THEN f.date END) AS latestBalanceDate,
      GROUP_CONCAT(DISTINCT CASE WHEN f.factType = 'balance' THEN SUBSTR(f.date, 1, 10) END) AS balanceDates,
      (
        SELECT sa2.sourceAccountName
        FROM sourceAccounts sa2
        JOIN sourceFiles sf2 ON sf2.id = sa2.sourceFileId
        WHERE sa2.accountId = a.id
        ORDER BY COALESCE(sf2.committedAt, sf2.createdAt) DESC, sf2.id DESC
        LIMIT 1
      ) AS sourceAccountName
    FROM accounts a
    LEFT JOIN facts f ON f.accountId = a.id
    WHERE LOWER(COALESCE(a.institution, '')) LIKE ?
      AND COALESCE(a.status, 'active') = 'active'
    GROUP BY a.id
    ORDER BY a.id
  `).all(institutionPattern) as AccountCoverageRow[];
}

function bankOfAmericaCoverage() {
  return institutionCoverage('%bank of america%');
}

function accountByKind(accounts: AccountCoverageRow[], kind: 'checking' | 'savings' | 'credit') {
  const matches = accounts.filter(account => {
    const type = account.type.toLowerCase();
    const name = account.name.toLowerCase();
    if (kind === 'checking') return type === 'checking' || name.includes('checking');
    if (kind === 'savings') return type === 'savings' || name.includes('savings');
    return type.includes('credit') || name.includes('credit') || name.includes('card');
  });
  if (matches.length !== 1) throw new Error(`Expected exactly one active Bank of America ${kind} account, found ${matches.length}.`);
  return matches[0]!;
}

function vanguardKind(account: AccountCoverageRow): VanguardAccountKind | null {
  const value = `${account.sourceAccountName ?? ''} ${account.name}`.toLowerCase();
  if (/traditional|trad\s+ira/.test(value)) return 'traditional-ira';
  if (/roth/.test(value) && /ira/.test(value)) return 'roth-ira';
  if (/brokerage|vanguard/.test(value)) return 'brokerage';
  return null;
}

function vanguardLast4(account: AccountCoverageRow) {
  return `${account.sourceAccountName ?? ''} ${account.name}`.match(/(\d{4})(?!.*\d)/)?.[1] ?? null;
}

function vanguardArtifactNames(accountId: number) {
  return (getDb().prepare(`
    SELECT sf.fileName
    FROM sourceAccounts sa
    JOIN sourceFiles sf ON sf.id = sa.sourceFileId
    WHERE sa.accountId = ?
    ORDER BY COALESCE(sf.committedAt, sf.createdAt) DESC, sf.id DESC
  `).all(accountId) as Array<{ fileName: string }>).map(row => row.fileName);
}

export function planVanguardProfiles(goal: SyncGoal, today: string, report: SyncReporter): VanguardSyncProfile[] {
  const profiles = new Map<string, VanguardSyncProfile>();
  const invalidProfiles = new Set<string>();
  for (const account of institutionCoverage('%vanguard%')) {
    const profileId = vanguardProfileIdFromFileNames(vanguardArtifactNames(account.id));
    const accountKind = vanguardKind(account);
    const accountLast4 = vanguardLast4(account);
    const accountHolder = account.accountHolder?.trim() || null;
    if (!profileId || !accountKind || !accountLast4 || !accountHolder) {
      report({
        type: 'warning',
        message: `Skipped ${account.name}; its Vanguard login profile, account number, or account holder is missing`,
        data: { accountId: account.id },
      });
      continue;
    }
    if (invalidProfiles.has(profileId)) continue;
    const activityWindow = goalWindowForCoverage(goal, account, today);
    const balanceCoverage = {
      latestFactDate: account.latestBalanceDate ?? null,
      earliestFactDate: account.earliestBalanceDate ?? null,
    };
    const statementWindow = goalWindowForCoverage(goal, balanceCoverage, today);
    const statementDates = missingMonthlyStatementDates(
      statementWindow.startDate,
      statementWindow.endDate,
      (account.balanceDates ?? '').split(',').filter(Boolean),
    );
    const existingProfile = profiles.get(profileId);
    if (existingProfile && existingProfile.accountHolder !== accountHolder) {
      profiles.delete(profileId);
      invalidProfiles.add(profileId);
      report({
        type: 'warning',
        message: `Skipped Vanguard profile ${profileId}; its accounts have conflicting account holders`,
      });
      continue;
    }
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
      statementDates,
    });
    profiles.set(profileId, profile);
  }
  return [...profiles.values()];
}

export function listSyncTargets(): SyncTarget[] {
  const profiles = planVanguardProfiles({ kind: 'current', overlapDays: 7 }, isoDate(), () => {});
  return syncTargetsForProfiles(bankOfAmericaCoverage().length > 0, profiles);
}

function accountForArtifact(fileName: string, accounts: AccountCoverageRow[]) {
  if (/^bofa-checking-/i.test(fileName)) return accountByKind(accounts, 'checking');
  if (/^bofa-savings-/i.test(fileName)) return accountByKind(accounts, 'savings');
  if (/^bofa-credit-card-/i.test(fileName)) return accountByKind(accounts, 'credit');
  throw new Error(`Cannot resolve an account for ${fileName}.`);
}

async function stageArtifacts(
  request: SyncRunRequest,
  artifacts: Array<{ fileName: string; accountId: number }>,
  outputDir: string,
  report: SyncReporter,
): Promise<SyncRunReview> {
  const reviews: SyncArtifactReview[] = [];
  for (const artifact of artifacts) {
    report({ type: 'artifact', message: `Reviewing ${artifact.fileName}` });
    const review = await stageSyncArtifact({
      path: join(outputDir, artifact.fileName),
      fileName: artifact.fileName,
      accountId: artifact.accountId,
    });
    reviews.push(review);
    report({
      type: 'artifact',
      message: review.status === 'already-imported'
        ? `${artifact.fileName} was already imported`
        : `Parsed ${artifact.fileName}`,
      data: {
        transactions: review.transactionCount,
        balances: review.balanceCount,
        coveredFrom: review.coveredFrom,
        coveredTo: review.coveredTo,
      },
    });
  }
  return {
    runId: request.runId,
    institutionId: request.institutionId,
    downloaded: artifacts.length,
    readyToImport: reviews.filter(review => review.status === 'ready').length,
    alreadyImported: reviews.filter(review => review.status === 'already-imported').length,
    artifacts: reviews,
  };
}

export async function runSync(request: SyncRunRequest, report: SyncReporter): Promise<SyncRunReview> {
  if (request.institutionId === 'vanguard') {
    const today = isoDate();
    const plannedProfiles = planVanguardProfiles(request.goal, today, report);
    const profiles = selectVanguardProfiles(plannedProfiles, request.connectionId);
    if (request.connectionId && profiles.length === 0) {
      throw new Error(`Vanguard connection is unavailable: ${request.connectionId}`);
    }
    if (profiles.length === 0) throw new Error('No active Vanguard accounts are associated with a known login profile');
    const outputDir = join(syncApplicationDataRoot(), request.runId, 'artifacts');
    await mkdir(outputDir, { recursive: true });
    report({
      type: 'phase',
      message: `Opening ${profiles.length} Vanguard login${profiles.length === 1 ? '' : 's'}`,
      data: { goal: request.goal.kind, profiles: profiles.map(profile => profile.id) },
    });
    const downloaded = await runVanguardSync({ outputDir, through: today, profiles });
    report({ type: 'phase', message: `Validated ${downloaded.length} new artifact${downloaded.length === 1 ? '' : 's'}` });
    const review = await stageArtifacts(request, downloaded, outputDir, report);
    report({ type: 'review', message: 'Vanguard downloads are ready to review', data: { review } });
    return review;
  }
  if (request.institutionId !== 'bank-of-america') throw new Error(`Unsupported institution: ${request.institutionId}`);
  const accounts = bankOfAmericaCoverage();
  const today = isoDate();
  const checking = accountByKind(accounts, 'checking');
  const savings = accountByKind(accounts, 'savings');
  const credit = accountByKind(accounts, 'credit');
  const checkingWindow = goalWindowForCoverage(request.goal, checking, today);
  const savingsWindow = goalWindowForCoverage(request.goal, savings, today);
  const creditWindow = goalWindowForCoverage(request.goal, credit, today);
  const outputDir = join(syncApplicationDataRoot(), request.runId, 'artifacts');
  await mkdir(outputDir, { recursive: true });

  report({ type: 'phase', message: 'Opening Bank of America', data: { goal: request.goal.kind } });
  const config: BankOfAmericaSyncConfig = {
    outputDir,
    through: checkingWindow.endDate,
    checkingThrough: checkingWindow.endDate,
    savingsThrough: savingsWindow.endDate,
    cardThrough: creditWindow.endDate,
    checkingFrom: checkingWindow.startDate,
    savingsFrom: savingsWindow.startDate,
    cardFrom: creditWindow.startDate,
    session: 'bank-of-america',
    scope: null,
    dryRun: false,
  };
  const downloaded = await runBankOfAmericaSync(config, message => {
    report({ type: 'action', message });
  });
  report({ type: 'phase', message: `Validated ${downloaded.saved.length} new artifact${downloaded.saved.length === 1 ? '' : 's'}` });

  const artifacts = downloaded.saved.map(fileName => {
    const account = accountForArtifact(fileName, accounts);
    return {
      fileName,
      accountId: account.id,
    };
  });
  const review = await stageArtifacts(request, artifacts, outputDir, report);
  report({ type: 'review', message: 'Bank of America downloads are ready to review', data: { review } });
  return review;
}
