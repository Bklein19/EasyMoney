import type { SyncReporter } from './types.ts';

export interface SyncArtifactImportResult {
  importedCount: number;
  importedBalanceCount: number;
  skippedDuplicateCount: number;
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
  let importedTransactions = 0;
  let importedBalances = 0;
  let skippedDuplicates = 0;
  let committedArtifacts = 0;

  try {
    for (const job of jobs) {
      report({ type: 'artifact', message: `Importing ${job.fileName}` });
      const result = await job.import();
      committedArtifacts += 1;
      importedTransactions += result.importedCount;
      importedBalances += result.importedBalanceCount;
      skippedDuplicates += result.skippedDuplicateCount;
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

  return { importedTransactions, importedBalances, skippedDuplicates };
}
