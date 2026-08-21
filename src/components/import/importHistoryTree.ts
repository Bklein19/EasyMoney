import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../server/app/router.ts';

type RouterOutputs = inferRouterOutputs<AppRouter>;

export type ImportHistoryItem = RouterOutputs['imports']['history']['imports'][number];
export type ImportHistorySourceKind = ImportHistoryItem['sourceKind'];

export interface ImportHistorySummary {
  fileCount: number;
  transactionCount: number;
  balanceCount: number;
  importedCount: number;
  unimportedCount: number;
  latestAt: string | null;
}

export interface ImportHistorySourceGroup {
  id: string;
  label: string;
  sourceKind: ImportHistorySourceKind;
  imports: ImportHistoryItem[];
  summary: ImportHistorySummary;
}

export interface ImportHistoryAccountGroup {
  id: string;
  label: string;
  sources: ImportHistorySourceGroup[];
  summary: ImportHistorySummary;
}

export interface ImportHistoryHolderGroup {
  id: string;
  label: string;
  accounts: ImportHistoryAccountGroup[];
  summary: ImportHistorySummary;
}

const SOURCE_LABELS: Record<ImportHistorySourceKind, string> = {
  statements: 'Statements',
  activity: 'Activity',
  balances: 'Balances',
  other: 'Other files',
};

const SOURCE_ORDER: ImportHistorySourceKind[] = ['statements', 'activity', 'balances', 'other'];

interface ImportPlacement {
  holderId: string;
  holderLabel: string;
  accountId: string;
  accountLabel: string;
}

interface MutableSourceGroup {
  id: string;
  label: string;
  sourceKind: ImportHistorySourceKind;
  imports: ImportHistoryItem[];
}

interface MutableAccountGroup {
  id: string;
  label: string;
  sources: Map<ImportHistorySourceKind, MutableSourceGroup>;
}

interface MutableHolderGroup {
  id: string;
  label: string;
  accounts: Map<string, MutableAccountGroup>;
}

function cleanLabel(value: string | null | undefined) {
  return value?.trim() || null;
}

function placementForImport(item: ImportHistoryItem): ImportPlacement {
  const accountHolders = item.accounts.map(account => cleanLabel(account.accountHolder));
  const knownHolders = [...new Set(accountHolders.filter((holder): holder is string => holder !== null))];
  const hasUnknownHolder = accountHolders.some(holder => holder === null);

  let holderId: string;
  let holderLabel: string;
  if (knownHolders.length === 0) {
    holderId = 'holder:unknown';
    holderLabel = 'Unknown account holder';
  } else if (knownHolders.length > 1 || (item.accounts.length > 1 && hasUnknownHolder)) {
    holderId = 'holder:multiple';
    holderLabel = 'Multiple account holders';
  } else {
    holderId = `holder:single:${knownHolders[0]}`;
    holderLabel = knownHolders[0];
  }

  if (item.accounts.length === 0) {
    return {
      holderId,
      holderLabel,
      accountId: 'account:unknown',
      accountLabel: 'Unknown account',
    };
  }

  if (item.accounts.length > 1) {
    return {
      holderId,
      holderLabel,
      accountId: 'account:multiple',
      accountLabel: 'Multiple accounts',
    };
  }

  const account = item.accounts[0];
  const accountName = cleanLabel(account.name);
  return {
    holderId,
    holderLabel,
    accountId: accountName
      ? `account:single:${account.id ?? `${accountName}:${holderLabel}`}`
      : 'account:unknown',
    accountLabel: accountName ?? 'Unknown account',
  };
}

export function summarizeImportHistory(imports: ImportHistoryItem[]): ImportHistorySummary {
  let latestAt: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;

  for (const item of imports) {
    const date = item.committedAt || item.createdAt;
    const time = date ? Date.parse(date) : Number.NaN;
    if (date && !Number.isNaN(time) && time > latestTime) {
      latestAt = date;
      latestTime = time;
    }
  }

  return {
    fileCount: imports.length,
    transactionCount: imports.reduce((total, item) => total + (item.transactionCount || 0), 0),
    balanceCount: imports.reduce((total, item) => total + (item.balanceCount || 0), 0),
    importedCount: imports.filter(item => item.status === 'committed').length,
    unimportedCount: imports.filter(item => item.status === 'unimported').length,
    latestAt,
  };
}

function importsForAccount(group: MutableAccountGroup) {
  return [...group.sources.values()].flatMap(source => source.imports);
}

function importsForHolder(group: MutableHolderGroup) {
  return [...group.accounts.values()].flatMap(importsForAccount);
}

export function groupImportHistory(imports: ImportHistoryItem[]): ImportHistoryHolderGroup[] {
  const holderGroups = new Map<string, MutableHolderGroup>();

  for (const item of imports) {
    const placement = placementForImport(item);
    let holder = holderGroups.get(placement.holderId);
    if (!holder) {
      holder = {
        id: placement.holderId,
        label: placement.holderLabel,
        accounts: new Map(),
      };
      holderGroups.set(placement.holderId, holder);
    }

    let account = holder.accounts.get(placement.accountId);
    if (!account) {
      account = {
        id: `${holder.id}/${placement.accountId}`,
        label: placement.accountLabel,
        sources: new Map(),
      };
      holder.accounts.set(placement.accountId, account);
    }

    let source = account.sources.get(item.sourceKind);
    if (!source) {
      source = {
        id: `${account.id}/source:${item.sourceKind}`,
        label: SOURCE_LABELS[item.sourceKind],
        sourceKind: item.sourceKind,
        imports: [],
      };
      account.sources.set(item.sourceKind, source);
    }
    source.imports.push(item);
  }

  return [...holderGroups.values()]
    .sort((left, right) => left.label.localeCompare(right.label))
    .map(holder => {
      const accounts = [...holder.accounts.values()]
        .sort((left, right) => left.label.localeCompare(right.label))
        .map(account => ({
          id: account.id,
          label: account.label,
          sources: [...account.sources.values()]
            .sort((left, right) => SOURCE_ORDER.indexOf(left.sourceKind) - SOURCE_ORDER.indexOf(right.sourceKind))
            .map(source => ({
              ...source,
              summary: summarizeImportHistory(source.imports),
            })),
          summary: summarizeImportHistory(importsForAccount(account)),
        }));

      return {
        id: holder.id,
        label: holder.label,
        accounts,
        summary: summarizeImportHistory(importsForHolder(holder)),
      };
    });
}

export function filterImportHistory(imports: ImportHistoryItem[], searchTerm: string) {
  const normalizedSearch = searchTerm.trim().toLowerCase();
  if (!normalizedSearch) return imports;

  return imports.filter(item => [
    item.fileName,
    item.institution,
    item.parserName,
    item.sourceType,
    item.status,
    item.createdAt,
    item.committedAt,
    ...item.accounts.flatMap(account => [account.name, account.accountHolder]),
  ].filter(Boolean).join(' ').toLowerCase().includes(normalizedSearch));
}

