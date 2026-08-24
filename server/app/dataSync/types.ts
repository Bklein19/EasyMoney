export type { SyncEvent, SyncGoal, SyncReporter } from './protocol.ts';
import type { RoutedSyncArtifact, SyncAccountCoverage } from './connector.ts';
import type { SyncGoal } from './protocol.ts';
import type { SyncInstitutionId as RegisteredSyncInstitutionId } from './registry.ts';
import type {
  ImportAccountMappingResolution,
} from '../importTypes.ts';

export type SyncInstitutionId = RegisteredSyncInstitutionId;

export interface SyncRunRequest {
  runId: string;
  institutionId: SyncInstitutionId;
  connectionId?: string;
  goal: SyncGoal;
}

export const SYNC_WORKER_PROTOCOL_VERSION = 1 as const;

export interface SyncExecutionPlan {
  protocolVersion: typeof SYNC_WORKER_PROTOCOL_VERSION;
  runId: string;
  institutionId: SyncInstitutionId;
  today: string;
  accounts: SyncAccountCoverage[];
  connectionId?: string;
  goal: SyncGoal;
  outputDir: string;
}

export interface SyncArtifactManifestEntry extends RoutedSyncArtifact {
  sizeBytes: number;
  sha256: string;
}

export interface SyncArtifactManifest {
  protocolVersion: typeof SYNC_WORKER_PROTOCOL_VERSION;
  runId: string;
  institutionId: SyncInstitutionId;
  artifacts: SyncArtifactManifestEntry[];
}

export type SyncWorkerMessage =
  | {
      protocolVersion: typeof SYNC_WORKER_PROTOCOL_VERSION;
      kind: 'event';
      event: import('./protocol.ts').SyncEvent;
    }
  | {
      protocolVersion: typeof SYNC_WORKER_PROTOCOL_VERSION;
      kind: 'manifest';
      manifest: SyncArtifactManifest;
    };

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
  remoteAccountId: string;
  institution: string | null;
  accountName: string | null;
  accountHolder: string | null;
  resolvedAccountId: number | null;
  resolvedAccountName: string | null;
  resolvedAccountStatus: string | null;
  resolution: ImportAccountMappingResolution | 'connector';
  /** True when the connector did not supply a concrete local destination. */
  requiresExplicitMapping: boolean;
  transactionCount: number;
  balanceCount: number;
}

export type SyncAccountMappingDecision =
  | { sourceAccountId: number; mode: 'existing'; accountId: number | null }
  | { sourceAccountId: number; mode: 'auto'; accountId?: number | null }
  | { sourceAccountId: number; mode: 'unarchive'; accountId: number }
  | {
      sourceAccountId: number;
      mode: 'create';
      account: {
        name?: string | null;
        institution?: string | null;
        type?: string | null;
        currency?: string | null;
        accountHolder?: string | null;
      };
    };

export interface SyncArtifactReview {
  fileName: string;
  status: SyncArtifactReviewStatus;
  importFileId: number;
  accountId: number | null;
  accountName: string | null;
  parserName: string | null;
  /** Human parser label. Optional so reviews persisted by older app builds still render. */
  parserLabel?: string | null;
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
