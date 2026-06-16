import { useMemo } from 'react';
import { add, update } from '../db/api';
import { useApiTable } from './useApiTable';
import { useAccounts } from './useAccounts';
import { calcNetWorth } from '../utils/calculations';
import { isCreditAccount } from '../utils/transactionSemantics';

interface BalanceSnapshot {
  id: number;
  accountId: number;
  month: string;
  balance: number;
}

interface NetWorthPoint {
  month: string;
  netWorth: number;
}

export function useNetWorth() {
  const { accounts } = useAccounts();
  const snapshots = useApiTable('balanceSnapshots') as BalanceSnapshot[];

  const currentNetWorth = useMemo(() => calcNetWorth(accounts), [accounts]);

  const historicalNetWorth = useMemo(() => {
    if (!snapshots.length) return [];

    const byMonth: Record<string, number> = {};
    for (const snap of snapshots) {
      if (!byMonth[snap.month]) byMonth[snap.month] = 0;
      byMonth[snap.month] += snap.balance;
    }

    return Object.entries(byMonth)
      .map(([month, netWorth]) => ({ month, netWorth }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }, [snapshots]) as NetWorthPoint[];

  const percentChange = useMemo(() => {
    if (historicalNetWorth.length < 2) return 0;
    const current = currentNetWorth;
    const previous = historicalNetWorth[historicalNetWorth.length - 1].netWorth;
    if (previous === 0) return current > 0 ? 100 : 0;
    return ((current - previous) / Math.abs(previous)) * 100;
  }, [currentNetWorth, historicalNetWorth]);

  async function captureSnapshot() {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    for (const account of accounts) {
      const balance = isCreditAccount(account) ? -Math.abs(account.currentBalance) : account.currentBalance;
      const existing = snapshots.find(snap => snap.accountId === account.id && snap.month === month);

      if (existing) {
        await update('balanceSnapshots', existing.id, { balance, capturedAt: now.toISOString() });
      } else {
        await add('balanceSnapshots', { accountId: account.id, month, balance, capturedAt: now.toISOString() });
      }
    }
  }

  return {
    currentNetWorth,
    historicalNetWorth,
    percentChange,
    captureSnapshot
  };
}
