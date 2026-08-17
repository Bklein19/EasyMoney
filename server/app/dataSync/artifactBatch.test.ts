import { describe, expect, test } from 'bun:test';

import { importSyncArtifactBatch, type SyncArtifactJob } from './artifactBatch.ts';
import type { SyncEvent } from './types.ts';

function job(fileName: string, importedCount: number): SyncArtifactJob {
  return {
    fileName,
    accountId: 1,
    import: async () => ({ importedCount, importedBalanceCount: 1, skippedDuplicateCount: 2 }),
  };
}

describe('sync artifact batch', () => {
  test('imports every artifact before rebuilding the ledger once', async () => {
    const events: Array<Omit<SyncEvent, 'runId' | 'timestamp'>> = [];
    let rebuilds = 0;

    const result = await importSyncArtifactBatch(
      [job('one.csv', 3), job('two.pdf', 4)],
      event => events.push(event),
      () => { rebuilds += 1; },
    );

    expect(result).toEqual({ importedTransactions: 7, importedBalances: 2, skippedDuplicates: 4 });
    expect(rebuilds).toBe(1);
    expect(events.map(event => event.message)).toEqual([
      'Importing one.csv',
      'Imported one.csv',
      'Importing two.pdf',
      'Imported two.pdf',
      'Rebuilding ledger from imported source facts',
    ]);
  });

  test('rebuilds committed source facts before propagating a later import failure', async () => {
    let rebuilds = 0;
    const jobs = [
      job('committed.csv', 3),
      {
        ...job('broken.pdf', 0),
        import: async () => { throw new Error('parser failed'); },
      },
    ];

    await expect(importSyncArtifactBatch(jobs, () => {}, () => { rebuilds += 1; }))
      .rejects.toThrow('parser failed');
    expect(rebuilds).toBe(1);
  });
});
