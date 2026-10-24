import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { queryClient, trpc } from '../../api/trpc';

export default function AutomaticCategorizationStatus() {
  const status = useQuery({
    ...trpc.transactions.automaticCategorizationStatus.queryOptions(),
    refetchInterval: 3000,
  });
  const retry = useMutation(
    trpc.transactions.retryAutomaticCategorization.mutationOptions({
      onSuccess: () => {
        void status.refetch();
      },
    }),
  );
  const previous = useRef<{ applied: number; pending: number } | null>(null);
  const [completed, setCompleted] = useState(false);
  useEffect(() => {
    const next = status.data;
    if (!next) return;
    const last = previous.current;
    if (last && next.pending === 0 && (last.pending > 0 || last.applied !== next.applied)) {
      void queryClient.invalidateQueries();
      setCompleted(next.applied > last.applied || last.pending > 0);
    }
    previous.current = next;
  }, [status.data]);
  const data = status.data;
  if (!data || (!data.pending && !data.failed && !completed)) return null;
  return (
    <div className="automatic-categorization-status" role="status">
      <span>
        {data.pending > 0
          ? `Guessing categories for ${data.pending.toLocaleString()} uncategorized transaction${data.pending === 1 ? '' : 's'}… You can keep using the app.`
          : data.failed > 0
            ? `${data.failed.toLocaleString()} transaction${data.failed === 1 ? '' : 's'} couldn’t be categorized automatically. Imports are saved.${data.configured ? '' : ' AI is not configured.'}`
            : 'Categories updated automatically. You can change any guess; ambiguous payments remain for review.'}
      </span>
      <Link to="/transactions/review">Review categories</Link>
      {data.failed > 0 && (
        <button
          className="btn btn-secondary btn--sm"
          disabled={retry.isPending}
          onClick={() => retry.mutate()}
        >
          Retry
        </button>
      )}
      {retry.error && <span role="alert">{retry.error.message}</span>}
      {!data.pending && !data.failed && (
        <button
          className="btn btn--ghost btn--sm"
          aria-label="Dismiss categorization status"
          onClick={() => setCompleted(false)}
        >
          ×
        </button>
      )}
    </div>
  );
}
