import type {
  RoutedSyncArtifact,
  SyncAccountCoverage,
  SyncConnector,
  SyncConnectorContext,
  SyncConnectorRunContext,
} from '../connector.ts';
import { goalWindowForCoverage } from '../planning.ts';
import type { SyncGoal, SyncReporter } from '../protocol.ts';
import {
  MARCUS_PROFILE_NAME,
  runMarcusSync,
  type MarcusAccountKind,
  type MarcusDownloadedArtifact,
  type MarcusSyncAccount,
} from './marcus.ts';

type MarcusSyncRunner = typeof runMarcusSync;

function identityTexts(account: SyncAccountCoverage): string[] {
  return [
    account.sourceAccountName,
    ...account.sourceAccountNames,
    ...account.accountAliases,
    account.name,
    account.type,
  ].filter((value): value is string => Boolean(value?.trim()));
}

export function matchesMarcusAccount(account: SyncAccountCoverage): boolean {
  return /\b(?:marcus|goldman\s+sachs\s+bank\s+usa)\b/i.test(account.institution?.trim() ?? '');
}

export function inferMarcusAccountKind(account: SyncAccountCoverage): MarcusAccountKind | null {
  const text = identityTexts(account).join(' ');
  const savings = /\b(?:online\s+)?savings(?:\s+account)?\b/i.test(text);
  const deposit = /\b(?:certificate\s+of\s+deposit|deposit\s+account|(?:no[- ]penalty|high[- ]yield)\s+cd|cd)\b/i.test(text);
  if (savings === deposit) return null;
  return savings ? 'savings' : 'deposit';
}

export function inferMarcusAccountLast4(account: SyncAccountCoverage): string | null {
  if (/^\d{4}$/.test(account.last4 ?? '')) return account.last4!;
  const preferred = new Set<string>();
  const fallback = new Set<string>();
  for (const text of identityTexts(account)) {
    const explicit = text.match(
      /(?:ending\s+in|account(?:\s+(?:number|ending\s+in))?|[x*\u2022]{2,}|-{2,})\D{0,12}(\d{4})(?!\d)/i,
    );
    if (explicit?.[1]) preferred.add(explicit[1]);
    const trailing = text.match(/(?:^|\D)(\d{4})(?!.*\d)/)?.[1];
    if (trailing) fallback.add(trailing);
  }
  const candidates = new Set([...preferred, ...fallback]);
  return candidates.size === 1 ? [...candidates][0]! : null;
}

export function planMarcusAccounts(
  context: SyncConnectorContext,
  goal: SyncGoal,
  report: SyncReporter = () => {},
): MarcusSyncAccount[] {
  const plans: MarcusSyncAccount[] = [];
  const identities = new Set<string>();

  for (const account of context.accounts.filter(matchesMarcusAccount)) {
    const kind = inferMarcusAccountKind(account);
    const last4 = inferMarcusAccountLast4(account);
    if (!kind || !last4) {
      report({
        type: 'warning',
        message: 'Skipped one Marcus account because its type or routing identity is missing or ambiguous',
        data: { accountId: account.id, reason: 'missing-identity' },
      });
      continue;
    }
    if (kind !== 'savings') {
      report({
        type: 'warning',
        message: 'Skipped one Marcus account because its statement format is not parser-supported',
        data: { accountId: account.id, reason: 'unsupported-account-kind' },
      });
      continue;
    }

    const identity = `${kind}:${last4}`;
    if (identities.has(identity)) {
      throw new Error('Multiple local Marcus savings accounts share one routing identity');
    }
    identities.add(identity);
    const window = goalWindowForCoverage(goal, account, context.today);
    plans.push({
      accountId: account.id,
      kind,
      last4,
      startDate: window.startDate,
    });
  }

  return plans;
}

export function routeMarcusArtifacts(
  artifacts: readonly Pick<MarcusDownloadedArtifact, 'fileName' | 'accountId'>[],
  plans: readonly MarcusSyncAccount[],
): RoutedSyncArtifact[] {
  const plannedAccountIds = new Set(plans.map(plan => plan.accountId));
  const fileNames = new Set<string>();
  return artifacts.map(artifact => {
    if (!plannedAccountIds.has(artifact.accountId)) {
      throw new Error('Marcus returned an artifact for an unplanned local account');
    }
    if (fileNames.has(artifact.fileName)) {
      throw new Error('Marcus returned a duplicate artifact filename');
    }
    fileNames.add(artifact.fileName);
    return { fileName: artifact.fileName, accountId: artifact.accountId };
  });
}

export function createMarcusConnector(
  syncRunner: MarcusSyncRunner = runMarcusSync,
): SyncConnector<'marcus'> {
  return {
    id: 'marcus',
    label: 'Marcus',
    matchesAccount: matchesMarcusAccount,
    listTargets(context) {
      return context.accounts.some(matchesMarcusAccount) ? [{ label: 'Marcus' }] : [];
    },
    async run(context: SyncConnectorRunContext) {
      const plans = planMarcusAccounts(context, context.goal, context.report);
      if (plans.length === 0) {
        throw new Error('No active Marcus accounts have a supported, unambiguous routing identity');
      }

      context.report({
        type: 'phase',
        message: 'Opening Marcus',
        data: { goal: context.goal.kind, plannedAccountCount: plans.length },
      });
      const result = await syncRunner({
        outputDir: context.outputDir,
        through: context.today,
        accounts: plans,
        session: MARCUS_PROFILE_NAME,
        allowInteractiveAuthentication: true,
      }, context.report);
      if (result.status === 'authentication-required') {
        throw new Error('Marcus authentication is required');
      }

      context.report({
        type: 'phase',
        message: `Validated ${result.artifacts.length} new artifact${result.artifacts.length === 1 ? '' : 's'}`,
        data: {
          accountCount: result.accounts.length,
          unsupportedArtifactCount: result.unsupportedArtifactCount,
          unmappedAccountCount: result.unmappedAccountCount,
          unavailableAccountCount: result.unavailableAccountCount,
        },
      });
      return routeMarcusArtifacts(result.artifacts, plans);
    },
  };
}

export const marcusConnector = createMarcusConnector();
