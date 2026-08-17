import type { SyncReporter } from './types.ts';

export interface SyncArtifactImportResult {
  importedCount: number;
  importedBalanceCount: number;
  skippedDuplicateCount: number;
  skippedArtifact?: boolean;
}

export interface SyncArtifactJob {
  fileName: string;
  accountId: number;
  import: () => Promise<SyncArtifactImportResult>;
}

export async function importSyncArtifactBatch(
  jobs: SyncArtifactJob[],
  report: SyncReporter,
  rebuildLedger: () => unknown | Promise<unknown>,
) {
  let recordedTransactionFacts = 0;
  let recordedBalanceFacts = 0;
  let skippedTransactionDuplicates = 0;
  let skippedArtifacts = 0;
  let committedArtifacts = 0;

  try {
    for (const job of jobs) {
      report({ type: 'artifact', message: `Importing ${job.fileName}` });
      const result = await job.import();
      if (result.skippedArtifact) {
        skippedArtifacts += 1;
        report({ type: 'import', message: `Skipped ${job.fileName}; artifact was already imported` });
        continue;
      }
      committedArtifacts += 1;
      recordedTransactionFacts += result.importedCount;
      recordedBalanceFacts += result.importedBalanceCount;
      skippedTransactionDuplicates += result.skippedDuplicateCount;
      report({
        type: 'import',
        message: `Imported ${job.fileName}`,
        data: {
          accountId: job.accountId,
          transactions: result.importedCount,
          balances: result.importedBalanceCount,
          duplicates: result.skippedDuplicateCount,
        },
      });
    }
  } finally {
    if (committedArtifacts > 0) {
      report({ type: 'phase', message: 'Rebuilding ledger from imported source facts' });
      await rebuildLedger();
    }
  }

  return { recordedTransactionFacts, recordedBalanceFacts, skippedTransactionDuplicates, skippedArtifacts };
}
