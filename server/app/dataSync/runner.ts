import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { SyncConnector } from './connector.ts';
import { loadSyncAccountCoverage } from './coverage.ts';
import { syncApplicationDataRoot } from './paths.ts';
import { getSyncConnector, syncConnectors } from './registry.ts';
import { stageSyncArtifact } from './review.ts';
import type {
  SyncArtifactReview,
  SyncInstitutionId,
  SyncReporter,
  SyncRunRequest,
  SyncRunReview,
  SyncTarget,
} from './types.ts';

function isoDate(value = new Date()): string {
  return value.toISOString().slice(0, 10);
}

export function listSyncTargets(): SyncTarget[] {
  const context = {
    today: isoDate(),
    accounts: loadSyncAccountCoverage(),
  };
  const connectors: readonly SyncConnector<SyncInstitutionId>[] = syncConnectors;
  return connectors.flatMap(connector => connector.listTargets(context).map(target => ({
    id: target.connectionId ? `${connector.id}:${target.connectionId}` : connector.id,
    institutionId: connector.id,
    ...(target.connectionId ? { connectionId: target.connectionId } : {}),
    label: target.label,
  })));
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
  const connector = getSyncConnector(request.institutionId);
  const outputDir = join(syncApplicationDataRoot(), request.runId, 'artifacts');
  await mkdir(outputDir, { recursive: true });
  const artifacts = await connector.run({
    today: isoDate(),
    accounts: loadSyncAccountCoverage(),
    goal: request.goal,
    connectionId: request.connectionId,
    outputDir,
    report,
  });
  const review = await stageArtifacts(request, artifacts, outputDir, report);
  report({
    type: 'review',
    message: `${connector.label} downloads are ready to review`,
    data: { review },
  });
  return review;
}
