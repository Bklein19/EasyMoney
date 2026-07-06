export interface AccountLike {
  type?: string | null;
}

export function isCreditAccount(account?: AccountLike | null) {
  if (!account) return false;
  return ['credit', 'credit_card', 'credit-card'].includes(account.type || '');
}
