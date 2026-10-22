import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SpendingTransactionRows from './SpendingTransactionRows';
import type { CategorySummary, TransactionListItem } from '../../../server/app/types';

const category: CategorySummary = { id: 3, name: 'Housing', parentId: null, type: 'expense', categoryGroup: null, description: null, color: null, icon: null };
const row: TransactionListItem = { id: 1, ledgerTransactionId: 'stable-rent', account: { id: 1, name: 'Checking', institution: 'BofA', type: 'checking' },
  category: null, date: '2024-01-03', amount: -1800, description: 'Check 254', merchant: 'Check 254', originalDescription: 'Check 254',
  originalCategory: null, type: 'debit', transactionKind: null, sourceRole: null, status: 'cleared', notes: 'Keep', importBatchId: null, fingerprint: null, createdAt: null };
const props = { rows: [row], categories: [category], selected: new Map<string, TransactionListItem>(), pending: false,
  onToggle: () => {}, onCategorize: () => {}, onInspect: () => {} };

test('explorer rows expose category editing and selection without opening transaction details', () => {
  const html = renderToStaticMarkup(createElement(SpendingTransactionRows, props));
  expect(html).toContain('aria-label="Category for Check 254 on 2024-01-03"');
  expect(html).toContain('aria-label="Select Check 254 on 2024-01-03"');
  expect(html).toContain('Housing');
  expect(html).toContain('Uncategorized');
  expect(html).toContain('BofA · Checking');
  expect(html).toContain('-$1,800.00');
  expect(html).not.toContain('role="dialog"');
});

test('explicit Uncategorized and missing categories display alike while saved choices and selections remain visible', () => {
  const assigned = { ...row, category };
  const selected = new Map([[row.ledgerTransactionId!, assigned]]);
  const html = renderToStaticMarkup(createElement(SpendingTransactionRows, { ...props, rows: [assigned], selected, pending: true }));
  expect(html).toContain('checked=""');
  expect(html).toContain('<option value="3" selected="">Housing</option>');
  expect(html.match(/disabled=""/g)?.length).toBe(3);
  const unknown = renderToStaticMarkup(createElement(SpendingTransactionRows, { ...props, rows: [{ ...row, category: { ...category, name: 'Uncategorized', id: 19 } }] }));
  expect(unknown).toContain('<option value="" selected="">Uncategorized</option>');
});
