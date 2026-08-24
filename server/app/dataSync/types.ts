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

export type SyncInstitutionId = 'bank-of-america' | 'vanguard' | 'sequoia-fund';

export interface SyncRunRequest {
  runId: string;
  institutionId: SyncInstitutionId;
  connectionId?: string;
  goal: SyncGoal;
}

export interface SyncTarget {
  id: string;
  institutionId: SyncInstitutionId;
  connectionId?: string;
  label: string;
}

export type SyncArtifactReviewStatus = 'ready' | 'already-imported';

export interface SyncTransactionClaim {
  date: string;
  amountCents: number;
  description: string;
  account: string | null;
  sourceRole: string | null;
}

export interface SyncBalanceClaim {
  date: string;
  balanceCents: number;
  account: string | null;
  accountHolder: string | null;
}

export interface SyncAccountClaim {
  sourceAccountId: number;
  institution: string | null;
  accountName: string | null;
  accountHolder: string | null;
  resolvedAccountId: number | null;
  resolvedAccountName: string | null;
  transactionCount: number;
  balanceCount: number;
}

export interface SyncArtifactReview {
  fileName: string;
  status: SyncArtifactReviewStatus;
  importFileId: number;
  accountId: number;
  accountName: string;
  parserName: string | null;
  institution: string | null;
  sourceType: string | null;
  coveredFrom: string | null;
  coveredTo: string | null;
  transactionCount: number;
  balanceCount: number;
  inflowCents: number;
  outflowCents: number;
  netAmountCents: number;
  accountClaims: SyncAccountClaim[];
  transactionSamples: SyncTransactionClaim[];
  balanceClaims: SyncBalanceClaim[];
  warnings: string[];
}

export interface SyncRunReview {
  runId: string;
  institutionId: SyncInstitutionId;
  downloaded: number;
  readyToImport: number;
  alreadyImported: number;
  artifacts: SyncArtifactReview[];
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
