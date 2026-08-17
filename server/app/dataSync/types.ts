export type SyncGoal =
  | { kind: 'current'; overlapDays: number }
  | { kind: 'backfill'; stopAt?: string }
  | { kind: 'range'; startDate: string; endDate: string };

export type SyncEvent = {
  runId: string;
  timestamp: string;
  type: 'phase' | 'action' | 'artifact' | 'import' | 'warning' | 'complete' | 'error';
  message: string;
  data?: Record<string, unknown>;
};

export type SyncReporter = (event: Omit<SyncEvent, 'runId' | 'timestamp'>) => void;

export interface SyncRunRequest {
  runId: string;
  institutionId: 'bank-of-america';
  goal: SyncGoal;
}

export interface SyncRunResult {
  runId: string;
  institutionId: SyncRunRequest['institutionId'];
  downloaded: number;
  recordedTransactionFacts: number;
  recordedBalanceFacts: number;
  skippedTransactionDuplicates: number;
  skippedArtifacts: number;
  artifacts: string[];
}
