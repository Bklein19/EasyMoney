import { expect, test } from 'bun:test';
import { categoryPath, categoryPathLabel, compareCategoryPaths } from './categoryHierarchy';

const categories = [
  { id: 1, name: 'Income', parentId: null },
  { id: 2, name: 'Payroll', parentId: 1 },
  { id: 3, name: 'Gifts Received', parentId: 1 },
  { id: 4, name: 'Housing', parentId: null },
  { id: 5, name: 'Rent', parentId: 4 },
];

test('category paths and sorting keep children together beneath their parent', () => {
  expect(categoryPathLabel(categories[1]!, categories)).toBe('Income › Payroll');
  expect([...categories].sort((a, b) => compareCategoryPaths(a, b, categories)).map(row => row.name))
    .toEqual(['Housing', 'Rent', 'Income', 'Gifts Received', 'Payroll']);
  expect(categoryPath(categories[1]!, categories).map(row => row.id)).toEqual([1, 2]);
});

test('paths tolerate missing parents, cycles, and string IDs in older metadata', () => {
  expect(categoryPathLabel({ id: 6, name: 'Orphan', parentId: 90 }, categories)).toBe('Orphan');
  expect(categoryPathLabel({ id: '2', name: 'Payroll', parentId: '1' }, categories)).toBe('Income › Payroll');
  const cycle = [{ id: 1, name: 'A', parentId: 2 }, { id: 2, name: 'B', parentId: 1 }];
  expect(categoryPath(cycle[0]!, cycle)).toHaveLength(2);
});
