export type AccountType = 'checking' | 'savings' | 'credit-card' | 'investment' | 'cash' | 'other' | string;
export type CategoryType = 'income' | 'expense' | 'transfer' | 'internal_transfer' | 'investment' | string;
export type CategoryGroup = 'income' | 'transfer' | 'fixed' | 'variable' | 'discretionary' | 'savings_investment' | 'other' | string;
export type TransactionType = 'income' | 'expense' | 'transfer' | 'investment' | string;
export type TransactionStatus = 'cleared' | 'pending' | string;

export interface AccountSummary {
  id: number;
  name: string;
  institution: string | null;
  type: AccountType;
  balance: number;
  latestBalanceMonth: string | null;
  isClosed: boolean;
  currency: string;
  accountHolder: string | null;
  last4: string | null;
  status: 'active' | 'archived' | 'closed' | string;
  archivedAt: string | null;
  updatedAt: string | null;
  aliases: AccountAliasSummary[];
}

export interface AccountAliasSummary {
  id: number;
  institution: string;
  alias: string;
}

export interface CategorySummary {
  id: number;
  name: string;
  parentId: number | null;
  type: CategoryType | null;
  categoryGroup: CategoryGroup | null;
  description: string | null;
  color: string | null;
  icon: string | null;
}

export interface TransactionCategory {
  id: number;
  name: string;
  type: CategoryType | null;
  categoryGroup: CategoryGroup | null;
  description: string | null;
  color: string | null;
  icon: string | null;
}

export interface TransactionAccount {
  id: number;
  name: string;
  institution: string | null;
  type: AccountType;
}

export interface TransactionListItem {
  id: number;
  ledgerTransactionId: string | null;
  account: TransactionAccount | null;
  category: TransactionCategory | null;
  date: string;
  amount: number;
  description: string | null;
  merchant: string | null;
  originalDescription: string | null;
  originalCategory: string | null;
  type: TransactionType | null;
  transactionKind: string | null;
  sourceRole: string | null;
  status: TransactionStatus | null;
  notes: string | null;
  importBatchId: string | null;
  fingerprint: string | null;
  createdAt: string | null;
}

export interface ListTransactionsOptions {
  accountId?: string | number | null;
  categoryId?: string | number | null;
  accountKind?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  search?: string | null;
  type?: string | null;
  flowType?: string | null;
  sortBy?: string | null;
  limit?: string | number | null;
  offset?: string | number | null;
  includeArchived?: boolean | string | null;
}

export interface TransactionListResponse {
  transactions: TransactionListItem[];
  totalCount: number;
  hasMore: boolean;
  nextOffset: number | null;
  totals: {
    income: number;
    expenses: number;
    internalMovement: number;
    investments: number;
    net: number;
  };
}

export interface AccountListResponse {
  accounts: AccountSummary[];
}

export interface CategoryListResponse {
  categories: CategorySummary[];
}

export interface NetWorthHistoryPoint {
  month: string;
  netWorth: number;
}

export interface NetWorthReport {
  currentNetWorth: number;
  percentChange: number;
  history: NetWorthHistoryPoint[];
}
