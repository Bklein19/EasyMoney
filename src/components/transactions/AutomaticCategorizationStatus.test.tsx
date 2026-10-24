import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

mock.module('electrobun/view', () => ({ Electroview: class {} }));
const { default: AutomaticCategorizationStatus } = await import('./AutomaticCategorizationStatus');
const { trpc } = await import('../../api/trpc');

function renderStatus(input: { pending?: number; failed?: number; configured?: boolean } = {}) {
  const client = new QueryClient();
  client.setQueryData(trpc.transactions.automaticCategorizationStatus.queryKey(), {
    pending: 0,
    failed: 0,
    configured: true,
    applied: 2,
    needsReview: 1,
    skipped: 0,
    revision: 'fixture',
    ...input,
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AutomaticCategorizationStatus />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  client.clear();
  return html;
}

test('background categorization status does not block navigation or require per-transaction approval', () => {
  const html = renderStatus({ pending: 3 });
  expect(html).toContain('Guessing categories for 3 uncategorized transactions');
  expect(html).toContain('You can keep using the app');
  expect(html).toContain('/transactions/review');
  expect(html).not.toContain('Confirm');
});

test('failures explain import safety and offer retry; idle status stays unobtrusive', () => {
  const html = renderStatus({ failed: 1, configured: false });
  expect(html).toContain('1 transaction couldn’t be categorized');
  expect(html).toContain('Imports are saved');
  expect(html).toContain('AI is not configured');
  expect(html).toContain('Retry');
  expect(renderStatus()).toBe('');
});
