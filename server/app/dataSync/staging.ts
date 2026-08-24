import { join } from 'node:path';

import {
  discardSyncPreviewIds,
  stageSyncArtifactWithProvenance,
} from './review.ts';
import type {
  SyncArtifactManifest,
  SyncArtifactReview,
  SyncReporter,
  SyncRunReview,
} from './types.ts';

export interface StagedSyncArtifactManifest {
  review: SyncRunReview;
  createdImportFileIds: number[];
}

export async function stageSyncArtifactManifest(
  manifest: SyncArtifactManifest,
  outputDir: string,
  report: SyncReporter,
  shouldContinue: () => boolean = () => true,
): Promise<StagedSyncArtifactManifest> {
  const reviews: SyncArtifactReview[] = [];
  const createdImportFileIds: number[] = [];
  try {
    for (const artifact of manifest.artifacts) {
      if (!shouldContinue()) throw new Error('Sync manifest staging was cancelled');
      report({ type: 'artifact', message: `Reviewing ${artifact.fileName}` });
      const staged = await stageSyncArtifactWithProvenance({
        path: join(outputDir, artifact.fileName),
        fileName: artifact.fileName,
        accountId: artifact.accountId,
        expectedSizeBytes: artifact.sizeBytes,
        expectedSha256: artifact.sha256,
      });
      const review = staged.review;
      reviews.push(review);
      if (staged.createdPreview) createdImportFileIds.push(review.importFileId);
      if (!shouldContinue()) throw new Error('Sync manifest staging was cancelled');
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
  } catch (error) {
    discardSyncPreviewIds(createdImportFileIds);
    throw error;
  }
  return {
    review: {
      runId: manifest.runId,
      institutionId: manifest.institutionId,
      downloaded: manifest.artifacts.length,
      readyToImport: reviews.filter(review => review.status === 'ready').length,
      alreadyImported: reviews.filter(review => review.status === 'already-imported').length,
      artifacts: reviews,
    },
    createdImportFileIds,
  };
}
