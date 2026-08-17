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
import type { SyncGoal, SyncReporter, SyncRunRequest, SyncRunResult } from './types.ts';

interface AccountCoverageRow {
  id: number;
  name: string;
  type: string;
  latestFactDate: string | null;
  earliestFactDate: string | null;
}

function isoDate(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

function shiftDays(date: string, days: number) {
  const dateOnly = date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) throw new Error(`Invalid source fact date: ${date}`);
  const value = new Date(`${dateOnly}T00:00:00Z`);
  if (Number.isNaN(value.getTime()) || value.toISOString().slice(0, 10) !== dateOnly) {
    throw new Error(`Invalid source fact date: ${date}`);
  }
  value.setUTCDate(value.getUTCDate() + days);
  return isoDate(value);
}

export function syncApplicationDataRoot() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'EasyMoney', 'sync-runs');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'EasyMoney', 'sync-runs');
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'easymoney', 'sync-runs');
}

function bankOfAmericaCoverage(): AccountCoverageRow[] {
  return getDb().prepare(`
    WITH facts AS (
      SELECT sa.accountId, st.date
      FROM sourceTransactions st
      JOIN sourceAccounts sa ON sa.id = st.sourceAccountId
      JOIN sourceFiles sf ON sf.id = st.sourceFileId AND sf.status = 'committed'
      UNION ALL
      SELECT sa.accountId, sb.date
      FROM sourceBalances sb
      JOIN sourceAccounts sa ON sa.id = sb.sourceAccountId
      JOIN sourceFiles sf ON sf.id = sb.sourceFileId AND sf.status = 'committed'
    )
    SELECT a.id, a.name, a.type, MIN(f.date) AS earliestFactDate, MAX(f.date) AS latestFactDate
    FROM accounts a
    LEFT JOIN facts f ON f.accountId = a.id
    WHERE LOWER(COALESCE(a.institution, '')) LIKE '%bank of america%'
      AND COALESCE(a.status, 'active') = 'active'
    GROUP BY a.id
    ORDER BY a.id
  `).all() as AccountCoverageRow[];
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

export function goalWindowForCoverage(
  goal: SyncGoal,
  account: Pick<AccountCoverageRow, 'latestFactDate' | 'earliestFactDate'>,
  today: string,
) {
  if (goal.kind === 'range') return { startDate: goal.startDate, endDate: goal.endDate };
  if (goal.kind === 'backfill') {
    return {
      startDate: goal.stopAt ?? '2000-01-01',
      endDate: account.earliestFactDate ? shiftDays(account.earliestFactDate, 7) : today,
    };
  }
  return {
    startDate: account.latestFactDate ? shiftDays(account.latestFactDate, -goal.overlapDays) : shiftDays(today, -365),
    endDate: today,
  };
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
