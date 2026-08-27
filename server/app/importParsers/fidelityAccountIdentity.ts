import type { AppImportParseResult } from '../importTypes.ts';

const FIDELITY_ACCOUNT_NUMBER = /\b[A-Z]?[A-Z0-9-]*\d[A-Z0-9-]{5,}\b/gi;

export function fidelityAccountNumber(value: string): string | null {
  const candidates = value.match(FIDELITY_ACCOUNT_NUMBER)
    ?.map(candidate => candidate.replace(/[^A-Z0-9]/gi, '').toUpperCase())
    .filter(candidate => (
      candidate.length >= 8
      && candidate.length <= 10
      && candidate.replace(/\D/g, '').length >= 7
    )) ?? [];
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0]! : null;
}

export function fidelityRemoteAccountId(value: string): string | null {
  const accountNumber = fidelityAccountNumber(value);
  return accountNumber ? `fidelity:${accountNumber}` : null;
}

export function withFidelityRemoteAccountIds(result: AppImportParseResult): AppImportParseResult {
  return {
    ...result,
    transactions: result.transactions.map(transaction => {
      if (!transaction?.account || transaction.remoteAccountId) return transaction;
      const remoteAccountId = fidelityRemoteAccountId(transaction.account);
      return remoteAccountId ? { ...transaction, remoteAccountId } : transaction;
    }),
    balances: result.balances.map(balance => {
      if (!balance.account || balance.remoteAccountId) return balance;
      const remoteAccountId = fidelityRemoteAccountId(balance.account);
      return remoteAccountId ? { ...balance, remoteAccountId } : balance;
    }),
  };
}
