export const ACCOUNT_TYPES = ['checking', 'savings', 'cash', 'credit', 'loan', 'investment', 'brokerage', 'retirement', 'other'] as const;
export type AccountType = typeof ACCOUNT_TYPES[number];

export function normalizeAccountType(value: unknown): AccountType {
  if (typeof value !== 'string') throw new Error('Account type is required');
  const type = value.trim().toLowerCase();
  if (type === 'credit-card' || type === 'credit_card') return 'credit';
  if ((ACCOUNT_TYPES as readonly string[]).includes(type)) return type as AccountType;
  throw new Error(`Unsupported account type: ${type}`);
}

const TREATMENT: Record<AccountType, 'balance' | 'investment' | 'unknown'> = {
  checking: 'balance', savings: 'balance', cash: 'balance', credit: 'balance', loan: 'balance',
  investment: 'investment', brokerage: 'investment', retirement: 'investment', other: 'unknown',
};

export function isBalanceAccount(type: AccountType): boolean {
  const treatment = TREATMENT[type];
  if (treatment === 'unknown') throw new Error('Choose an account type before calculating investment performance');
  return treatment === 'balance';
}
