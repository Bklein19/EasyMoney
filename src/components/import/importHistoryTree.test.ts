import { expect, test } from 'bun:test';
import {
  filterImportHistory,
  groupImportHistory,
  type ImportHistoryItem,
} from './importHistoryTree.ts';

function historyItem(
  id: number,
  overrides: Partial<ImportHistoryItem> = {},
): ImportHistoryItem {
  return {
    id,
    fileName: `import-${id}.csv`,
    parserName: 'test-parser',
    institution: 'Example Bank',
    status: 'committed',
    rowCount: 1,
    sourceType: 'activity-export',
    sourceKind: 'activity',
    importBatchId: null,
    createdAt: '2026-08-20T10:00:00.000Z',
    committedAt: '2026-08-20T10:01:00.000Z',
    transactionCount: 4,
    balanceCount: 1,
    unresolvedSourceAccountCount: 0,
    accounts: [{ id: 10, name: 'Checking', accountHolder: 'Example Owner' }],
    ...overrides,
  };
}

test('groups imports by account holder, account, and source kind with useful totals', () => {
  const groups = groupImportHistory([
    historyItem(1),
    historyItem(2, {
      sourceType: 'statement',
      sourceKind: 'statements',
      transactionCount: 2,
      balanceCount: 3,
      status: 'unimported',
    }),
  ]);

  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({
    label: 'Example Owner',
    summary: {
      fileCount: 2,
      transactionCount: 6,
      balanceCount: 4,
      importedCount: 1,
      unimportedCount: 1,
    },
    accounts: [{
      label: 'Checking',
      sources: [
        { label: 'Statements', imports: [{ id: 2 }] },
        { label: 'Activity', imports: [{ id: 1 }] },
      ],
    }],
  });
});

test('places consolidated files in one multiple-accounts branch without duplicating actions', () => {
  const consolidated = historyItem(3, {
    accounts: [
      { id: 10, name: 'Checking', accountHolder: 'Example Owner' },
      { id: 11, name: 'Savings', accountHolder: 'Example Owner' },
    ],
  });
  const crossHolder = historyItem(4, {
    accounts: [
      { id: 10, name: 'Checking', accountHolder: 'Example Owner' },
      { id: 12, name: 'Joint Card', accountHolder: 'Another Owner' },
    ],
  });

  const groups = groupImportHistory([consolidated, crossHolder]);
  expect(groups.map(group => group.label)).toEqual(['Example Owner', 'Multiple account holders']);
  expect(groups[0]?.accounts[0]?.label).toBe('Multiple accounts');
  expect(groups[1]?.accounts[0]?.label).toBe('Multiple accounts');
  expect(groups.flatMap(group => group.accounts)
    .flatMap(account => account.sources)
    .flatMap(source => source.imports)
    .map(item => item.id)
    .sort()).toEqual([3, 4]);
});

test('labels missing metadata explicitly and includes account metadata in search', () => {
  const unknown = historyItem(5, { accounts: [], sourceKind: 'other', sourceType: null });
  const known = historyItem(6, {
    fileName: 'opaque.csv',
    accounts: [{ id: 20, name: 'Brokerage', accountHolder: 'Known Owner' }],
  });

  const groups = groupImportHistory([unknown]);
  expect(groups[0]).toMatchObject({
    label: 'Unknown account holder',
    accounts: [{
      label: 'Unknown account',
      sources: [{ label: 'Other files', imports: [{ id: 5 }] }],
    }],
  });
  expect(filterImportHistory([unknown, known], 'known owner').map(item => item.id)).toEqual([6]);
  expect(filterImportHistory([unknown, known], 'brokerage').map(item => item.id)).toEqual([6]);
});
