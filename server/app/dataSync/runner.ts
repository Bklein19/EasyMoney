import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { getDb } from '../../database.ts';
import { commitImport, hashImportContent, previewImport, rebuildLedgerReadModel } from '../imports.ts';
import { importSyncArtifactBatch } from './artifactBatch.ts';
import {
  runBankOfAmericaSync,
  type BankOfAmericaSyncConfig,
} from './institutions/bankOfAmerica.ts';
import {
  runVanguardSync,
  type VanguardAccountKind,
  type VanguardSyncProfile,
} from './institutions/vanguard.ts';
import type { SyncGoal, SyncReporter, SyncRunRequest, SyncRunResult } from './types.ts';
import {
  goalWindowForCoverage,
  missingMonthlyStatementDates,
  vanguardProfileIdFromFileNames,
} from './planning.ts';

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
}

function isoDate(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

export function syncApplicationDataRoot() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'EasyMoney', 'sync-runs');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'EasyMoney', 'sync-runs');
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'easymoney', 'sync-runs');
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
      MIN(f.date) AS earliestFactDate,
      MAX(f.date) AS latestFactDate,
      MIN(CASE WHEN f.factType = 'balance' THEN f.date END) AS earliestBalanceDate,
      MAX(CASE WHEN f.factType = 'balance' THEN f.date END) AS latestBalanceDate,
      GROUP_CONCAT(DISTINCT CASE WHEN f.factType = 'balance' THEN SUBSTR(f.date, 1, 10) END) AS balanceDates,
      (
        SELECT sa2.sourceAccountName
        FROM sourceAccounts sa2
        JOIN sourceFiles sf2 ON sf2.id = sa2.sourceFileId AND sf2.status = 'committed'
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
    WHERE sa.accountId = ? AND sf.status = 'committed'
    ORDER BY COALESCE(sf.committedAt, sf.createdAt) DESC, sf.id DESC
  `).all(accountId) as Array<{ fileName: string }>).map(row => row.fileName);
}

export function planVanguardProfiles(goal: SyncGoal, today: string, report: SyncReporter): VanguardSyncProfile[] {
  const profiles = new Map<string, VanguardSyncProfile>();
  for (const account of institutionCoverage('%vanguard%')) {
    const profileId = vanguardProfileIdFromFileNames(vanguardArtifactNames(account.id));
    const accountKind = vanguardKind(account);
    const accountLast4 = vanguardLast4(account);
    if (!profileId || !accountKind || !accountLast4) {
      report({
        type: 'warning',
        message: `Skipped ${account.name}; it is not associated with a Vanguard login profile and account number`,
        data: { accountId: account.id },
      });
      continue;
    }
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
    const profile = profiles.get(profileId) ?? {
      id: profileId,
      session: profileId === 'current' ? 'vanguard-catchup' : `vanguard-${profileId}-catchup`,
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

function accountForArtifact(fileName: string, accounts: AccountCoverageRow[]) {
  if (/^bofa-checking-/i.test(fileName)) return accountByKind(accounts, 'checking');
  if (/^bofa-savings-/i.test(fileName)) return accountByKind(accounts, 'savings');
  if (/^bofa-credit-card-/i.test(fileName)) return accountByKind(accounts, 'credit');
  throw new Error(`Cannot resolve an account for ${fileName}.`);
}

async function importArtifact(path: string, accountId: number) {
  const fileName = basename(path);
  const fileBytes = new Uint8Array(await readFile(path));
  const text = fileName.toLowerCase().endsWith('.csv') ? new TextDecoder().decode(fileBytes) : '';
  const contentHash = hashImportContent(text, fileBytes);
  const existing = getDb().prepare(`
    SELECT id
    FROM importFiles
    WHERE contentHash = ? AND status = 'committed'
    LIMIT 1
  `).get(contentHash);
  if (existing) {
    return {
      importedCount: 0,
      importedBalanceCount: 0,
      skippedDuplicateCount: 0,
      skippedArtifact: true,
    };
  }
  const preview = await previewImport({ fileName, text, fileBytes });
  const transactionIds = preview.transactions?.map(transaction => Number(transaction.importRowId)).filter(Number.isFinite) ?? [];
  return commitImport({
    accountId,
    importFileId: preview.importFileId,
    importRowIds: transactionIds,
    balanceRowIds: preview.balanceRowIds ?? null,
    rebuildLedger: false,
  });
}

export async function runSync(request: SyncRunRequest, report: SyncReporter): Promise<SyncRunResult> {
  if (request.institutionId === 'vanguard') {
    const today = isoDate();
    const profiles = planVanguardProfiles(request.goal, today, report);
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
    const imported = await importSyncArtifactBatch(
      downloaded.map(artifact => ({
        fileName: artifact.fileName,
        accountId: artifact.accountId,
        import: () => importArtifact(join(outputDir, artifact.fileName), artifact.accountId),
      })),
      report,
      rebuildLedgerReadModel,
    );
    const result = {
      runId: request.runId,
      institutionId: request.institutionId,
      downloaded: downloaded.length,
      ...imported,
      artifacts: downloaded.map(artifact => artifact.fileName),
    } satisfies SyncRunResult;
    report({ type: 'complete', message: 'Vanguard sync complete', data: result });
    return result;
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
  const downloaded = await runBankOfAmericaSync(config);
  report({ type: 'phase', message: `Validated ${downloaded.saved.length} new artifact${downloaded.saved.length === 1 ? '' : 's'}` });

  const jobs = downloaded.saved.map(fileName => {
    const account = accountForArtifact(fileName, accounts);
    return {
      fileName,
      accountId: account.id,
      import: () => importArtifact(join(outputDir, fileName), account.id),
    };
  });
  const {
    recordedTransactionFacts,
    recordedBalanceFacts,
    skippedTransactionDuplicates,
    skippedArtifacts,
  } = await importSyncArtifactBatch(
    jobs,
    report,
    rebuildLedgerReadModel,
  );

  const result = {
    runId: request.runId,
    institutionId: request.institutionId,
    downloaded: downloaded.saved.length,
    recordedTransactionFacts,
    recordedBalanceFacts,
    skippedTransactionDuplicates,
    skippedArtifacts,
    artifacts: downloaded.saved,
  } satisfies SyncRunResult;
  report({ type: 'complete', message: 'Bank of America sync complete', data: result });
  return result;
}
