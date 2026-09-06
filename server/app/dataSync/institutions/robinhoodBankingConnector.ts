import type {
  RoutedSyncArtifact,
  SyncAccountCoverage,
  SyncConnector,
  SyncConnectorRunContext,
} from '../connector.ts';
import { goalWindowForCoverage } from '../planning.ts';
import {
  discoverRobinhoodMobileExports,
  robinhoodMobileExportSourceDir,
  stageRobinhoodMobileExports,
  type RobinhoodMobileArtifact,
} from './robinhoodMobileExports.ts';

type RobinhoodAccountKind = 'banking' | 'credit';

function identityText(account: SyncAccountCoverage): string {
  return [
    account.name,
    account.type,
    account.sourceAccountName,
    ...account.sourceAccountNames,
    ...account.accountAliases,
  ].filter(Boolean).join(' ');
}

export function robinhoodAccountKind(account: SyncAccountCoverage): RobinhoodAccountKind | null {
  if (!/\brobinhood\b/i.test(account.institution ?? '')) return null;
  const text = identityText(account);
  if (/\b(?:credit|gold card|card)\b/i.test(text)) return 'credit';
  if (/\b(?:bank|banking|checking|savings|cash|spending)\b/i.test(text)) return 'banking';
  return null;
}

export function matchesRobinhoodBankingAccount(account: SyncAccountCoverage): boolean {
  return robinhoodAccountKind(account) !== null;
}

function artifactAccountKind(artifact: RobinhoodMobileArtifact): RobinhoodAccountKind {
  return artifact.kind.startsWith('credit-') ? 'credit' : 'banking';
}

function routeAccount(
  artifact: RobinhoodMobileArtifact,
  accounts: readonly SyncAccountCoverage[],
): SyncAccountCoverage | null {
  const kindMatches = accounts.filter(account => robinhoodAccountKind(account) === artifactAccountKind(artifact));
  if (artifact.accountLast4) {
    const last4Matches = kindMatches.filter(account => account.last4 === artifact.accountLast4);
    if (last4Matches.length === 1) return last4Matches[0]!;
    if (last4Matches.length > 1) {
      throw new Error(`Multiple local Robinhood accounts end in ${artifact.accountLast4}`);
    }
  }
  if (kindMatches.length === 1) return kindMatches[0]!;
  if (kindMatches.length > 1) {
    throw new Error(`Cannot safely route ${artifact.fileName}; multiple Robinhood ${artifactAccountKind(artifact)} accounts match`);
  }
  return null;
}

function isActivity(artifact: RobinhoodMobileArtifact): boolean {
  return artifact.kind.endsWith('-activity');
}

function includeStatement(
  artifact: RobinhoodMobileArtifact,
  account: SyncAccountCoverage,
  context: SyncConnectorRunContext,
): boolean {
  if (account.balanceDates.includes(artifact.coveredTo)) return false;
  if (context.goal.kind === 'range') {
    return artifact.coveredTo >= context.goal.startDate && artifact.coveredTo <= context.goal.endDate;
  }
  if (context.goal.kind === 'backfill') {
    return (!account.earliestBalanceDate || artifact.coveredTo < account.earliestBalanceDate) &&
      (!context.goal.stopAt || artifact.coveredTo >= context.goal.stopAt);
  }
  return !account.latestBalanceDate || artifact.coveredTo > account.latestBalanceDate;
}

export function planRobinhoodMobileArtifacts(
  discovered: readonly RobinhoodMobileArtifact[],
  context: SyncConnectorRunContext,
): Array<{ artifact: RobinhoodMobileArtifact; account: SyncAccountCoverage }> {
  const routed = discovered.flatMap(artifact => {
    const account = routeAccount(artifact, context.accounts);
    if (!account) {
      context.report({
        type: 'warning',
        message: `Skipped ${artifact.fileName} because no matching Robinhood ${artifactAccountKind(artifact)} account exists`,
      });
      return [];
    }
    return [{ artifact, account }];
  });

  const statements = routed.filter(item =>
    !isActivity(item.artifact) && includeStatement(item.artifact, item.account, context)
  );
  const newestActivity = new Map<RobinhoodAccountKind, (typeof routed)[number]>();
  for (const item of routed.filter(item => isActivity(item.artifact))) {
    const window = goalWindowForCoverage(context.goal, item.account, context.today);
    if (item.artifact.coveredFrom > window.endDate || item.artifact.coveredTo < window.startDate) continue;
    const kind = artifactAccountKind(item.artifact);
    const previous = newestActivity.get(kind);
    if (!previous ||
      item.artifact.coveredTo > previous.artifact.coveredTo ||
      (item.artifact.coveredTo === previous.artifact.coveredTo &&
        item.artifact.modifiedAtMs > previous.artifact.modifiedAtMs)) {
      newestActivity.set(kind, item);
    }
  }
  return [...newestActivity.values(), ...statements].sort((left, right) =>
    left.artifact.coveredTo.localeCompare(right.artifact.coveredTo) ||
    left.artifact.fileName.localeCompare(right.artifact.fileName)
  );
}

type DiscoverExports = typeof discoverRobinhoodMobileExports;
type StageExports = typeof stageRobinhoodMobileExports;

export function createRobinhoodBankingConnector(
  discover: DiscoverExports = discoverRobinhoodMobileExports,
  stage: StageExports = stageRobinhoodMobileExports,
): SyncConnector<'robinhood-banking'> {
  return {
    id: 'robinhood-banking',
    label: 'Robinhood mobile exports',
    matchesAccount: matchesRobinhoodBankingAccount,
    listTargets(context) {
      return context.accounts.some(matchesRobinhoodBankingAccount)
        ? [{ label: 'Robinhood mobile exports' }]
        : [];
    },
    async run(context) {
      const sourceDir = robinhoodMobileExportSourceDir();
      context.report({
        type: 'phase',
        message: 'Scanning for Robinhood mobile exports',
        data: { sourceDir },
      });
      const discovered = await discover(sourceDir);
      const selected = planRobinhoodMobileArtifacts(discovered, context);
      if (selected.length === 0) {
        throw new Error(`No new parser-supported Robinhood mobile exports were found in ${sourceDir}`);
      }
      await stage(selected.map(item => item.artifact), context.outputDir);
      context.report({
        type: 'phase',
        message: `Validated ${selected.length} Robinhood mobile export${selected.length === 1 ? '' : 's'}`,
        data: {
          discovered: discovered.length,
          selected: selected.length,
          transactions: selected.reduce((sum, item) => sum + item.artifact.transactionCount, 0),
          balances: selected.reduce((sum, item) => sum + item.artifact.balanceCount, 0),
        },
      });
      return selected.map(({ artifact, account }): RoutedSyncArtifact => ({
        fileName: artifact.fileName,
        accountId: account.id,
      }));
    },
  };
}

export const robinhoodBankingConnector = createRobinhoodBankingConnector();
