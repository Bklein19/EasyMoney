import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SpendingNode } from '../../../server/app/spendingExplorer';
import SpendingExplorer from './SpendingExplorer';
import { resolveSpendingPath, spendingArc, spendingFamilyIndex, spendingSegments } from './spendingExplorerLayout';

const root: SpendingNode = {
  id: 'spending', name: 'All spending', kind: 'root', amountCents: 10000, transactionIds: [1, 2], children: [
    { id: 'spending/category:1', name: 'Dining', kind: 'category', amountCents: 9000, transactionIds: [1], children: [
      { id: 'spending/category:1/merchant:cafe', name: 'Cafe', kind: 'merchant', amountCents: 9000, transactionIds: [1], children: [] },
    ] },
    { id: 'spending/category:uncategorized', name: 'Uncategorized', kind: 'category', amountCents: 1000, transactionIds: [2], children: [] },
  ],
};

test('explorer provides precise amounts, accessible ring controls and a complete companion list', () => {
  const html = renderToStaticMarkup(createElement(SpendingExplorer, { root, onViewTransactions: () => {} }));
  expect(html).toContain('aria-label="Spending path"');
  expect(html).toContain('aria-label="All spending breakdown"');
  expect(html).toContain('Dining: $90.00, 90%');
  expect(html).toContain('Uncategorized');
  expect(html).toContain('View transactions');
  expect(html).toContain('Gross spending before refunds');
  expect(html).toContain('using current classifications');
  expect(html).not.toContain('NaN');
});

test('segments preserve proportional angles and ancestor family colors on zoom', () => {
  const segments = spendingSegments(root);
  const dining = segments.find(segment => segment.node.name === 'Dining')!;
  expect(dining.end - dining.start).toBeCloseTo(2 * Math.PI * 0.9);
  expect(segments.find(segment => segment.node.name === 'Cafe')?.familyId).toBe(dining.node.id);
  expect(spendingSegments(dining.node, dining.node.id)[0]?.familyId).toBe(dining.node.id);
  expect(spendingFamilyIndex(dining.node.id)).toBe(spendingFamilyIndex(dining.node.id));
});

test('back paths and changed filters resolve to the nearest surviving ancestor', () => {
  const ids = ['spending/category:1', 'spending/category:1/merchant:cafe'];
  expect(resolveSpendingPath(root, ids).map(node => node.name)).toEqual(['All spending', 'Dining', 'Cafe']);
  expect(resolveSpendingPath(root, [ids[0]!, 'removed']).map(node => node.name)).toEqual(['All spending', 'Dining']);
  expect(resolveSpendingPath(root, ['removed']).map(node => node.name)).toEqual(['All spending']);
});

test('one-child and tiny annular segments remain finite and use two arcs per edge', () => {
  for (const end of [2 * Math.PI, 0.00001]) {
    const path = spendingArc(0, end, 96, 135);
    expect(path).not.toMatch(/NaN|Infinity/);
    expect(path.match(/ A /g)).toHaveLength(4);
  }
});

test('empty period explains how to recover instead of drawing misleading rings', () => {
  const html = renderToStaticMarkup(createElement(SpendingExplorer, { root: { ...root, amountCents: 0, children: [] }, onViewTransactions: () => {} }));
  expect(html).toContain('No spending in this period');
  expect(html).not.toContain('<svg');
});

test('long-tail segments stay compact until the user zooms into the group', () => {
  const group: SpendingNode = { id: 'smaller', name: '30 smaller merchants', kind: 'merchant-group', amountCents: 10000, transactionIds: [1], children: [root.children[0]!.children[0]!] };
  const overview = { ...root, children: [group] };
  expect(spendingSegments(overview).map(segment => segment.node.id)).toEqual(['smaller']);
  expect(spendingSegments(group).map(segment => segment.node.name)).toEqual(['Cafe']);
});
