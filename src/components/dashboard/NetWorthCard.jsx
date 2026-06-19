import { TrendingUp } from 'lucide-react';
import { useNetWorth } from '../../hooks/useNetWorth';
import KPICard from './KPICard';

export default function NetWorthCard() {
  const { currentNetWorth, percentChange } = useNetWorth();

  return (
    <KPICard
      title="Total Net Worth"
      amount={currentNetWorth}
      trend={percentChange}
      trendLabel="ledger balance trend"
      detail="From imported balances"
      icon={TrendingUp}
    />
  );
}
