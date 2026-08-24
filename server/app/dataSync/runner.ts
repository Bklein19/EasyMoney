import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import type { SyncConnector } from './connector.ts';
import { getSyncConnector } from './registry.ts';
import {
  SYNC_WORKER_PROTOCOL_VERSION,
  type SyncArtifactManifest,
  type SyncArtifactManifestEntry,
  type SyncExecutionPlan,
  type SyncReporter,
} from './types.ts';

type ConnectorResolver = (
  institutionId: SyncExecutionPlan['institutionId'],
) => SyncConnector<SyncExecutionPlan['institutionId']>;

function artifactPath(outputDir: string, fileName: string): string {
  if (!fileName || basename(fileName) !== fileName || fileName === '.' || fileName === '..') {
    throw new Error('Connector returned an unsafe artifact file name');
  }
  const outputRoot = resolve(outputDir);
  const path = resolve(outputRoot, fileName);
  if (dirname(path) !== outputRoot) throw new Error('Connector artifact escaped its output directory');
  return path;
}

async function manifestEntry(
  plan: SyncExecutionPlan,
  artifact: { fileName: string; accountId: number },
): Promise<SyncArtifactManifestEntry> {
  if (!plan.accounts.some(account => account.id === artifact.accountId)) {
    throw new Error('Connector routed an artifact to an account outside its execution plan');
  }
  const path = artifactPath(plan.outputDir, artifact.fileName);
  const file = await stat(path);
  if (!file.isFile()) throw new Error(`Downloaded artifact is not a file: ${artifact.fileName}`);
  const bytes = await readFile(path);
  const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  return {
    ...artifact,
    sizeBytes: bytes.byteLength,
    sha256,
  };
}

export async function runSyncExecutionPlan(
  plan: SyncExecutionPlan,
  report: SyncReporter,
  resolveConnector: ConnectorResolver = getSyncConnector,
): Promise<SyncArtifactManifest> {
  await mkdir(plan.outputDir, { recursive: true, mode: 0o700 });
  const connector = resolveConnector(plan.institutionId);
  const artifacts = await connector.run({
    today: plan.today,
    accounts: plan.accounts,
    goal: plan.goal,
    connectionId: plan.connectionId,
    outputDir: plan.outputDir,
    report,
  });
  const fileNames = artifacts.map(artifact => artifact.fileName);
  if (new Set(fileNames).size !== fileNames.length) {
    throw new Error('Connector returned the same artifact more than once');
  }
  return {
    protocolVersion: SYNC_WORKER_PROTOCOL_VERSION,
    runId: plan.runId,
    institutionId: plan.institutionId,
    artifacts: await Promise.all(artifacts.map(artifact => manifestEntry(plan, artifact))),
  };
}
