import { listAccounts } from './accounts';
import { listCategories } from './categories';
import { listTransactions } from './transactions';
import { groupTransactionsForAiCategorization, matchHistoricalCategories, requiresPersonalCategoryReview } from './aiCategorization';
import { reviewedTransaction } from './transactionReview';
import type { TransactionListItem } from './types';

/** Explicitly invoked preview only. No model requests, writes, or import changes. */
export function previewConservativeCategoryCleanup() {
  const transactions = listTransactions().transactions;
  const accounts = listAccounts().accounts;
  const categories = listCategories().categories;
  const unknown = (row: TransactionListItem) => !row.category || row.category.name.toLowerCase() === 'uncategorized';
  const investment = (row: TransactionListItem) => ['investment', 'brokerage'].includes(row.account?.type ?? '');
  const protectedEvidence = (row: TransactionListItem) => /\btax\b|\bjournaled rsu\b/i.test(`${row.description} ${row.originalDescription}`);
  const uniqueCategory = (name: string, type: string) => {
    const matches = categories.filter(category => category.name.toLowerCase() === name && category.type === type);
    return matches.length === 1 ? matches[0]! : undefined;
  };
  const investmentCategory = uniqueCategory('investment', 'investment');
  const payrollCategory = uniqueCategory('payroll', 'income');
  const transferCategory = uniqueCategory('transfer', 'transfer');
  const candidates = new Map<string, { transaction: TransactionListItem; categoryId: number; categoryName: string; reason: string }>();
  const add = (transaction: TransactionListItem, category: typeof investmentCategory, reason: string) => {
    if (category && unknown(transaction) && transaction.amount !== 0 && transaction.ledgerTransactionId && !protectedEvidence(transaction) && !requiresPersonalCategoryReview(transaction)) {
      candidates.set(transaction.ledgerTransactionId, { transaction, categoryId: category.id, categoryName: category.name, reason });
    }
  };
  for (const row of transactions) {
    const text = row.description || row.originalDescription || '';
    if (investment(row) && !/\bfee|\bcharge|\bwithhold|\bjournal/i.test(text) &&
      /\bsweep (?:in|out)|\bbuy cash\b|\bsell cash\b|\byou (?:bought|sold)\b|\breinvestment\b|\bdividend (?:received|reinvestment)\b|\breinvdiv\b|^(?:buy|sell)\s*\||\bindividual current year contribution\b/i.test(text)) {
      add(row, investmentCategory, 'Explicit security trade, settlement sweep, reinvestment or investment contribution inside an investment account');
    } else if (!investment(row) && ['checking', 'savings'].includes(row.account?.type ?? '') && row.amount > 0 && /\bpayroll\d*\b/i.test(text)) {
      add(row, payrollCategory, 'Explicit payroll receipt in a cash account');
    }
  }
  // Require an exact bank confirmation AND reciprocal owned-account suffixes.
  // Same amount/date alone never establishes a transfer or consumes occurrences.
  const byConfirmation = new Map<string, Array<{ row: TransactionListItem; direction: string; target: string }>>();
  for (const row of transactions) {
    const match = (row.description || '').match(/\bonline banking transfer (to|from) (?:chk|sav)\s+(\d{4})\s+confirmation#\s*([a-z0-9]+)/i);
    if (!match) continue;
    const key = match[3]!.toLowerCase();
    const group = byConfirmation.get(key) ?? [];
    group.push({ row, direction: match[1]!.toLowerCase(), target: match[2]! }); byConfirmation.set(key, group);
  }
  for (const group of byConfirmation.values()) {
    if (group.length !== 2) continue;
    const [a, b] = group as [typeof group[number], typeof group[number]];
    const accountA = accounts.find(account => account.id === a.row.account?.id);
    const accountB = accounts.find(account => account.id === b.row.account?.id);
    if (!accountA || !accountB || accountA.id === accountB.id || a.target !== accountB.last4 || b.target !== accountA.last4 ||
      accounts.filter(account => account.last4 === a.target).length !== 1 || accounts.filter(account => account.last4 === b.target).length !== 1 ||
      a.row.date.slice(0, 10) !== b.row.date.slice(0, 10) || Math.round(a.row.amount * 100) !== -Math.round(b.row.amount * 100) || a.row.amount === 0 ||
      a.direction === b.direction || (a.direction === 'to') !== (a.row.amount < 0) || (b.direction === 'to') !== (b.row.amount < 0) ||
      group.some(({ row }) => !unknown(row) && row.category?.type !== 'transfer')) continue;
    for (const { row } of group) add(row, transferCategory, 'Reciprocal owned-account suffixes and exact bank confirmation, date and signed cents');
  }
  const raw = transactions.map(row => ({ id: row.id, accountId: row.account?.id, ledgerTransactionId: row.ledgerTransactionId!,
    accountName: row.account?.name ?? null, accountInstitution: row.account?.institution ?? null, accountType: row.account?.type ?? null,
    date: row.date, amountCents: Math.round(row.amount * 100), description: row.description, merchant: row.merchant,
    originalDescription: row.originalDescription, originalCategory: row.originalCategory, transactionKind: row.transactionKind,
    categoryId: row.category?.id ?? null }));
  const unknownIds = new Set(transactions.filter(unknown).map(row => row.id));
  const groups = groupTransactionsForAiCategorization(raw.filter(row => unknownIds.has(row.id)));
  const history = raw.filter(row => row.categoryId !== null && categories.find(category => category.id === row.categoryId)?.name.toLowerCase() !== 'uncategorized') as Array<typeof raw[number] & { categoryId: number }>;
  const matches = matchHistoricalCategories(groups, categories, history);
  const byId = new Map(transactions.map(row => [row.ledgerTransactionId, row]));
  for (const suggestion of matches.suggestions) {
    const category = categories.find(category => category.id === suggestion.categoryId);
    // Never propagate broad income, gifts, transfer purpose, or brokerage taxes.
    if (!category || !(category.type === 'expense' || ['Payroll', 'Interest'].includes(category.name))) continue;
    for (const id of suggestion.transactionIds) {
      const row = byId.get(id)!;
      if (candidates.has(id) || (investment(row) && !/\bfee|\bservice charge/i.test(row.description || '')) ||
        (category.type === 'income' && (row.amount <= 0 || !['checking', 'savings'].includes(row.account?.type ?? '')))) continue;
      add(row, category, 'Unanimous saved category for the same account, merchant and direction; ambiguous payments excluded');
    }
  }
  const rows = [...candidates.values()].sort((a, b) => a.transaction.ledgerTransactionId!.localeCompare(b.transaction.ledgerTransactionId!));
  return { unknownCount: transactions.filter(unknown).length, candidates: rows,
    changes: rows.map(row => ({ ...reviewedTransaction(row.transaction), categoryId: row.categoryId })) };
}
