import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { categoryWorkspaceView } from './workspaceNavigation';

mock.module('electrobun/view', () => ({ Electroview: class {} }));
const { default: CategoriesWorkspace } = await import('./CategoriesWorkspace');
const { trpc } = await import('../../api/trpc');
const { default: ReviewedTransactions } = await import('../transactions/ReviewedTransactions');
const { CategoryChangeFeedback } = await import('../transactions/ReviewedTransactions');
import type { TransactionListItem } from '../../../server/app/types';

test('category feedback offers Undo without claiming a full backup was created', () => {
  const html = renderToStaticMarkup(
    <CategoryChangeFeedback
      state={{
        pending: false,
        error: '',
        undo: { id: 1, count: 2 },
        apply: async () => true,
        restore: async () => {},
        remember: () => {},
      }}
    />,
  );
  expect(html).toContain('Updated 2 transactions.');
  expect(html).toContain('Undo');
  expect(html).not.toContain('Backup saved');
});

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
  const tabs = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
  expect(tabs.indexOf('Explore categories')).toBeLessThan(tabs.indexOf('>Review</button>'));
  expect(html).toContain('Merchant category reviews');
  expect(html).not.toContain('One check at a time');
  expect(html).not.toContain('Category review queue');
  expect(html).not.toContain('Search category reviews');
  expect(html).toContain('Manage categories');
  expect(html).not.toContain('Starting review');
  expect(html).not.toContain('OPENAI_API_KEY');
  expect(html).not.toContain('New category');
});

test('merchant review offers one split recommendation button and keeps all-history actions behind disclosure', () => {
  const group = {
    id: 'merchant',
    name: 'OpenAI',
    accountName: 'Card',
    categories: ['Software', 'Education'],
    fingerprint: 'all',
    primaryFingerprint: 'unknown',
    kept: false,
    transactionCount: 14,
    singleTransaction: null,
    currentCount: 1,
    reviewCount: 1,
    currentAmountCents: 2000,
    uncategorizedCount: 1,
    conflict: true,
    movement: false,
    suggestion: { categoryId: 1, reason: 'Software subscription', source: 'ai' as const },
    recommendation: { status: 'ready' as const, reason: 'Software subscription' },
    reviewedCount: 0,
    historyTargets: [{ categoryId: 1, count: 3, matchingCount: 10 }],
  };
  const html = render('/categories', (client) => {
    client.setQueryData(trpc.categories.list.queryKey(), {
      categories: [
        {
          id: 1,
          name: 'Software',
          type: 'expense',
          color: null,
          icon: null,
          description: null,
          parentId: null,
          categoryGroup: null,
        },
      ],
    });
    client.setQueryData(
      trpc.categories.merchantQueue.queryKey({ search: '', status: 'open', offset: 0 }),
      {
        groups: [group],
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
      },
    );
  });
  expect(html).toContain('Merchant category reviews');
  expect(html).toContain('Choose category for OpenAI');
  expect(html).toContain('Categorize as Software');
  expect(html).toContain('AI suggestion');
  expect(html).toContain('Categorize 1 review transactions as Software');
  expect(html).not.toContain('Categorize all 14');
  expect(html.match(/aria-label="Choose category for /g)).toHaveLength(1);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('3 earlier transactions differ');
  expect(html).not.toContain('type="checkbox"');
  expect(html).not.toContain('Apply to');
  expect(html).not.toContain('Surrounding account transactions');
  expect(html).not.toContain('One check at a time');
});

test('categorized conflicts defer transaction details and intentional decisions until expanded', () => {
  const html = render('/categories', (client) => {
    client.setQueryData(
      trpc.categories.merchantQueue.queryKey({ search: '', status: 'open', offset: 0 }),
      {
        groups: [
          {
            id: 'vest',
            name: 'RSU vest',
            accountName: 'Fidelity',
            categories: ['Income', 'Investment'],
            fingerprint: 'all',
            primaryFingerprint: 'known',
            kept: false,
            transactionCount: 2,
            singleTransaction: null,
            currentCount: 0,
            reviewCount: 2,
            currentAmountCents: 0,
            uncategorizedCount: 0,
            conflict: true,
            movement: false,
            suggestion: null,
            recommendation: { status: 'review', reason: 'Needs personal context' },
            reviewedCount: 0,
            historyTargets: [],
          },
        ],
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
      },
    );
  });
  expect(html).not.toContain('These differences are intentional');
  expect(html).not.toContain('Review 2');
  expect(html).toContain('merchant-categorize__placeholder">Choose category</span>');
  expect(html).not.toContain('Categorize as…');
  expect(html).not.toContain('Categorize as undefined');
  expect(html).not.toContain('Categorize all 2');
  expect(html).toContain('Needs your context');
  expect(html).not.toContain('>AI suggestion</small>');
  expect(html).not.toContain('earlier transactions differ');
  expect(html).not.toContain('Save 0');
  expect(html).not.toContain('type="checkbox"');
});

test('single-transaction review has one editor, date and nearby activity without duplicated review details', () => {
  const html = render('/categories', (client) => {
    client.setQueryData(
      trpc.categories.merchantQueue.queryKey({ search: '', status: 'open', offset: 0 }),
      {
        groups: [
          {
            id: 'single',
            name: 'Transfer to savings',
            accountName: 'Savings',
            categories: ['Education'],
            fingerprint: 'all',
            primaryFingerprint: 'one',
            kept: false,
            transactionCount: 1,
            currentCount: 1,
            reviewCount: 1,
            currentAmountCents: 1060600,
            uncategorizedCount: 0,
            conflict: false,
            movement: true,
            suggestion: null,
            recommendation: { status: 'unavailable', reason: null },
            reviewedCount: 0,
            historyTargets: [],
            singleTransaction: { id: 'one', date: '2020-05-26', amount: -10606 },
          },
        ],
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
      },
    );
  });
  expect(html.match(/aria-label="Choose category for /g)).toHaveLength(1);
  expect(html).toContain('May 26, 2020');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('Keep current category');
  expect(html).not.toContain('These differences are intentional');
  expect(html).not.toContain('Review 1');
  expect(html).not.toContain('Transactions in this review');
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
