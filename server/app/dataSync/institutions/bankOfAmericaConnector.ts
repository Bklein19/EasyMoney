import type {
  RoutedSyncArtifact,
  SyncAccountCoverage,
  SyncConnector,
  SyncConnectorContext,
  SyncConnectorRunContext,
} from '../connector.ts';
import { goalWindowForCoverage } from '../planning.ts';
import {
  runBankOfAmericaSync,
  type BankOfAmericaAccountKind,
  type BankOfAmericaAccountPlan,
} from './bankOfAmerica.ts';

type BankOfAmericaSyncRunner = typeof runBankOfAmericaSync;

function isBankOfAmericaAccount(account: SyncAccountCoverage): boolean {
  return account.institution?.toLowerCase().includes('bank of america') ?? false;
}

function bankOfAmericaAccounts(context: SyncConnectorContext): SyncAccountCoverage[] {
  return context.accounts.filter(isBankOfAmericaAccount);
}

function accountKind(account: SyncAccountCoverage): BankOfAmericaAccountKind {
  const value = `${account.type} ${account.name} ${account.sourceAccountNames.join(' ')}`.toLowerCase();
  if (/credit|card|visa|mastercard/.test(value)) return 'credit-card';
  if (/savings|money market/.test(value)) return 'savings';
  if (/checking|banking/.test(value)) return 'checking';
  return 'deposit';
}

function accountLast4(account: SyncAccountCoverage): string | null {
  if (/^\d{4}$/.test(account.last4 ?? '')) return account.last4!;
  const value = [
    account.name,
    account.sourceAccountName,
    ...account.sourceAccountNames,
    ...account.accountAliases,
  ].filter((candidate): candidate is string => Boolean(candidate)).join(' ');
  const matches = [...value.matchAll(/\b(\d{4})\b/g)].map(match => match[1]!);
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0]! : null;
}

function accountPlans(context: SyncConnectorRunContext): BankOfAmericaAccountPlan[] {
  const plans: BankOfAmericaAccountPlan[] = [];
  const identities = new Set<string>();

  for (const account of bankOfAmericaAccounts(context)) {
    const kind = accountKind(account);
    const last4 = accountLast4(account);
    if (!last4) {
      context.report({
        type: 'warning',
        message: `Skipped planning ${account.name}; its Bank of America account number is missing or ambiguous`,
        data: { accountId: account.id },
      });
      continue;
    }

    const identity = `${kind}:${last4}`;
    if (identities.has(identity)) {
      throw new Error(`Multiple local Bank of America ${kind} accounts end in ${last4}.`);
    }
    identities.add(identity);

    const window = goalWindowForCoverage(context.goal, account, context.today);
    plans.push({
      kind,
      last4,
      from: window.startDate,
      through: window.endDate,
    });
  }

  return plans;
}

function accountForArtifact(
  fileName: string,
  accounts: SyncAccountCoverage[],
): SyncAccountCoverage {
  const match = fileName.match(/^bofa-(checking|savings|deposit|credit-card)-(\d{4})-/i);
  if (!match) {
    throw new Error(`Cannot read the Bank of America account identity from ${fileName}.`);
  }

  const kind = match[1]!.toLowerCase() as BankOfAmericaAccountKind;
  const last4 = match[2]!;
  const exact = accounts.filter(account =>
    accountKind(account) === kind && accountLast4(account) === last4
  );
  if (exact.length === 1) return exact[0]!;

  const sameNumber = accounts.filter(account => accountLast4(account) === last4);
  if (sameNumber.length === 1) return sameNumber[0]!;

  throw new Error(
    `Expected one local Bank of America ${kind} account ending in ${last4}, found ${exact.length}.`,
  );
}

function routeArtifacts(
  fileNames: string[],
  accounts: SyncAccountCoverage[],
): RoutedSyncArtifact[] {
  return fileNames.map(fileName => ({
    fileName,
    accountId: accountForArtifact(fileName, accounts).id,
  }));
}

export function createBankOfAmericaConnector(
  syncRunner: BankOfAmericaSyncRunner = runBankOfAmericaSync,
): SyncConnector<'bank-of-america'> {
  return {
    id: 'bank-of-america',
    label: 'Bank of America',
    matchesAccount: isBankOfAmericaAccount,
    listTargets(context) {
      return bankOfAmericaAccounts(context).length > 0 ? [{ label: 'BofA' }] : [];
    },
    async run(context) {
      const accounts = bankOfAmericaAccounts(context);
      const fallbackWindow = goalWindowForCoverage(context.goal, {
        latestFactDate: null,
        earliestFactDate: null,
      }, context.today);
      const plans = accountPlans(context);

      context.report({
        type: 'phase',
        message: 'Opening Bank of America',
        data: { goal: context.goal.kind },
      });
      const downloaded = await syncRunner({
        outputDir: context.outputDir,
        through: fallbackWindow.endDate,
        checkingThrough: fallbackWindow.endDate,
        savingsThrough: fallbackWindow.endDate,
        cardThrough: fallbackWindow.endDate,
        checkingFrom: fallbackWindow.startDate,
        savingsFrom: fallbackWindow.startDate,
        cardFrom: fallbackWindow.startDate,
        accounts: plans,
        session: 'bank-of-america',
        scope: null,
        dryRun: false,
      }, message => {
        context.report({ type: 'action', message });
      });

      context.report({
        type: 'phase',
        message: `Validated ${downloaded.saved.length} new artifact${downloaded.saved.length === 1 ? '' : 's'}`,
      });
      return routeArtifacts(downloaded.saved, accounts);
    },
  };
}

export const bankOfAmericaConnector = createBankOfAmericaConnector();
