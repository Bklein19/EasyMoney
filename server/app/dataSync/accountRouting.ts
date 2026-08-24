import type { SequoiaFundDownloadedArtifact } from './institutions/sequoiaFund.ts';

export interface LocalAccountRoute {
  id: number;
  name: string;
  sourceAccountName?: string | null;
  sourceAccountNames?: string | null;
  accountAliases?: string | null;
}

function normalizedRouteNames(account: LocalAccountRoute): Set<string> {
  const values = [
    account.name,
    account.sourceAccountName,
    ...(account.sourceAccountNames ?? '').split('|'),
    ...(account.accountAliases ?? '').split('|'),
  ];
  return new Set(values
    .map(value => value?.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((value): value is string => Boolean(value)));
}

function routeLast4s(account: LocalAccountRoute): Set<string> {
  return new Set([...normalizedRouteNames(account)]
    .flatMap(value => [...value.matchAll(/\b(\d{4})\b/g)].map(match => match[1]!)));
}

export function routeSequoiaFundArtifacts(
  artifacts: SequoiaFundDownloadedArtifact[],
  accounts: LocalAccountRoute[],
): Array<{ fileName: string; accountId: number }> {
  if (artifacts.length === 0) return [];
  if (accounts.length === 0) throw new Error('No active Sequoia Fund account is available for downloaded data');

  const tokens = [...new Set(artifacts.map(artifact => artifact.accountToken))];
  const accountIdByToken = new Map<string, number>();
  const usedAccountIds = new Set<number>();
  for (const token of tokens) {
    const tokenArtifacts = artifacts.filter(artifact => artifact.accountToken === token);
    const claimedNames = [...new Set(tokenArtifacts.map(artifact => artifact.accountName.trim().toLowerCase()))];
    if (claimedNames.length !== 1) {
      throw new Error('Sequoia Fund artifacts disagree about their remote account identity');
    }

    const last4 = token.match(/^last4-(\d{4})$/)?.[1];
    let matches = last4
      ? accounts.filter(account => routeLast4s(account).has(last4))
      : accounts.filter(account => normalizedRouteNames(account).has(claimedNames[0]!));
    if (matches.length === 0 && tokens.length === 1 && accounts.length === 1) matches = [accounts[0]!];
    if (matches.length !== 1) {
      throw new Error('A Sequoia Fund remote account has no unambiguous local account route');
    }
    const accountId = matches[0]!.id;
    if (usedAccountIds.has(accountId)) {
      throw new Error('Multiple Sequoia Fund remote accounts map to the same local account');
    }
    usedAccountIds.add(accountId);
    accountIdByToken.set(token, accountId);
  }

  return artifacts.map(artifact => ({
    fileName: artifact.fileName,
    accountId: accountIdByToken.get(artifact.accountToken)!,
  }));
}
