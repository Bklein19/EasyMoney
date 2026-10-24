import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TransactionListItem } from '../../../server/app/types';

mock.module('electrobun/view', () => ({ Electroview: class {} }));
const { default: WorthReviewing } = await import('./WorthReviewing');
const { default: ReviewedTransactions } = await import('../transactions/ReviewedTransactions');

test('review overview explains uncertainty, scope and impact without exposing an automatic apply action', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <WorthReviewing
        report={{
          totalGroups: 8,
          groups: [
            {
              id: 'coffee',
              name: 'Coffee shop',
              accountName: 'Checking',
              amountCents: 4001,
              reasons: ['Categories differ: Food, Shopping. This may be intentional.'],
              transactions: [],
            },
          ],
        }}
      />
    </MemoryRouter>,
  );
  expect(html).toContain('Worth reviewing');
  expect(html).toContain('Flags aren’t verdicts');
  expect(html).toContain('Categories differ');
  expect(html).toContain('$40.01');
  expect(html).toContain('Showing 1 of 8 groups');
  expect(html).not.toContain('Apply to');
});

test('review selections start empty and explicit apply is disabled; each occurrence has its own checkbox', () => {
  const client = new QueryClient();
  const transactions = ['one', 'two'].map((ledgerTransactionId) => ({
    ledgerTransactionId,
    merchant: 'Coffee',
    date: '2026-10-01',
    amount: -20,
    category: null,
  })) as TransactionListItem[];
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ReviewedTransactions transactions={transactions} label="Coffee" onInspect={() => {}} />
    </QueryClientProvider>,
  );
  expect(html).toContain('Apply to 0 selected');
  expect(html).toContain('Select all 2');
  expect(html.match(/type="checkbox"/g)).toHaveLength(2);
  expect(html).not.toContain('checked=""');
  expect(html).toMatch(/disabled=""[^>]*>Apply to 0 selected/);
  client.clear();
});
