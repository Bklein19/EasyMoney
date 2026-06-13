import { useEffect, useMemo, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { useNetWorth } from '../../hooks/useNetWorth';
import { formatCurrencyCompact } from '../../utils/formatters';
import KPICard from './KPICard';

const EMPTY_ACCOUNTS = [];

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function NetWorthCard() {
  const { currentNetWorth, percentChange } = useNetWorth();
  const [robinhoodSnapshot, setRobinhoodSnapshot] = useState(null);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/robinhood/snapshot')
      .then(response => {
        if (!response.ok) throw new Error(`Snapshot request failed: ${response.status}`);
        return response.json();
      })
      .then(data => {
        if (!cancelled) setRobinhoodSnapshot(data);
      })
      .catch(() => {
        if (!cancelled) setRobinhoodSnapshot(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const robinhoodTotal = useMemo(() => {
    const accounts = robinhoodSnapshot?.accounts || EMPTY_ACCOUNTS;
    return accounts.reduce((sum, account) => sum + numberValue(account.portfolio?.totalValue), 0);
  }, [robinhoodSnapshot]);

  const combinedNetWorth = currentNetWorth + robinhoodTotal;

  return (
    <KPICard
      title="Total Net Worth"
      amount={combinedNetWorth}
      trend={percentChange}
      trendLabel="local accounts trend"
      detail={robinhoodTotal > 0 ? `Includes ${formatCurrencyCompact(robinhoodTotal)} Robinhood` : 'Excludes investments'}
      icon={TrendingUp}
    />
  );
}
