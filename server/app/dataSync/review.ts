import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { getDb } from '../../database.ts';
import { commitImport, hashImportContent, previewImport, rebuildLedgerReadModel } from '../imports.ts';
import { importParserDisplayName } from '../importParsers/index.ts';
import { importSyncArtifactBatch } from './artifactBatch.ts';
import type {
  SyncAccountClaim,
  SyncArtifactReview,
  SyncArtifactReviewStatus,
  SyncBalanceClaim,
  SyncReporter,
  SyncRunResult,
  SyncRunReview,
  SyncTransactionClaim,
} from './types.ts';

interface StageSyncArtifactInput {
  path: string;
  fileName?: string;
  accountId: number;
  expectedSizeBytes?: number;
  expectedSha256?: string;
  reusePreview?: boolean;
}

export interface StagedSyncArtifact {
  review: SyncArtifactReview;
  createdPreview: boolean;
}

interface ImportFileRow {
  id: number;
  fileName: string;
  parserName: string | null;
  institution: string | null;
  sourceType: string | null;
  status: string | null;
  coveredFrom: string | null;
  coveredTo: string | null;
}

function importFileRow(importFileId: number): ImportFileRow {
  const row = getDb().prepare(`
    SELECT
      ifs.id,
      ifs.fileName,
      ifs.parserName,
      ifs.institution,
      ifs.sourceType,
      ifs.status,
      sf.coveredFrom,
      sf.coveredTo
    FROM importFiles ifs
    LEFT JOIN sourceFiles sf ON sf.importFileId = ifs.id
    WHERE ifs.id = ?
  `).get(importFileId) as ImportFileRow | undefined;
  if (!row) throw new Error(`Staged import not found: ${importFileId}`);
  return row;
}

function destinationAccount(accountId: number) {
  const account = getDb().prepare(`
    SELECT id, name, accountHolder, status
    FROM accounts
    WHERE id = ?
  `).get(accountId) as {
    id: number;
    name: string;
    accountHolder: string | null;
    status: string | null;
  } | undefined;
  if (!account) throw new Error(`Account not found: ${accountId}`);
  if ((account.status || 'active') === 'archived') throw new Error(`Account is archived: ${accountId}`);
  return account;
}

function accountClaims(importFileId: number): SyncAccountClaim[] {
  return (getDb().prepare(`
    SELECT
      sa.id AS sourceAccountId,
      sa.institution,
      sa.sourceAccountName AS accountName,
      sa.accountHolder,
      sa.accountId AS resolvedAccountId,
      a.name AS resolvedAccountName,
      COUNT(DISTINCT st.id) AS transactionCount,
      COUNT(DISTINCT sb.id) AS balanceCount
    FROM sourceAccounts sa
    JOIN sourceFiles sf ON sf.id = sa.sourceFileId
    LEFT JOIN accounts a ON a.id = sa.accountId
    LEFT JOIN sourceTransactions st ON st.sourceAccountId = sa.id
    LEFT JOIN sourceBalances sb ON sb.sourceAccountId = sa.id
    WHERE sf.importFileId = ?
    GROUP BY sa.id
    ORDER BY sa.id
  `).all(importFileId) as SyncAccountClaim[]).map(claim => ({
    ...claim,
    transactionCount: Number(claim.transactionCount || 0),
    balanceCount: Number(claim.balanceCount || 0),
  }));
}

function transactionClaims(importFileId: number): SyncTransactionClaim[] {
  return getDb().prepare(`
    SELECT
      st.date,
      st.amountCents,
      COALESCE(st.description, '') AS description,
      sa.sourceAccountName AS account,
      st.sourceRole
    FROM sourceTransactions st
    JOIN sourceFiles sf ON sf.id = st.sourceFileId
    JOIN sourceAccounts sa ON sa.id = st.sourceAccountId
    WHERE sf.importFileId = ?
    ORDER BY st.date DESC, st.id DESC
  `).all(importFileId) as SyncTransactionClaim[];
}

function balanceClaims(importFileId: number): SyncBalanceClaim[] {
  return getDb().prepare(`
    SELECT
      sb.date,
      sb.balanceCents,
      sa.sourceAccountName AS account,
      sa.accountHolder
    FROM sourceBalances sb
    JOIN sourceFiles sf ON sf.id = sb.sourceFileId
    JOIN sourceAccounts sa ON sa.id = sb.sourceAccountId
    WHERE sf.importFileId = ?
    ORDER BY sb.date DESC, sb.id DESC
  `).all(importFileId) as SyncBalanceClaim[];
}

function reviewWarnings(
  claims: SyncAccountClaim[],
  account: ReturnType<typeof destinationAccount>,
): string[] {
  const warnings: string[] = [];
  if (claims.length > 1) {
    warnings.push(`This file identifies ${claims.length} source accounts but is mapped to ${account.name}.`);
  }
  const destinationHolder = account.accountHolder?.trim().toLowerCase();
  for (const claim of claims) {
    if (claim.resolvedAccountId && claim.resolvedAccountId !== account.id) {
      warnings.push(`The saved source account is linked to ${claim.resolvedAccountName || `account ${claim.resolvedAccountId}`}, not ${account.name}.`);
    }
    const claimedHolder = claim.accountHolder?.trim().toLowerCase();
    if (destinationHolder && claimedHolder && destinationHolder !== claimedHolder) {
      warnings.push(`The file names ${claim.accountHolder} as the account holder, while ${account.name} belongs to ${account.accountHolder}.`);
    }
  }
  return warnings;
}

export function buildSyncArtifactReview(options: {
  importFileId: number;
  accountId: number;
  fileName?: string;
  status: SyncArtifactReviewStatus;
}): SyncArtifactReview {
  const metadata = importFileRow(options.importFileId);
  const account = destinationAccount(options.accountId);
  const accounts = accountClaims(options.importFileId);
  const transactions = transactionClaims(options.importFileId);
  const balances = balanceClaims(options.importFileId);
  const inflowCents = transactions.reduce((sum, transaction) =>
    sum + Math.max(0, Number(transaction.amountCents)), 0);
  const outflowCents = transactions.reduce((sum, transaction) =>
    sum + Math.abs(Math.min(0, Number(transaction.amountCents))), 0);

  return {
    fileName: options.fileName || metadata.fileName,
    status: options.status,
    importFileId: metadata.id,
    accountId: account.id,
    accountName: account.name,
    parserName: metadata.parserName,
    parserLabel: importParserDisplayName(metadata.parserName),
    institution: metadata.institution,
    sourceType: metadata.sourceType,
    coveredFrom: metadata.coveredFrom,
    coveredTo: metadata.coveredTo,
    transactionCount: transactions.length,
    balanceCount: balances.length,
    inflowCents,
    outflowCents,
    netAmountCents: inflowCents - outflowCents,
    accountClaims: accounts,
    transactionSamples: transactions.slice(0, 6),
    balanceClaims: balances.slice(0, 12),
    warnings: reviewWarnings(accounts, account),
  };
}

export async function stageSyncArtifactWithProvenance(
  input: StageSyncArtifactInput,
): Promise<StagedSyncArtifact> {
  const fileName = input.fileName || basename(input.path);
  const fileBytes = new Uint8Array(await readFile(input.path));
  if (input.expectedSizeBytes !== undefined && fileBytes.byteLength !== input.expectedSizeBytes) {
    throw new Error(`Downloaded artifact changed before review: ${fileName}`);
  }
  if (input.expectedSha256 !== undefined) {
    const sha256 = new Bun.CryptoHasher('sha256').update(fileBytes).digest('hex');
    if (sha256 !== input.expectedSha256) {
      throw new Error(`Downloaded artifact changed before review: ${fileName}`);
    }
  }
  const text = /\.(?:csv|txt)$/i.test(fileName) ? new TextDecoder().decode(fileBytes) : '';
  const contentHash = hashImportContent(text, fileBytes);
  const existing = getDb().prepare(`
    SELECT id, status
    FROM importFiles
    WHERE contentHash = ?
      AND (status = 'committed' OR (? = 1 AND status = 'previewed'))
    ORDER BY status = 'committed' DESC, committedAt DESC, id DESC
    LIMIT 1
  `).get(contentHash, input.reusePreview === false ? 0 : 1) as
    | { id: number; status: 'committed' | 'previewed' }
    | undefined;
  if (existing) {
    return {
      review: buildSyncArtifactReview({
        importFileId: existing.id,
        accountId: input.accountId,
        fileName,
        status: existing.status === 'committed' ? 'already-imported' : 'ready',
      }),
      createdPreview: false,
    };
  }

  const preview = await previewImport({ fileName, text, fileBytes });
  const importFileId = Number(preview.importFileId);
  if (preview.requiresMapping) {
    discardSyncPreviewIds([importFileId]);
    throw new Error(`No institution parser matched ${fileName}`);
  }
  try {
    return {
      review: buildSyncArtifactReview({
        importFileId,
        accountId: input.accountId,
        fileName,
        status: 'ready',
      }),
      createdPreview: true,
    };
  } catch (error) {
    discardSyncPreviewIds([importFileId]);
    throw error;
  }
}

export async function stageSyncArtifact(input: StageSyncArtifactInput): Promise<SyncArtifactReview> {
  return (await stageSyncArtifactWithProvenance(input)).review;
}

function commitArtifact(artifact: SyncArtifactReview) {
  const metadata = importFileRow(artifact.importFileId);
  if (metadata.status === 'committed') {
    return {
      importedCount: 0,
      importedBalanceCount: 0,
      skippedDuplicateCount: 0,
      skippedArtifact: true,
    };
  }
  if (metadata.status !== 'previewed') {
    throw new Error(`${artifact.fileName} is no longer awaiting import`);
  }

  const mappings = accountClaims(artifact.importFileId).map(claim => ({
    sourceAccountId: claim.sourceAccountId,
    mode: 'existing' as const,
    accountId: artifact.accountId,
  }));
  return commitImport({
    accountId: artifact.accountId,
    importFileId: artifact.importFileId,
    importRowIds: null,
    balanceRowIds: null,
    accountMappings: mappings,
    rebuildLedger: false,
  });
}

export async function commitSyncReview(
  review: SyncRunReview,
  report: SyncReporter,
): Promise<SyncRunResult> {
  const imported = await importSyncArtifactBatch(
    review.artifacts.map(artifact => ({
      fileName: artifact.fileName,
      accountId: artifact.accountId,
      import: () => Promise.resolve(commitArtifact(artifact)),
    })),
    report,
    rebuildLedgerReadModel,
  );
  return {
    runId: review.runId,
    institutionId: review.institutionId,
    downloaded: review.downloaded,
    ...imported,
    artifacts: review.artifacts.map(artifact => artifact.fileName),
  };
}

export function discardSyncReview(review: SyncRunReview): void {
  discardSyncPreviewIds(review.artifacts
    .filter(artifact => artifact.status === 'ready')
    .map(artifact => artifact.importFileId));
}

export function discardSyncPreviewIds(previewIds: number[]): void {
  previewIds = [...new Set(previewIds)];
  if (previewIds.length === 0) return;

  const db = getDb();
  db.transaction(() => {
    for (const importFileId of previewIds) {
      db.prepare(`
        UPDATE sourceFiles
        SET status = 'discarded'
        WHERE importFileId = ? AND status = 'previewed'
      `).run(importFileId);
      db.prepare(`
        UPDATE importFiles
        SET status = 'discarded'
        WHERE id = ? AND status = 'previewed'
      `).run(importFileId);
    }
  })();
}
