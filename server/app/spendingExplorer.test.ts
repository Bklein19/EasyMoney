import { expect, test } from 'bun:test';
import { buildSpendingTree, type SpendingNode } from './spendingExplorer';
import type { TransactionListItem } from './types';

const categories = [
  { id: 1, name: 'Food & Dining', parentId: null },
  { id: 2, name: 'Coffee', parentId: 1 },
  { id: 3, name: 'Other', parentId: null },
];
function expense(id: number, amount: number, categoryId: number | null, merchant = 'Cafe') {
  return {
    id,
    amount,
    merchant,
    description: merchant,
    category: categoryId == null ? null : categories.find((row) => row.id === categoryId),
  } as TransactionListItem;
}
function assertConserved(node: SpendingNode) {
  if (!node.children.length) return;
  expect(node.children.reduce((sum, child) => sum + child.amountCents, 0)).toBe(node.amountCents);
  expect(node.children.flatMap((child) => child.transactionIds).sort((a, b) => a - b)).toEqual(
    node.transactionIds,
  );
  node.children.forEach(assertConserved);
}

test('nested categories, direct parent purchases and uncategorized spending conserve cents and occurrences', () => {
  const root = buildSpendingTree(
    [
      expense(1, -12.34, 2),
      expense(2, -12.34, 2), // Both real occurrences survive.
      expense(3, -5, 1, 'Restaurant'),
      expense(4, -8, null),
      expense(5, -2, 3),
    ],
    categories,
  );
  expect(root.amountCents).toBe(3968);
  const food = root.children.find((row) => row.name === 'Food & Dining')!;
  expect(food.amountCents).toBe(2968);
  expect(food.children.find((row) => row.name === 'Coffee')?.transactionIds).toEqual([1, 2]);
  expect(food.children.find((row) => row.name === 'Restaurant')?.kind).toBe('merchant');
  expect(root.children.find((row) => row.name === 'Uncategorized')?.amountCents).toBe(800);
  expect(root.children.find((row) => row.name === 'Other')?.amountCents).toBe(200);
  assertConserved(root);
});

test('merchant grouping stays within its category and retains every transaction', () => {
  const root = buildSpendingTree(
    [expense(1, -10, 1, 'CAFE!'), expense(2, -20, 1, 'Cafe'), expense(3, -7, 2, 'Cafe')],
    categories,
  );
  const food = root.children[0]!;
  expect(food.children.find((row) => row.kind === 'merchant')?.transactionIds).toEqual([1, 2]);
  expect(food.children.find((row) => row.kind === 'category')?.transactionIds).toEqual([3]);
  assertConserved(root);
});

test('tree identities and ordering are independent of transaction and metadata order', () => {
  const expenses = [expense(3, -10, 3), expense(2, -10, 2, 'Cafe!'), expense(1, -10, 2, 'CAFE')];
  expect(buildSpendingTree(expenses, categories)).toEqual(
    buildSpendingTree([...expenses].reverse(), [...categories].reverse()),
  );
});

test('missing parents and cyclic category metadata cannot lose spending or hang', () => {
  const malformed = [
    { id: 1, name: 'A', parentId: 2 },
    { id: 2, name: 'B', parentId: 1 },
    { id: 3, name: 'Orphan', parentId: 999 },
  ];
  const root = buildSpendingTree(
    [expense(1, -10, 1), expense(2, -20, 2), expense(3, -30, 3)],
    malformed,
  );
  expect(root.amountCents).toBe(6000);
  expect(root.children).toHaveLength(3);
  assertConserved(root);
});

test('empty and zero-value spending produce a truthful empty tree', () => {
  expect(buildSpendingTree([], categories)).toMatchObject({
    amountCents: 0,
    children: [],
    transactionIds: [],
  });
  expect(buildSpendingTree([expense(1, 0, null)], categories).children).toEqual([]);
});

test('explicit Uncategorized and missing annotations share one visible branch, distinct from Other', () => {
  const metadata = [...categories, { id: 4, name: 'Uncategorized', parentId: null }];
  const assigned = {
    ...expense(1, -15, null),
    category: { id: 4, name: 'Uncategorized' },
  } as TransactionListItem;
  const root = buildSpendingTree([assigned, expense(2, -20, null), expense(3, -10, 3)], metadata);
  expect(root.children).toHaveLength(2);
  expect(root.children.find((node) => node.name === 'Uncategorized')).toMatchObject({
    amountCents: 3500,
    transactionIds: [1, 2],
  });
  expect(root.children.find((node) => node.name === 'Other')?.amountCents).toBe(1000);
  assertConserved(root);
});

test('long tails are explorable merchant groups, not hidden categories or lost money', () => {
  const expenses = Array.from({ length: 100 }, (_, index) =>
    expense(index + 1, -(index + 1), 1, `Merchant ${index + 1}`),
  );
  const root = buildSpendingTree(expenses, categories);
  const food = root.children[0]!;
  const group = food.children.find((node) => node.kind === 'merchant-group')!;
  expect(food.children).toHaveLength(13);
  expect(group.children).toHaveLength(88);
  expect(group.name).toBe('88 smaller merchants');
  expect(group.children.every((node) => node.kind === 'merchant')).toBe(true);
  expect(group.transactionIds).toHaveLength(88);
  expect(root.amountCents).toBe(505000);
  expect(buildSpendingTree([...expenses].reverse(), categories)).toEqual(root);
  assertConserved(root);
});
