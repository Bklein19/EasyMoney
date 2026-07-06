import type { CategorySummary, TransactionAccount, TransactionCategory, TransactionListItem } from './types';

type AccountLike = Pick<TransactionAccount, 'id' | 'name' | 'institution' | 'type'>;
type CategoryLike = Pick<CategorySummary | TransactionCategory, 'id' | 'name' | 'type'>;

export type TransactionFlow =
  | 'income'
  | 'expense'
  | 'transfer'
  | 'card_payment'
  | 'internal_transfer'
  | 'investment'
  | 'refund'
  | 'neutral';

export function isCreditAccount(account: Pick<AccountLike, 'type'> | null | undefined) {
  return account?.type === 'credit' || account?.type === 'credit_card' || account?.type === 'credit-card';
}

export function isInvestmentAccount(account: Pick<AccountLike, 'type'> | null | undefined) {
  return account?.type === 'investment' || account?.type === 'brokerage';
}

export function buildAccountMap<T extends AccountLike>(accounts: T[] = []) {
  return accounts.reduce<Record<string, T>>((map, account) => {
    map[String(account.id)] = account;
    return map;
  }, {});
}

export function buildCategoryMap<T extends CategoryLike>(categories: T[] = []) {
  return categories.reduce<Record<string, T>>((map, category) => {
    map[String(category.id)] = category;
    return map;
  }, {});
}

const PAYMENT_WORDS = [
  'payment',
  'pmt',
  'autopay',
  'auto pay',
  'e-payment',
  'epayment',
  'online pmt',
  'cc pmt',
  'card pmt',
];

const CARD_ISSUER_WORDS = [
  'amex',
  'american express',
  'barclay',
  'capital one',
  'cap one',
  'citi',
  'citicard',
  'chase card',
  'credit card',
  'discover',
  'synchrony',
  'syncb',
  'wells fargo card',
];

const GENERIC_ACCOUNT_WORDS = new Set([
  'account',
  'card',
  'credit',
  'visa',
  'mastercard',
  'platinum',
  'rewards',
  'bank',
  'the',
]);

const INTERNAL_TRANSFER_WORDS = [
  'ach',
  'brokerage',
  'contribution',
  'funding',
  'investment',
  'transfer',
  'xfer',
];

function normalizeText(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function hasAny(text: string, words: string[]) {
  return words.some(word => text.includes(word));
}

function isInvestmentCategory(category: Pick<CategoryLike, 'name' | 'type'> | null | undefined) {
  if (!category) return false;
  const name = normalizeText(category.name);
  return category.type === 'investment' || name === 'investment' || name === 'investments';
}

function issuerTokensFromAccounts(accountMap: Record<string, AccountLike>) {
  return Object.values(accountMap)
    .filter(isCreditAccount)
    .flatMap(account => [account.name, account.institution])
    .filter((value): value is string => Boolean(value))
    .flatMap(value => normalizeText(value).split(' '))
    .filter(token => token.length > 2 && !GENERIC_ACCOUNT_WORDS.has(token));
}

function accountTokensByType(accountMap: Record<string, AccountLike>, predicate: (account: AccountLike) => boolean) {
  return Object.values(accountMap)
    .filter(predicate)
    .flatMap(account => [account.name, account.institution])
    .filter((value): value is string => Boolean(value))
    .flatMap(value => normalizeText(value).split(' '))
    .filter(token => token.length > 2 && !GENERIC_ACCOUNT_WORDS.has(token));
}

export function isLikelyBankSideCardPayment(transaction: TransactionListItem, accountMap: Record<string, AccountLike> = {}) {
  const account = transaction.account ? accountMap[String(transaction.account.id)] : null;
  if (isCreditAccount(account) || transaction.amount >= 0) return false;

  const text = normalizeText(`${transaction.merchant || ''} ${transaction.description || ''}`);
  if (!hasAny(text, PAYMENT_WORDS)) return false;

  if (hasAny(text, CARD_ISSUER_WORDS)) return true;

  const issuerTokens = issuerTokensFromAccounts(accountMap);
  return issuerTokens.some(token => text.includes(token));
}

export function isLikelyInvestmentTransfer(transaction: TransactionListItem, accountMap: Record<string, AccountLike> = {}) {
  const account = transaction.account ? accountMap[String(transaction.account.id)] : null;
  if (isCreditAccount(account) || isInvestmentAccount(account) || transaction.amount >= 0) return false;

  const text = normalizeText(`${transaction.merchant || ''} ${transaction.description || ''}`);
  const investmentTokens = accountTokensByType(accountMap, isInvestmentAccount);
  const mentionsInvestmentAccount = investmentTokens.some(token => text.includes(token));

  return mentionsInvestmentAccount && (
    hasAny(text, INTERNAL_TRANSFER_WORDS) ||
    investmentTokens.some(token => token.length >= 5 && text.includes(token))
  );
}

export function getTransactionFlow(
  transaction: TransactionListItem,
  accountMap: Record<string, AccountLike> = {},
  categoryMap: Record<string, CategoryLike> = {}
): TransactionFlow {
  const category = transaction.category ? categoryMap[String(transaction.category.id)] : null;
  if (isInvestmentCategory(category)) return 'investment';
  if (category?.type === 'internal_transfer') return 'internal_transfer';
  if (category?.type === 'transfer') return 'transfer';
  if (transaction.transactionKind === 'card_payment') return 'card_payment';
  if (transaction.transactionKind === 'internal_transfer') return 'internal_transfer';
  if (transaction.transactionKind === 'investment') return 'investment';
  if (transaction.transactionKind === 'refund') return 'refund';

  const account = transaction.account ? accountMap[String(transaction.account.id)] : null;
  if (isCreditAccount(account) && transaction.amount > 0) {
    return 'card_payment';
  }
  if (isLikelyBankSideCardPayment(transaction, accountMap)) {
    return 'card_payment';
  }
  if (isLikelyInvestmentTransfer(transaction, accountMap)) {
    return 'investment';
  }

  if (transaction.amount > 0) return 'income';
  if (transaction.amount < 0) return 'expense';
  return 'neutral';
}

export function isIncome(transaction: TransactionListItem, accountMap: Record<string, AccountLike>, categoryMap: Record<string, CategoryLike>) {
  return getTransactionFlow(transaction, accountMap, categoryMap) === 'income';
}

export function isExpense(transaction: TransactionListItem, accountMap: Record<string, AccountLike>, categoryMap: Record<string, CategoryLike>) {
  return getTransactionFlow(transaction, accountMap, categoryMap) === 'expense';
}

export function isInvestmentMovement(transaction: TransactionListItem, accountMap: Record<string, AccountLike>, categoryMap: Record<string, CategoryLike>) {
  return getTransactionFlow(transaction, accountMap, categoryMap) === 'investment';
}

export function isExcludedFromCashFlow(transaction: TransactionListItem, accountMap: Record<string, AccountLike>, categoryMap: Record<string, CategoryLike>) {
  const flow = getTransactionFlow(transaction, accountMap, categoryMap);
  return flow === 'transfer' || flow === 'card_payment' || flow === 'internal_transfer' || flow === 'investment';
}

