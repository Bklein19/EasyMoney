import { useEffect, useRef, useState } from 'react';
import { trpcClient } from '../api/trpc';
import type { BudgetPlans } from '../../server/app/budgetPlans';

export function readLegacyBudgetPlans(): BudgetPlans {
  const globalBudgets: Record<string, number> = {};
  const prefix = 'easymoney:global-budget:';
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const value = Number(localStorage.getItem(key));
    if (Number.isFinite(value) && value >= 0) globalBudgets[key.slice(prefix.length)] = value;
  }
  // Invalid legacy JSON is left intact, with an error shown instead of silently losing plans.
  return {
    globalBudgets,
    dreamBudget: JSON.parse(localStorage.getItem('easymoney:dream-budget') || '{"globalBudget":0,"categoryPercents":{}}'),
    savedBudgets: JSON.parse(localStorage.getItem('easymoney:saved-budgets') || '[]'),
  };
}

export function useLoadBudgetPlans() {
  const [data, setData] = useState<Awaited<ReturnType<typeof trpcClient.budgets.plans.query>>>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void (async () => {
      const current = await trpcClient.budgets.plans.query();
      const result = current.revision ? current : await trpcClient.budgets.migratePlans.mutate(readLegacyBudgetPlans());
      if (active) setData(result);
    })().catch(error => { if (active) setError(String(error.message || error)); });
    return () => { active = false; };
  }, []);
  return { data, error };
}

export function useSaveBudgetPlans(plans: BudgetPlans, initialRevision: number) {
  const revision = useRef(initialRevision);
  const queue = useRef(Promise.resolve());
  const saved = useRef(JSON.stringify(plans));
  const enqueued = useRef(saved.current);
  const failed = useRef(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const serialized = JSON.stringify(plans);
  useEffect(() => {
    if (serialized === enqueued.current && attempt === 0) return;
    enqueued.current = serialized;
    // Serialize writes so rapid edits cannot arrive at the server out of order.
    queue.current = queue.current.then(async () => {
      if (failed.current) return;
      setPending(value => value + 1);
      try {
        const result = await trpcClient.budgets.savePlans.mutate({ plans: JSON.parse(serialized), revision: revision.current });
        revision.current = result.revision;
        saved.current = serialized;
      } catch (error) {
        failed.current = true;
        setError(error instanceof Error ? error.message : 'Unable to save budget plans.');
      } finally {
        setPending(value => value - 1);
      }
    });
  }, [serialized, attempt]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (serialized !== saved.current) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [serialized]);
  return { error, pending: pending > 0 || serialized !== saved.current, retry: () => {
    failed.current = false;
    setError('');
    setAttempt(value => value + 1);
  } };
}
