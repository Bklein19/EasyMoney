export type SyncGoal =
  | { kind: 'current'; overlapDays: number }
  | { kind: 'backfill'; stopAt?: string }
  | { kind: 'range'; startDate: string; endDate: string };

export type SyncEvent = {
  runId: string;
  timestamp: string;
  type: 'phase' | 'action' | 'artifact' | 'import' | 'review' | 'warning' | 'complete' | 'error';
  message: string;
  data?: Record<string, unknown>;
};

export type SyncReporter = (event: Omit<SyncEvent, 'runId' | 'timestamp'>) => void;
