import { useQuery } from '@tanstack/react-query';
import { trpc } from '../api/trpc';

export function useNetWorth() {
  const reportQuery = useQuery(trpc.netWorth.report.queryOptions());
  const report = reportQuery.data;

  return {
    currentNetWorth: report?.currentNetWorth ?? 0,
    historicalNetWorth: report?.history ?? [],
    percentChange: report?.percentChange ?? 0,
    isLoading: reportQuery.isLoading,
    isFetching: reportQuery.isFetching,
    error: reportQuery.error,
  };
}
