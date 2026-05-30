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
      icon={TrendingUp}
    />
  );
}
