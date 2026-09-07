import type {
  RoutedSyncArtifact,
  SyncAccountCoverage,
  SyncConnector,
  SyncConnectorContext,
  SyncConnectorRunContext,
} from '../connector.ts';
import { goalWindowForCoverage } from '../planning.ts';
import {
  runWellsFargoSync,
  type WellsFargoAccountKind,
  type WellsFargoDownloadedArtifact,
  type WellsFargoProgressEvent,
  type WellsFargoSyncAccount,
} from './wellsFargo.ts';

type WellsFargoSyncRunner = typeof runWellsFargoSync;

function identityTexts(account: SyncAccountCoverage): string[] {
  return [
    account.sourceAccountName,
    ...account.sourceAccountNames,
    ...account.accountAliases,
    account.name,
  ].filter((value): value is string => Boolean(value?.trim()));
}

export function matchesWellsFargoAccount(account: SyncAccountCoverage): boolean {
  return /\bwells\s+fargo\b/i.test(account.institution?.trim() ?? '');
}

function wellsFargoAccounts(context: SyncConnectorContext): SyncAccountCoverage[] {
  return context.accounts.filter(matchesWellsFargoAccount);
}

export function inferWellsFargoAccountKind(
  account: SyncAccountCoverage,
): WellsFargoAccountKind | null {
  const text = [account.type, ...identityTexts(account)].join(' ').toLowerCase();
  if (/\b(?:savings|money market)\b/.test(text)) return 'savings';
  if (/\bchecking\b/.test(text)) return 'checking';
  if (/\b(?:credit|card|visa|mastercard|american express|amex)\b/.test(text)) {
    return 'credit-card';
  }
  return null;
}

export function inferWellsFargoAccountLast4(account: SyncAccountCoverage): string | null {
  if (/^\d{4}$/.test(account.last4 ?? '')) return account.last4!;
  const preferred = new Set<string>();
  const fallback = new Set<string>();
  for (const text of identityTexts(account)) {
    const explicit = text.match(
      /(?:ending\s+in|account(?:\s+number)?|[x*\u2022]{2,}|-{2,})\D{0,12}(\d{4})(?!\d)/i,
    );
    if (explicit?.[1]) preferred.add(explicit[1]);
    const trailing = text.match(/(\d{4})(?!.*\d)/)?.[1];
    if (trailing) fallback.add(trailing);
  }
  const candidates = preferred.size > 0 ? preferred : fallback;
  return candidates.size === 1 ? [...candidates][0]! : null;
}

export function planWellsFargoAccounts(
  context: SyncConnectorRunContext,
): WellsFargoSyncAccount[] {
  const plans: WellsFargoSyncAccount[] = [];
  const identities = new Set<string>();

  for (const account of wellsFargoAccounts(context)) {
    const kind = inferWellsFargoAccountKind(account);
    const last4 = inferWellsFargoAccountLast4(account);
    if (!kind || !last4) {
      context.report({
        type: 'warning',
        message: 'Skipped a Wells Fargo account; its kind or number is missing or ambiguous',
        data: { accountId: account.id },
      });
      continue;
    }

    const identity = `${kind}:${last4}`;
    if (identities.has(identity)) {
      throw new Error('Multiple local Wells Fargo accounts have an ambiguous routing identity');
    }
    identities.add(identity);

    const activityWindow = goalWindowForCoverage(context.goal, account, context.today);
    const statementWindow = goalWindowForCoverage(context.goal, {
      latestFactDate: account.latestBalanceDate,
      earliestFactDate: account.earliestBalanceDate,
    }, context.today);
    plans.push({
      accountId: account.id,
      kind,
      last4,
      activityFrom: activityWindow.startDate,
      activityThrough: activityWindow.endDate,
      statementFrom: statementWindow.startDate,
      statementThrough: statementWindow.endDate,
    });
  }

  return plans;
}

export function routeWellsFargoArtifacts(
  artifacts: readonly WellsFargoDownloadedArtifact[],
  plannedAccounts: readonly WellsFargoSyncAccount[],
): RoutedSyncArtifact[] {
  const plannedById = new Map(plannedAccounts.map(account => [account.accountId, account]));
  return artifacts.map(artifact => {
    const planned = plannedById.get(artifact.accountId);
    if (!planned ||
        planned.kind !== artifact.account.kind ||
        planned.last4 !== artifact.account.last4) {
      throw new Error('A Wells Fargo artifact did not match its planned local account');
    }
    return { fileName: artifact.fileName, accountId: artifact.accountId };
  });
}

export function reportWellsFargoProgress(
  context: Pick<SyncConnectorRunContext, 'report'>,
  event: WellsFargoProgressEvent,
): void {
  const { message, ...data } = event;
  context.report({
    type: event.status === 'waiting'
      ? 'action'
      : event.status === 'failed'
        ? 'warning'
        : 'phase',
    message,
    data,
  });
}

export function createWellsFargoConnector(
  syncRunner: WellsFargoSyncRunner = runWellsFargoSync,
): SyncConnector<'wells-fargo'> {
  return {
    id: 'wells-fargo',
    label: 'Wells Fargo',
    matchesAccount: matchesWellsFargoAccount,
    listTargets(context) {
      return wellsFargoAccounts(context).length > 0 ? [{ label: 'Wells Fargo' }] : [];
    },
    async run(context) {
      const accounts = planWellsFargoAccounts(context);
      if (accounts.length === 0) {
        throw new Error('No active Wells Fargo accounts have a routable account kind and number');
      }
      context.report({
        type: 'phase',
        message: 'Opening Wells Fargo',
        data: { goal: context.goal.kind, accountCount: accounts.length },
      });
      const result = await syncRunner({
        outputDir: context.outputDir,
        accounts,
        session: 'wells-fargo-catchup',
      }, event => reportWellsFargoProgress(context, event));
      context.report({
        type: 'phase',
        message: `Validated ${result.artifacts.length} new artifact${result.artifacts.length === 1 ? '' : 's'}`,
        data: {
          accountCount: result.accounts.length,
          unavailableArtifactCount: result.unavailable.length,
        },
      });
      return routeWellsFargoArtifacts(result.artifacts, accounts);
    },
  };
}

export const wellsFargoConnector = createWellsFargoConnector();
