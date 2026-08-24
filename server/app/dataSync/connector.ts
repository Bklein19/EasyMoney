import type { SyncGoal, SyncReporter } from './protocol.ts';

export interface SyncAccountCoverage {
  id: number;
  name: string;
  institution: string | null;
  type: string;
  latestFactDate: string | null;
  earliestFactDate: string | null;
  latestBalanceDate: string | null;
  earliestBalanceDate: string | null;
  balanceDates: string[];
  sourceAccountName: string | null;
  sourceAccountNames: string[];
  accountAliases: string[];
  accountHolder: string | null;
  artifactFileNames: string[];
}

export interface SyncConnectorTarget {
  connectionId?: string;
  label: string;
}

export interface SyncArtifactAccountRoute {
  remoteAccountId: string;
  accountId?: number;
}

export interface RoutedSyncArtifact {
  fileName: string;
  /** Legacy single-claim destination. Multi-account artifacts use accountRoutes. */
  accountId?: number;
  accountRoutes?: SyncArtifactAccountRoute[];
}

export interface SyncConnectorContext {
  today: string;
  accounts: SyncAccountCoverage[];
}

export interface SyncConnectorRunContext extends SyncConnectorContext {
  connectionId?: string;
  goal: SyncGoal;
  outputDir: string;
  report: SyncReporter;
}

export interface SyncConnector<Id extends string = string> {
  readonly id: Id;
  readonly label: string;
  matchesAccount(account: SyncAccountCoverage): boolean;
  listTargets(context: SyncConnectorContext): SyncConnectorTarget[];
  run(context: SyncConnectorRunContext): Promise<RoutedSyncArtifact[]>;
}
