import { useDeferredValue, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { trpc, trpcClient, queryClient } from '../../api/trpc';
import { formatCurrency } from '../../utils/formatters';
import { categoryWorkspaceView } from './workspaceNavigation';
import CategoriesPage from './CategoriesPage';
import TransactionReviewPage from '../transactions/TransactionReviewPage';
import ReviewedTransactions, {
  useReviewedCategories,
  CategoryChangeFeedback,
} from '../transactions/ReviewedTransactions';
import TransactionDetails from '../transactions/TransactionDetails';
import MerchantReviewRow from './MerchantReviewRow';
import SpendingExplorer from '../analytics/SpendingExplorer';
import SpendingTransactions from '../analytics/SpendingTransactions';
import './CategoriesWorkspace.css';

type Changes = ReturnType<typeof useReviewedCategories>;

function PageControls({
  offset,
  hasMore,
  onOffset,
}: {
  offset: number;
  hasMore?: boolean;
  onOffset: (offset: number) => void;
}) {
  return (
    <div className="category-workspace__pagination">
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        disabled={offset === 0}
        onClick={() => onOffset(Math.max(0, offset - 50))}
      >
        Previous
      </button>
      <span>Page {Math.floor(offset / 50) + 1}</span>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        disabled={!hasMore}
        onClick={() => onOffset(offset + 50)}
      >
        Next
      </button>
    </div>
  );
}

function ReviewWorkspace({
  changes,
  onInspect,
}: {
  changes: Changes;
  onInspect: (id: string) => void;
}) {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [status, setStatus] = useState<'open' | 'kept'>('open');
  const [offset, setOffset] = useState(0);
  const queue = useQuery(
    trpc.categories.merchantQueue.queryOptions(
      { search: deferredSearch, status, offset },
      {
        refetchInterval: (query) =>
          query.state.data?.groups.some((group) =>
            ['queued', 'running'].includes(group.recommendation?.status),
          )
            ? 2000
            : false,
      },
    ),
  );
  const recommendations = useMutation({
    mutationFn: (groupIds: string[]) =>
      trpcClient.categories.recommendMerchants.mutate({ groupIds }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: trpc.categories.merchantQueue.queryKey() }),
  });
  const recommendationIds = JSON.stringify(
    queue.data?.groups
      .filter((group) => group.recommendation?.status === 'idle')
      .map((group) => group.id) ?? [],
  );
  const { mutate: recommend } = recommendations;
  useEffect(() => {
    const ids: string[] = JSON.parse(recommendationIds);
    if (ids.length) recommend(ids);
  }, [recommendationIds, recommend]);
  const categories = useQuery(trpc.categories.list.queryOptions());
  return (
    <>
      <div className="category-workspace__review-toolbar">
        <strong>
          {queue.data?.totalCount ?? '…'} merchants {status === 'kept' ? 'reviewed' : 'to review'}
        </strong>
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => {
            const next = new URLSearchParams(params);
            next.set('mode', 'ai');
            setParams(next);
          }}
        >
          AI suggestions
        </button>
      </div>
      <div className="merchant-review-filters">
        <input
          className="input input--sm"
          aria-label="Find a merchant or account"
          placeholder="Find a merchant or account…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setOffset(0);
          }}
        />
        <select
          className="input input--sm"
          aria-label="Review status"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as 'open' | 'kept');
            setOffset(0);
          }}
        >
          <option value="open">Needs review</option>
          <option value="kept">Intentional / reviewed</option>
        </select>
      </div>
      {(queue.error || categories.error) && (
        <p role="alert">{queue.error?.message || categories.error?.message}</p>
      )}
      {recommendations.error && (
        <p role="alert">
          Could not request recommendations.{' '}
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => recommend(JSON.parse(recommendationIds))}
          >
            Retry
          </button>
        </p>
      )}
      {queue.isPending && <p role="status">Loading merchant reviews…</p>}
      <section className="merchant-review-list" aria-label="Merchant category reviews">
        {queue.data?.groups.map((group) => (
          <MerchantReviewRow
            key={`${group.id}:${group.kept}`}
            group={group}
            categories={(categories.data?.categories ?? []).filter(
              (category) => category.name.toLowerCase() !== 'uncategorized',
            )}
            changes={changes}
            onInspect={onInspect}
          />
        ))}
        {queue.data?.totalCount === 0 && (
          <p className="category-workspace__empty">No matching category reviews.</p>
        )}
      </section>
      {queue.data && (offset > 0 || queue.data.hasMore) && (
        <div className="category-workspace__pagination">
          <button
            className="btn btn--ghost btn--sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 25))}
          >
            Previous
          </button>
          <span>Page {Math.floor(offset / 25) + 1}</span>
          <button
            className="btn btn--ghost btn--sm"
            disabled={!queue.data.hasMore}
            onClick={() => setOffset(offset + 25)}
          >
            Next
          </button>
        </div>
      )}
    </>
  );
}

function CategoryExplorer({
  changes,
  onInspect,
}: {
  changes: Changes;
  onInspect: (id: string) => void;
}) {
  const query = useQuery(trpc.analytics.spendingExplorer.queryOptions({}));
  return (
    <section className="category-workspace__explorer" aria-label="Explore categories">
      <p className="category-workspace__hint">
        Spending across all active accounts and dates. Drill into a category or merchant to correct
        its transactions.
      </p>
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.isPending ? (
        <p role="status">Loading categories…</p>
      ) : (
        <SpendingExplorer
          root={query.data}
          saving={changes.pending}
          renderTransactions={(node) => (
            <SpendingTransactions
              key={node.id}
              nodeId={node.id}
              scope={{}}
              changes={changes}
              onInspect={onInspect}
            />
          )}
        />
      )}
    </section>
  );
}

function CategoryBrowser({
  changes,
  onInspect,
}: {
  changes: Changes;
  onInspect: (id: string) => void;
}) {
  const [params] = useSearchParams();
  const [chosenCategoryId, setChosenCategoryId] = useState<number | null | undefined>();
  const [search, setSearch] = useState('');
  const [transactionSearch, setTransactionSearch] = useState('');
  const deferredSearch = useDeferredValue(transactionSearch);
  const [offset, setOffset] = useState(0);
  const browse = useQuery(trpc.categories.browse.queryOptions());
  const categories = browse.data?.categories ?? [];
  const groupFilter = params.get('group');
  const visible = categories.filter(
    (category) =>
      (!groupFilter || category.categoryGroup === groupFilter) &&
      (!search || category.path.toLowerCase().includes(search.toLowerCase())),
  );
  const selected = visible.find((category) => category.id === chosenCategoryId) ?? visible[0];
  const selectedId = selected?.id ?? null;
  const transactions = useQuery(
    trpc.categories.browseTransactions.queryOptions(
      {
        categoryId: selectedId,
        search: deferredSearch,
        offset,
      },
      { enabled: Boolean(selected) },
    ),
  );
  return (
    <>
      <div className="category-workspace__review-toolbar">
        <div>
          <h2>Browse categories</h2>
          <p>
            All active accounts and dates. Parent categories include their children. Amounts show
            absolute activity—not spending or net income.
          </p>
        </div>
      </div>
      <div className="category-workspace__layout">
        <aside className="category-workspace__queue" aria-label="Category hierarchy">
          <input
            className="input input--sm"
            aria-label="Find a category"
            placeholder="Find a category…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {browse.isPending && <p role="status">Loading categories…</p>}
          {visible.map((category) => (
            <button
              type="button"
              key={category.id ?? 'uncategorized'}
              className="category-workspace__queue-item"
              aria-pressed={category.id === selectedId}
              style={{ paddingLeft: 12 + category.depth * 14 }}
              onClick={() => {
                setChosenCategoryId(category.id);
                setOffset(0);
                setTransactionSearch('');
              }}
            >
              <strong>{category.name}</strong>
              <span>
                {category.transactionCount.toLocaleString()} transactions ·{' '}
                {category.merchantCount.toLocaleString()} merchants
              </span>
              <span>{formatCurrency(category.activityCents / 100)} in activity</span>
            </button>
          ))}
          {!browse.isPending && !visible.length && <p>No matching categories.</p>}
        </aside>
        <section className="category-workspace__detail" aria-label="Category transactions">
          <h3>{selected?.path ?? 'Uncategorized'}</h3>
          <p className="category-workspace__hint">
            {selected?.transactionCount.toLocaleString() ?? 0} transactions ·{' '}
            {formatCurrency((selected?.activityCents ?? 0) / 100)} in activity
          </p>
          <input
            className="input input--sm"
            aria-label="Search category transactions"
            placeholder="Find a merchant, description, amount, or note…"
            value={transactionSearch}
            onChange={(event) => {
              setTransactionSearch(event.target.value);
              setOffset(0);
            }}
          />
          {(browse.error || transactions.error) && (
            <p role="alert">{browse.error?.message || transactions.error?.message}</p>
          )}
          {!selected ? (
            <p>Choose a category to see its transactions.</p>
          ) : transactions.isPending ? (
            <p role="status">Loading transactions…</p>
          ) : (
            <ReviewedTransactions
              key={`${selectedId}:${offset}:${deferredSearch}`}
              transactions={transactions.data?.transactions ?? []}
              selectVisibleOnly
              label="Browse category corrections"
              onInspect={onInspect}
              changes={changes}
              showContext
            />
          )}
          {!transactions.isPending && !transactions.data?.totalCount && (
            <p>No transactions match this category and search.</p>
          )}
          <PageControls offset={offset} hasMore={transactions.data?.hasMore} onOffset={setOffset} />
        </section>
      </div>
    </>
  );
}

export default function CategoriesWorkspace() {
  const [params, setParams] = useSearchParams();
  const view = categoryWorkspaceView(params);
  const changes = useReviewedCategories();
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const ai = view === 'review' && params.get('mode') === 'ai';
  const navigate = (next: string) => {
    const query = new URLSearchParams(params);
    query.set('view', next);
    query.delete('mode');
    query.delete('item');
    setParams(query);
  };
  return (
    <div className="page category-workspace">
      <header className="page__header">
        <div>
          <h1 className="page__title">Categories</h1>
        </div>
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => navigate(view === 'manage' ? 'review' : 'manage')}
        >
          {view === 'manage' ? 'Back to review' : 'Manage categories'}
        </button>
      </header>
      <nav className="category-workspace__tabs" aria-label="Categories views">
        <button
          aria-current={view === 'browse' ? 'page' : undefined}
          onClick={() => navigate('browse')}
        >
          Explore categories
        </button>
        <button
          aria-current={view === 'review' ? 'page' : undefined}
          onClick={() => navigate('review')}
        >
          Review
        </button>
      </nav>
      <CategoryChangeFeedback state={changes} />
      {view === 'manage' ? (
        <CategoriesPage embedded />
      ) : ai ? (
        <>
          <Link className="category-workspace__back" to="/categories">
            ← Back to review queue
          </Link>
          <TransactionReviewPage embedded />
        </>
      ) : view === 'browse' ? (
        params.has('group') ? (
          <CategoryBrowser changes={changes} onInspect={setInspectedId} />
        ) : (
          <CategoryExplorer changes={changes} onInspect={setInspectedId} />
        )
      ) : (
        <ReviewWorkspace changes={changes} onInspect={setInspectedId} />
      )}
      {inspectedId && (
        <TransactionDetails
          ledgerTransactionId={inspectedId}
          onClose={() => setInspectedId(null)}
        />
      )}
    </div>
  );
}
