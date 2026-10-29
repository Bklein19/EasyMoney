import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { categoryWorkspaceView } from './workspaceNavigation';

mock.module('electrobun/view', () => ({ Electroview: class {} }));
const { default: CategoriesWorkspace } = await import('./CategoriesWorkspace');
const { trpc } = await import('../../api/trpc');
const { default: ReviewedTransactions } = await import('../transactions/ReviewedTransactions');
import type { TransactionListItem } from '../../../server/app/types';

function render(url: string, prepare?: (client: QueryClient) => void) {
  const client = new QueryClient();
  try {
    prepare?.(client);
    return renderToStaticMarkup(
      <MemoryRouter initialEntries={[url]}>
        <QueryClientProvider client={client}>
          <CategoriesWorkspace />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  } finally {
    client.clear();
  }
}

test('category workspace defaults to review while legacy group links browse and definitions remain secondary', () => {
  for (const [query, view] of [
    ['', 'review'],
    ['view=bad', 'review'],
    ['group=income', 'browse'],
    ['view=review&group=income', 'review'],
    ['view=manage', 'manage'],
    ['view=browse', 'browse'],
  ] as const) {
    expect(categoryWorkspaceView(new URLSearchParams(query))).toBe(view);
  }
  const html = render('/categories');
  expect(html).toContain('Categories views');
  expect(html).toContain('Category review queue');
  expect(html).toContain('Selected category review');
  expect(html).toContain('Manage categories');
  expect(html).not.toContain('Starting review');
  expect(html).not.toContain('OPENAI_API_KEY');
  expect(html).not.toContain('New category');
});

test('workspace AI review is explicit and does not suggest it reviewed already-categorized entries', () => {
  const html = render('/categories?view=review&mode=ai');
  expect(html).toContain('Get suggestions');
  expect(html).toContain('AI suggestions for uncategorized activity');
  expect(html).toContain(
    'Already-categorized entries and your manual choices are not automatically overwritten',
  );
  expect(html).toContain('Back to review queue');
  expect(html).not.toContain('Reviewing...');
});

test('browse respects a category-group deep link rather than opening unrelated uncategorized transactions', () => {
  const html = render('/categories?view=browse&group=income', (client) => {
    client.setQueryData(trpc.categories.browse.queryKey(), {
      categories: [
        {
          id: null,
          parentId: null,
          type: null,
          description: null,
          color: null,
          icon: null,
          name: 'Uncategorized',
          path: 'Uncategorized',
          categoryGroup: null,
          depth: 0,
          transactionCount: 3,
          merchantCount: 1,
          activityCents: 1000,
        },
        {
          id: 2,
          parentId: 1,
          type: 'income',
          description: null,
          color: null,
          icon: null,
          name: 'Gifts received',
          path: 'Income / Gifts received',
          categoryGroup: 'income',
          depth: 1,
          transactionCount: 21,
          merchantCount: 2,
          activityCents: 3507500,
        },
      ],
    });
  });
  expect(html).toContain('Income / Gifts received');
  expect(html).toContain('21 transactions');
  expect(html).toContain('$35,075.00');
  expect(html).not.toContain('Uncategorized');
});

test('manage definitions keeps the existing category editor outside the main review flow', () => {
  const html = render('/categories?view=manage');
  expect(html).toContain('Category definitions');
  expect(html).toContain('New category');
  expect(html).not.toContain('Category review queue');
});

test('workspace select-shown action counts rendered occurrences, not the rest of a loaded page', () => {
  const client = new QueryClient();
  try {
    const transactions = Array.from({ length: 12 }, (_, index) => ({
      ledgerTransactionId: `shown-${index}`,
      merchant: 'Coffee',
      date: '2026-10-01',
      amount: -5,
      category: null,
    })) as TransactionListItem[];
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ReviewedTransactions
          selectVisibleOnly
          transactions={transactions}
          label="Visible rows"
          onInspect={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain('Select shown 10');
    expect(html.match(/type="checkbox"/g)).toHaveLength(10);
    expect(html).not.toContain('Select all 12');
  } finally {
    client.clear();
  }
});
