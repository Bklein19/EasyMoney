import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { getDb } from '../../database.ts';
import {
  commitImport,
  getImportAccountMappings,
  hashImportContent,
  previewImport,
  rebuildLedgerReadModel,
} from '../imports.ts';
import { importParserDisplayName } from '../importParsers/index.ts';
import type { SyncArtifactAccountRoute } from './connector.ts';
import { importSyncArtifactBatch } from './artifactBatch.ts';
import type {
  SyncAccountMappingDecision,
  SyncAccountClaim,
  SyncArtifactReview,
  SyncArtifactReviewStatus,
  SyncBalanceClaim,
  SyncReporter,
  SyncRunResult,
  SyncRunReview,
  SyncTransactionClaim,
} from './types.ts';

export interface StageSyncArtifactInput {
  path: string;
  fileName?: string;
  accountId?: number;
  accountRoutes?: SyncArtifactAccountRoute[];
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
  contentHash: string;
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
      ifs.contentHash,
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

function destinationAccount(accountId: number, options: { allowArchived?: boolean } = {}) {
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
  if (!options.allowArchived && (account.status || 'active') === 'archived') {
    throw new Error(`Account is archived: ${accountId}`);
  }
  return account;
}

interface StoredSyncAccountClaim {
  sourceAccountId: number;
  remoteAccountId: string;
  institution: string | null;
  accountName: string | null;
  accountHolder: string | null;
  transactionCount: number;
  balanceCount: number;
}

function storedAccountClaims(importFileId: number): StoredSyncAccountClaim[] {
  return (getDb().prepare(`
    SELECT
      sa.id AS sourceAccountId,
      sa.sourceAccountKey AS remoteAccountId,
      sa.institution,
      sa.sourceAccountName AS accountName,
      sa.accountHolder,
      COUNT(DISTINCT st.id) AS transactionCount,
      COUNT(DISTINCT sb.id) AS balanceCount
    FROM sourceAccounts sa
    JOIN sourceFiles sf ON sf.id = sa.sourceFileId
    LEFT JOIN sourceTransactions st ON st.sourceAccountId = sa.id
    LEFT JOIN sourceBalances sb ON sb.sourceAccountId = sa.id
    WHERE sf.importFileId = ?
    GROUP BY sa.id
    ORDER BY sa.id
  `).all(importFileId) as StoredSyncAccountClaim[]).map(claim => ({
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

function resolveAccountClaims(
  importFileId: number,
  options: { accountId?: number; accountRoutes?: SyncArtifactAccountRoute[] },
): SyncAccountClaim[] {
  if (options.accountId !== undefined && options.accountRoutes !== undefined) {
    throw new Error('A sync artifact cannot use both accountId and accountRoutes.');
  }

  const stored = storedAccountClaims(importFileId);
  const claimsByRemoteId = new Map<string, StoredSyncAccountClaim>();
  for (const claim of stored) {
    if (!claim.remoteAccountId?.trim()) {
      throw new Error(`Source account ${claim.sourceAccountId} has no stable remote identity.`);
    }
    if (claimsByRemoteId.has(claim.remoteAccountId)) {
      throw new Error(`Ambiguous parser account identity: ${claim.remoteAccountId}`);
    }
    claimsByRemoteId.set(claim.remoteAccountId, claim);
  }

  const routeByRemoteId = new Map<string, SyncArtifactAccountRoute>();
  for (const route of options.accountRoutes ?? []) {
    const remoteAccountId = route.remoteAccountId.trim();
    if (!remoteAccountId) throw new Error('Sync artifact account routes require a remoteAccountId.');
    if (routeByRemoteId.has(remoteAccountId)) {
      throw new Error(`Ambiguous connector account identity: ${remoteAccountId}`);
    }
    if (!claimsByRemoteId.has(remoteAccountId)) {
      throw new Error(`Connector account identity was not found in the parsed artifact: ${remoteAccountId}`);
    }
    if (route.accountId !== undefined) destinationAccount(route.accountId);
    routeByRemoteId.set(remoteAccountId, { ...route, remoteAccountId });
  }

  if (options.accountId !== undefined) {
    destinationAccount(options.accountId);
    if (stored.length !== 1) {
      throw new Error(
        `Legacy sync routing requires exactly one parsed account claim; found ${stored.length}.`,
      );
    }
    routeByRemoteId.set(stored[0]!.remoteAccountId, {
      remoteAccountId: stored[0]!.remoteAccountId,
      accountId: options.accountId,
    });
  }

  const importsBySourceId = new Map(
    getImportAccountMappings(importFileId).map(mapping => [mapping.sourceAccountId, mapping]),
  );
  return stored.map(claim => {
    const imported = importsBySourceId.get(claim.sourceAccountId);
    if (!imported) throw new Error(`Import account claim is unavailable: ${claim.sourceAccountId}`);
    const connectorRoute = routeByRemoteId.get(claim.remoteAccountId);
    const connectorAccountId = connectorRoute?.accountId;
    const requiresExplicitMapping = options.accountId === undefined && connectorAccountId === undefined;
    const resolvedAccountId = connectorAccountId ?? imported.resolvedAccountId;
    const account = resolvedAccountId
      ? destinationAccount(resolvedAccountId, { allowArchived: true })
      : null;
    return {
      ...claim,
      resolvedAccountId,
      resolvedAccountName: account?.name ?? null,
      resolvedAccountStatus: account?.status || (account ? 'active' : null),
      resolution: connectorAccountId === undefined ? imported.resolution : 'connector',
      requiresExplicitMapping,
    };
  });
}

function reviewWarnings(claims: SyncAccountClaim[]): string[] {
  const warnings: string[] = [];
  for (const claim of claims) {
    if (claim.resolution === 'ambiguous') {
      warnings.push(`${claim.accountName || 'A source account'} matches multiple local accounts and needs an explicit choice.`);
      continue;
    }
    if (claim.resolution === 'archived-match') {
      warnings.push(`${claim.accountName || 'A source account'} matches an archived account and needs an explicit choice.`);
      continue;
    }
    if (!claim.resolvedAccountId) {
      warnings.push(`${claim.accountName || 'A newly discovered source account'} needs an account mapping before import.`);
      continue;
    }
    if (claim.requiresExplicitMapping) {
      warnings.push(`${claim.accountName || 'A source account'} needs an explicit account choice before import.`);
    }
    const account = destinationAccount(claim.resolvedAccountId, { allowArchived: true });
    const destinationHolder = account.accountHolder?.trim().toLowerCase();
    const claimedHolder = claim.accountHolder?.trim().toLowerCase();
    if (destinationHolder && claimedHolder && destinationHolder !== claimedHolder) {
      warnings.push(`The file names ${claim.accountHolder} as the account holder, while ${account.name} belongs to ${account.accountHolder}.`);
    }
  }
  return warnings;
}

export function buildSyncArtifactReview(options: {
  importFileId: number;
  accountId?: number;
  accountRoutes?: SyncArtifactAccountRoute[];
  fileName?: string;
  status: SyncArtifactReviewStatus;
}): SyncArtifactReview {
  const metadata = importFileRow(options.importFileId);
  const accounts = resolveAccountClaims(options.importFileId, options);
  const resolvedIds = [...new Set(accounts
    .map(claim => claim.resolvedAccountId)
    .filter((accountId): accountId is number => accountId !== null))];
  const destination = resolvedIds.length === 1 &&
    accounts.every(claim => claim.resolvedAccountId === resolvedIds[0])
    ? destinationAccount(resolvedIds[0]!, { allowArchived: true })
    : null;
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
    accountId: destination?.id ?? null,
    accountName: destination?.name ?? null,
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
    warnings: reviewWarnings(accounts),
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
        accountRoutes: input.accountRoutes,
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
        accountRoutes: input.accountRoutes,
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

function explicitMappingForClaim(
  claim: SyncAccountClaim,
  mapping: SyncAccountMappingDecision,
): SyncAccountMappingDecision {
  if (mapping.mode === 'auto') {
    if (!claim.resolvedAccountId || claim.resolution === 'ambiguous' || claim.resolution === 'archived-match') {
      throw new Error(`Source account ${claim.sourceAccountId} requires an explicit account choice.`);
    }
    destinationAccount(claim.resolvedAccountId);
    return {
      sourceAccountId: claim.sourceAccountId,
      mode: 'existing',
      accountId: claim.resolvedAccountId,
    };
  }
  if (mapping.mode === 'create') {
    if (!mapping.account || (
      !mapping.account.name?.trim() &&
      (!claim.accountName?.trim() || claim.accountName === 'Selected account')
    )) {
      throw new Error(`Account name is required for source account ${claim.sourceAccountId}.`);
    }
    return mapping;
  }
  if (mapping.mode === 'unarchive') {
    const accountId = Number(mapping.accountId);
    if (!Number.isFinite(accountId)) {
      throw new Error(`Account id is required for source account ${claim.sourceAccountId}.`);
    }
    destinationAccount(accountId, { allowArchived: true });
    return { ...mapping, accountId };
  }
  const accountId = mapping.accountId === null ? null : Number(mapping.accountId);
  if (accountId === null || !Number.isFinite(accountId)) {
    throw new Error(`Account id is required for source account ${claim.sourceAccountId}.`);
  }
  destinationAccount(accountId);
  return {
    sourceAccountId: claim.sourceAccountId,
    mode: 'existing',
    accountId,
  };
}

function validatedSyncAccountMappings(
  review: SyncRunReview,
  requested?: SyncAccountMappingDecision[] | null,
): Map<number, SyncAccountMappingDecision[]> {
  const readyArtifacts = review.artifacts.filter(artifact => artifact.status === 'ready');
  const claims = readyArtifacts.flatMap(artifact => artifact.accountClaims);
  const claimById = new Map(claims.map(claim => [claim.sourceAccountId, claim]));
  if (claimById.size !== claims.length) {
    throw new Error('Sync review contains duplicate source account claims.');
  }

  for (const artifact of readyArtifacts) {
    const storedIds = storedAccountClaims(artifact.importFileId).map(claim => claim.sourceAccountId).sort((a, b) => a - b);
    const reviewIds = artifact.accountClaims.map(claim => claim.sourceAccountId).sort((a, b) => a - b);
    if (storedIds.join(',') !== reviewIds.join(',')) {
      throw new Error(`${artifact.fileName} account claims changed after review.`);
    }
  }

  const requestedById = new Map<number, SyncAccountMappingDecision>();
  for (const mapping of requested ?? []) {
    const sourceAccountId = Number(mapping?.sourceAccountId);
    if (!Number.isFinite(sourceAccountId) || !claimById.has(sourceAccountId)) {
      throw new Error('Sync confirmation contains an unknown source account claim.');
    }
    if (requestedById.has(sourceAccountId)) {
      throw new Error(`Sync confirmation contains duplicate mapping for source account ${sourceAccountId}.`);
    }
    requestedById.set(sourceAccountId, mapping);
  }
  if (requested && requestedById.size !== claimById.size) {
    throw new Error('Resolve every source account before confirming the catch-up.');
  }

  const validatedBySourceId = new Map<number, SyncAccountMappingDecision>();
  for (const claim of claims) {
    const requestedMapping = requestedById.get(claim.sourceAccountId);
    const defaultMapping: SyncAccountMappingDecision | null = claim.resolvedAccountId &&
      claim.resolvedAccountStatus !== 'archived' &&
      claim.resolution !== 'ambiguous' &&
      !claim.requiresExplicitMapping
      ? { sourceAccountId: claim.sourceAccountId, mode: 'existing', accountId: claim.resolvedAccountId }
      : null;
    const mapping = requestedMapping ?? defaultMapping;
    if (!mapping) {
      throw new Error('Resolve every source account before confirming the catch-up.');
    }
    validatedBySourceId.set(claim.sourceAccountId, explicitMappingForClaim(claim, mapping));
  }

  return new Map(readyArtifacts.map(artifact => [
    artifact.importFileId,
    artifact.accountClaims.map(claim => validatedBySourceId.get(claim.sourceAccountId)!),
  ]));
}

function commitArtifact(
  artifact: SyncArtifactReview,
  mappings: SyncAccountMappingDecision[],
) {
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

  return commitImport({
    accountId: null,
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
  accountMappings?: SyncAccountMappingDecision[] | null,
): Promise<SyncRunResult> {
  const mappingsByImportFile = validatedSyncAccountMappings(review, accountMappings);
  const imported = await importSyncArtifactBatch(
    review.artifacts.map(artifact => ({
      fileName: artifact.fileName,
      accountId: artifact.accountId,
      accountIds: [...new Set(artifact.accountClaims
        .map(claim => claim.resolvedAccountId)
        .filter((accountId): accountId is number => accountId !== null))],
      import: () => Promise.resolve(commitArtifact(
        artifact,
        mappingsByImportFile.get(artifact.importFileId) ?? [],
      )),
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
