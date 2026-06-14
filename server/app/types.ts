export type AccountType = 'checking' | 'savings' | 'credit-card' | 'investment' | 'cash' | 'other' | string;
export type CategoryType = 'income' | 'expense' | 'transfer' | 'internal_transfer' | 'investment' | string;
export type TransactionType = 'income' | 'expense' | 'transfer' | 'investment' | string;
export type TransactionStatus = 'cleared' | 'pending' | string;

export interface AccountSummary {
  id: number;
  name: string;
  institution: string | null;
  type: AccountType;
  balance: number;
  currency: string;
  updatedAt: string | null;
}

export interface CategorySummary {
  id: number;
  name: string;
  parentId: number | null;
  type: CategoryType | null;
  color: string | null;
  icon: string | null;
}

export interface TransactionCategory {
  id: number;
  name: string;
  type: CategoryType | null;
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
  status: TransactionStatus | null;
  notes: string | null;
  importBatchId: string | null;
  fingerprint: string | null;
  createdAt: string | null;
}

export interface ListTransactionsOptions {
  accountId?: string | number | null;
  categoryId?: string | number | null;
  startDate?: string | null;
  endDate?: string | null;
  search?: string | null;
  type?: string | null;
  limit?: string | number | null;
}

export interface TransactionListResponse {
  transactions: TransactionListItem[];
}

export interface AccountListResponse {
  accounts: AccountSummary[];
}

export interface CategoryListResponse {
  categories: CategorySummary[];
}
