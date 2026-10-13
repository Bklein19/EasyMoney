import type { TransactionListItem } from './types';

/** Conservative display grouping, not transaction identity or a category rule. */
export function relatedMerchantKey(transaction: TransactionListItem) {
  const text = (transaction.merchant || transaction.description || transaction.originalDescription || '').trim();
  const normalized = text.toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // A processor or check is not a merchant; never bulk-combine unrelated people.
  const ambiguous = !normalized || /^(unknown|check(?: \d+)?|venmo|zelle|paypal|cash|mobile deposit|atm deposit)$/.test(normalized);
  return JSON.stringify([transaction.account?.id ?? null, Math.sign(transaction.amount), transaction.transactionKind,
    ambiguous ? transaction.ledgerTransactionId : normalized]);
}

export function reviewedTransaction(transaction: TransactionListItem) {
  if (!transaction.ledgerTransactionId || !transaction.account) throw new Error('Transaction lacks a stable ledger identity.');
  return {
    transactionId: transaction.ledgerTransactionId,
    expected: { categoryId: transaction.category?.id ?? null, accountId: transaction.account.id,
      date: transaction.date, amountCents: Math.round(transaction.amount * 100), description: transaction.description },
  };
}

export interface ReviewGroup {
  id: string;
  name: string;
  accountName: string;
  amountCents: number;
  reasons: string[];
  transactions: TransactionListItem[];
}

export function buildWorthReviewing(transactions: TransactionListItem[]) {
  const byMerchant = new Map<string, TransactionListItem[]>();
  for (const transaction of transactions) {
    if (!transaction.ledgerTransactionId || !transaction.account || transaction.amount === 0) continue;
    const key = relatedMerchantKey(transaction);
    const group = byMerchant.get(key) ?? [];
    group.push(transaction);
    byMerchant.set(key, group);
  }
  const groups: ReviewGroup[] = [];
  for (const [id, rows] of byMerchant) {
    rows.sort((a, b) => b.date.localeCompare(a.date) || a.ledgerTransactionId!.localeCompare(b.ledgerTransactionId!));
    const reasons: string[] = [];
    const uncategorized = rows.filter(row => !row.category || row.category.name.toLowerCase() === 'uncategorized').length;
    if (uncategorized) reasons.push(`${uncategorized.toLocaleString()} uncategorized transaction${uncategorized === 1 ? '' : 's'}`);
    const categoryNames = [...new Set(rows.filter(row => row.category && row.category.name.toLowerCase() !== 'uncategorized').map(row => row.category!.name))].sort();
    if (categoryNames.length > 1) reasons.push(`Categories differ: ${categoryNames.join(', ')}. This may be intentional.`);
    const questionable = rows.some(row => {
      if (row.amount >= 0 || !row.category || row.category.type !== 'expense') return false;
      const text = `${row.description || ''} ${row.originalDescription || ''}`;
      return /\bsweep (?:in|into)|\byou bought\b|\bbuy cash\b|\bonline banking transfer to\b/i.test(text) ||
        ['investment', 'internal_transfer', 'card_payment'].includes(row.transactionKind || '');
    });
    if (questionable) reasons.push('Possible investment or transfer activity is categorized as spending. Check the source before changing it.');
    if (!reasons.length) continue;
    const first = rows[0]!;
    groups.push({ id, name: first.merchant || first.description || 'Unknown transaction', accountName: first.account!.name,
      amountCents: rows.reduce((sum, row) => sum + Math.abs(Math.round(row.amount * 100)), 0), reasons, transactions: rows });
  }
  // Keep the overview useful: flagged categorized activity first, then largest unknowns.
  groups.sort((a, b) => Number(b.reasons.length > 1 || !b.reasons[0]!.includes('uncategorized')) - Number(a.reasons.length > 1 || !a.reasons[0]!.includes('uncategorized')) || b.amountCents - a.amountCents || a.id.localeCompare(b.id));
  return { groups: groups.slice(0, 5), totalGroups: groups.length };
}
