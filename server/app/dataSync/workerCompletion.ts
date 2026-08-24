import type { SyncArtifactManifest } from './types.ts';

export interface CompletedSyncWorker {
  exitCode: number;
  cancelled: boolean;
  protocolError: string | null;
  manifest: SyncArtifactManifest | null;
}

export async function stageCompletedSyncWorker<T>(
  completed: CompletedSyncWorker,
  stage: (manifest: SyncArtifactManifest) => T | Promise<T>,
): Promise<T | null> {
  if (completed.cancelled) return null;
  if (completed.exitCode !== 0) {
    throw new Error(`Sync process exited with code ${completed.exitCode}`);
  }
  if (completed.protocolError) {
    throw new Error(`Sync worker protocol failed: ${completed.protocolError}`);
  }
  if (!completed.manifest) {
    throw new Error('Sync worker completed without an artifact manifest');
  }
  return stage(completed.manifest);
}
