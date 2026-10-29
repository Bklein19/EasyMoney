import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TransactionListItem } from '../../../server/app/types';

mock.module('electrobun/view', () => ({ Electroview: class {} }));
const { TransactionContextRows } = await import('./TransactionContext');
const { default: ReviewedTransactions } = await import('./ReviewedTransactions');

const row = (id: string, changes: Partial<TransactionListItem> = {}): TransactionListItem => ({
  id: 42,
  ledgerTransactionId: id,
  account: { id: 1, name: 'Fidelity', institution: 'Fidelity', type: 'investment' },
  category: null,
  date: '2024-10-02',
  amount: 5145.6,
  merchant: 'RSU vest',
  description: 'Full RSU source description',
  originalDescription: null,
  originalCategory: null,
  type: 'income',
  transactionKind: 'activity',
  sourceRole: null,
  status: 'cleared',
  notes: null,
  importBatchId: null,
  fingerprint: null,
  createdAt: null,
  ...changes,
});

test('surrounding rows distinguish focus from review membership and cannot become category selections', () => {
  const rows = [
    row('vest-1'),
    row('vest-2'),
    row('tax', { merchant: 'RSU tax withholding', description: 'Taxes journaled', amount: -2000 }),
  ];
  const html = renderToStaticMarkup(
    <TransactionContextRows
      transactions={rows}
      anchorId="vest-1"
      reviewIds={['vest-1', 'vest-2']}
    />,
  );
  expect(html).toContain('Surrounding account transactions');
  expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  expect(html).toContain('Under review');
  expect(html).toContain('RSU tax withholding');
  expect(html).toContain('Taxes journaled');
  expect(html).toContain('Full RSU source description');
  expect(html.match(/\+\$5,145.60/g)).toHaveLength(2);
  expect(html).toContain('-$2,000.00');
  expect(html).toContain('Uncategorized');
  expect(html).not.toContain('checkbox');
  expect(html).not.toContain('<select');
});

test('category review offers nearby context by default without preselecting any occurrence', () => {
  const client = new QueryClient();
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ReviewedTransactions
          showContext
          transactions={[row('vest-1'), row('vest-2')]}
          label="RSUs"
          onInspect={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).not.toContain('checked=""');
    expect(html).toContain('Apply to 0 selected');
    expect(html.match(/Nearby activity/g)).toHaveLength(2);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain('Surrounding activity');
    expect(html).toContain('Context only—not included in Apply.');
    expect(html).toContain('Loading surrounding transactions');
  } finally {
    client.clear();
  }
});
