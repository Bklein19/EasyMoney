import { useDeferredValue, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { queryClient, trpc, trpcClient } from '../../api/trpc';
import { formatCurrency, formatDate } from '../../utils/formatters';
import { categoryWorkspaceView } from './workspaceNavigation';
import type { ReviewFilter } from '../../../server/app/categoryWorkspace';
import CategoriesPage from './CategoriesPage';
import TransactionReviewPage from '../transactions/TransactionReviewPage';
import ReviewedTransactions, {
  useReviewedCategories,
  CategoryChangeFeedback,
} from '../transactions/ReviewedTransactions';
import TransactionDetails from '../transactions/TransactionDetails';
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
  const [filter, setFilter] = useState<ReviewFilter>('all');
  const [status, setStatus] = useState<'open' | 'kept'>('open');
  const [offset, setOffset] = useState(0);
  const [chosenId, setChosenId] = useState<string | null>(params.get('item'));
  const [detailOffset, setDetailOffset] = useState(0);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState('');
  const queue = useQuery(
    trpc.categories.reviewQueue.queryOptions({ search: deferredSearch, filter, status, offset }),
  );
  const selectedId = chosenId ?? queue.data?.groups[0]?.id ?? '';
  const detail = useQuery(
    trpc.categories.reviewDetail.queryOptions(
      { groupId: selectedId, offset: detailOffset },
      { enabled: Boolean(selectedId) },
    ),
  );
  const group = detail.data;
  const choose = (id: string | null) => {
    setChosenId(id);
    setDetailOffset(0);
  };
  const decide = async () => {
    if (!group) return;
    setDeciding(true);
    setError('');
    try {
      await trpcClient.categories.decideReview.mutate({
        groupId: group.id,
        fingerprint: group.fingerprint,
        decision: group.kept ? 'reopen' : 'keep',
      });
      await queryClient.invalidateQueries();
      choose(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeciding(false);
    }
  };
  return (
    <>
      <div className="category-workspace__review-toolbar">
        <div>
          <p>
            {queue.data
              ? `${queue.data.openCount.toLocaleString()} groups need a look`
              : 'Finding category checks…'}{' '}
            · All active accounts and dates.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          title="AI suggestions for uncategorized activity"
          onClick={() => {
            const next = new URLSearchParams(params);
            next.set('mode', 'ai');
            setParams(next);
          }}
        >
          AI suggestions
        </button>
      </div>
      <div className="category-workspace__filters">
        <input
          className="input input--sm"
          aria-label="Search category reviews"
          placeholder="Find a merchant or account…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setOffset(0);
            choose(null);
          }}
        />
        <select
          className="input input--sm"
          aria-label="Review type"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value as ReviewFilter);
            setOffset(0);
            choose(null);
          }}
        >
          <option value="all">All checks</option>
          <option value="conflicts">Conflicting categories</option>
          <option value="uncategorized">Uncategorized</option>
          <option value="movement">Possible money movement</option>
        </select>
        <select
          className="input input--sm"
          aria-label="Review status"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as 'open' | 'kept');
            setOffset(0);
            choose(null);
          }}
        >
          <option value="open">Needs review</option>
          <option value="kept">Kept as-is ({queue.data?.keptCount ?? 0})</option>
        </select>
      </div>
      {(error || queue.error || detail.error) && (
        <p role="alert">{error || queue.error?.message || detail.error?.message}</p>
      )}
      <div className="category-workspace__layout category-workspace__layout--review">
        <aside className="category-workspace__queue" aria-label="Category review queue">
          {queue.isPending && <p role="status">Loading review queue…</p>}
          {queue.data?.groups.map((item) => (
            <button
              type="button"
              key={item.id}
              className="category-workspace__queue-item"
              aria-pressed={item.id === selectedId}
              onClick={() => choose(item.id)}
            >
              <strong>{item.name}</strong>
              <span>
                {item.accountName} · {item.transactionCount.toLocaleString()} transactions
              </span>
              <span className="category-workspace__reason">
                {item.conflict
                  ? 'Categories differ'
                  : item.movement
                    ? 'Check money movement'
                    : 'Uncategorized'}
              </span>
              <span>{formatCurrency(item.amountCents / 100)} in activity</span>
            </button>
          ))}
          {queue.data?.groups.length === 0 && (
            <p>
              {status === 'kept'
                ? 'No kept groups match.'
                : 'No outstanding checks match. This is not a guarantee that every category is correct.'}
            </p>
          )}
          {queue.data && (offset > 0 || queue.data.hasMore) && (
            <PageControls
              offset={offset}
              hasMore={queue.data.hasMore}
              onOffset={(value) => {
                setOffset(value);
                choose(null);
              }}
            />
          )}
        </aside>
        <section className="category-workspace__detail" aria-label="Selected category review">
          {selectedId && detail.isPending && <p role="status">Loading transactions…</p>}
          {!selectedId && (
            <div className="category-workspace__empty">
              <h3>A review queue, not a transaction checklist</h3>
              <p>
                Choose a group to compare its categories and surrounding activity. Nothing is
                selected or recategorized automatically.
              </p>
            </div>
          )}
          {selectedId && detail.data === null && (
            <div className="category-workspace__empty">
              <h3>No outstanding flags for this group</h3>
              <p>Your changes are saved. Undo is still available above.</p>
              <button className="btn btn--secondary" onClick={() => choose(null)}>
                Next review
              </button>
            </div>
          )}
          {group && (
            <>
              <div className="category-workspace__decision">
                <span>
                  {group.transactionCount.toLocaleString()} transactions ·{' '}
                  {formatCurrency(group.amountCents / 100)} in activity
                </span>
                <button
                  className="btn btn--secondary btn--sm"
                  disabled={deciding || changes.pending}
                  onClick={() => void decide()}
                >
                  {group.kept ? 'Reopen review' : 'Keep group as-is'}
                </button>
              </div>
              <ReviewedTransactions
                key={`${group.id}:${detailOffset}`}
                changes={changes}
                showContext
                transactions={group.transactions}
                selectVisibleOnly
                label="Categories workspace review"
                onInspect={onInspect}
                introduction={
                  <>
                    <h3>{group.name}</h3>
                    <p>
                      {group.accountName} · {formatDate(group.firstDate, 'medium')} –{' '}
                      {formatDate(group.lastDate, 'medium')}
                    </p>
                    {group.reasons.map((reason) => (
                      <p key={reason}>{reason}</p>
                    ))}
                    <p className="transaction-detail__hint">
                      Change only the entries that are wrong. Keep as-is acknowledges the entire
                      group without editing categories; new or changed activity can bring it back.
                    </p>
                  </>
                }
              />
              <PageControls
                offset={detailOffset}
                hasMore={group.hasMore}
                onOffset={setDetailOffset}
              />
            </>
          )}
        </section>
      </div>
    </>
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
          <p className="page__subtitle">
            Understand your categories. Fix the exceptions, not every transaction.
          </p>
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
          aria-current={view === 'review' ? 'page' : undefined}
          onClick={() => navigate('review')}
        >
          Review
        </button>
        <button
          aria-current={view === 'browse' ? 'page' : undefined}
          onClick={() => navigate('browse')}
        >
          Browse categories
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
        <CategoryBrowser changes={changes} onInspect={setInspectedId} />
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
