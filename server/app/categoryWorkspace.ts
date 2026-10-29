import { getDb } from '../database';
import { hashContent } from '../hash';
import { listCategories } from './categories';
import { listTransactions } from './transactions';
import { buildReviewGroups, reviewedTransaction } from './transactionReview';
import type { ReviewGroup } from './transactionReview';
import type { TransactionListItem } from './types';

export type ReviewFilter = 'all' | 'conflicts' | 'uncategorized' | 'movement';
const unknown = (row: TransactionListItem) =>
  !row.category || row.category.name.toLowerCase() === 'uncategorized';

function workspaceGroups() {
  const decisions = new Set(
    (
      getDb()
        .prepare('SELECT groupId, fingerprint FROM categoryReviewDecisions WHERE status = ?')
        .all('kept') as { groupId: string; fingerprint: string }[]
    ).map((row) => `${row.groupId}:${row.fingerprint}`),
  );
  return buildReviewGroups(listTransactions().transactions).map((group) => {
    const id = hashContent(group.id).slice(0, 32);
    const fingerprint = hashContent(
      JSON.stringify(
        group.transactions
          .map((row) => [reviewedTransaction(row), row.merchant, row.transactionKind, row.notes])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ),
    );
    return { ...group, id, fingerprint, kept: decisions.has(`${id}:${fingerprint}`) };
  });
}

function summary(group: ReviewGroup & { fingerprint: string; kept: boolean }) {
  const { transactions, ...rest } = group;
  const categories = [
    ...new Set(transactions.filter((row) => !unknown(row)).map((row) => row.category!.name)),
  ].sort();
  return {
    ...rest,
    transactionCount: transactions.length,
    categories,
    uncategorizedCount: transactions.filter(unknown).length,
    firstDate: transactions.at(-1)!.date,
    lastDate: transactions[0]!.date,
    conflict: categories.length > 1,
    movement: group.reasons.some((reason) => reason.startsWith('Possible investment')),
  };
}

export function categoryReviewQueue(
  input: { search?: string; filter?: ReviewFilter; status?: 'open' | 'kept'; offset?: number } = {},
) {
  const all = workspaceGroups().map(summary);
  const search = input.search?.trim().toLocaleLowerCase() ?? '';
  const status = input.status ?? 'open';
  const matching = all.filter(
    (group) =>
      group.kept === (status === 'kept') &&
      (input.filter === 'conflicts'
        ? group.conflict
        : input.filter === 'uncategorized'
          ? group.uncategorizedCount > 0
          : input.filter === 'movement'
            ? group.movement
            : true) &&
      (!search ||
        `${group.name} ${group.accountName} ${group.categories.join(' ')}`
          .toLocaleLowerCase()
          .includes(search)),
  );
  const offset = Math.max(0, input.offset ?? 0);
  return {
    groups: matching.slice(offset, offset + 50),
    totalCount: matching.length,
    openCount: all.filter((group) => !group.kept).length,
    keptCount: all.filter((group) => group.kept).length,
    hasMore: offset + 50 < matching.length,
    nextOffset: offset + 50 < matching.length ? offset + 50 : null,
  };
}

export function categoryReviewDetail(input: { groupId: string; offset?: number }) {
  const group = workspaceGroups().find((group) => group.id === input.groupId);
  if (!group) return null;
  const offset = Math.max(0, input.offset ?? 0);
  return {
    ...summary(group),
    transactions: group.transactions.slice(offset, offset + 50),
    hasMore: offset + 50 < group.transactions.length,
    nextOffset: offset + 50 < group.transactions.length ? offset + 50 : null,
  };
}

/** Acknowledges one exact review snapshot; does not edit transaction annotations or source facts. */
export function decideCategoryReview(input: {
  groupId: string;
  fingerprint: string;
  decision: 'keep' | 'reopen';
}) {
  const group = workspaceGroups().find((group) => group.id === input.groupId);
  if (!group || group.fingerprint !== input.fingerprint)
    throw new Error('This review changed. Refresh it before deciding.');
  getDb()
    .prepare(
      `INSERT INTO categoryReviewDecisions (groupId, fingerprint, status, updatedAt)
    VALUES (?, ?, ?, ?) ON CONFLICT(groupId, fingerprint) DO UPDATE SET status=excluded.status, updatedAt=excluded.updatedAt`,
    )
    .run(
      group.id,
      group.fingerprint,
      input.decision === 'keep' ? 'kept' : 'reopened',
      new Date().toISOString(),
    );
  return { ok: true };
}

function categoryBrowseData() {
  const categories = listCategories().categories.filter(
    (category) => category.name.toLowerCase() !== 'uncategorized',
  );
  const byId = new Map(categories.map((category) => [category.id, category]));
  const transactions = listTransactions().transactions;
  const ancestors = (id: number) => {
    const ids: number[] = [];
    while (byId.has(id) && !ids.includes(id)) {
      ids.push(id);
      const parent = byId.get(id)!.parentId;
      if (parent == null) break;
      id = parent;
    }
    return ids.reverse();
  };
  const paths = new Map(categories.map((category) => [category.id, ancestors(category.id)]));
  const matches = (row: TransactionListItem, categoryId: number | null) =>
    categoryId === null
      ? unknown(row)
      : Boolean(row.category && paths.get(row.category.id)?.includes(categoryId));
  const totals = new Map<
    number | null,
    { transactionCount: number; activityCents: number; merchants: Set<string> }
  >(
    [null, ...categories.map((category) => category.id)].map((id) => [
      id,
      { transactionCount: 0, activityCents: 0, merchants: new Set<string>() },
    ]),
  );
  for (const row of transactions) {
    for (const id of unknown(row) ? [null] : (paths.get(row.category!.id) ?? [])) {
      const total = totals.get(id)!;
      total.transactionCount++;
      total.activityCents += Math.abs(Math.round(row.amount * 100));
      total.merchants.add((row.merchant || row.description || 'Unknown').toLocaleLowerCase());
    }
  }
  const entries = categories
    .map((category) => {
      const ids = paths.get(category.id)!;
      const total = totals.get(category.id)!;
      return {
        ...category,
        path: ids.map((id) => byId.get(id)!.name).join(' / '),
        depth: Math.max(0, ids.length - 1),
        transactionCount: total.transactionCount,
        merchantCount: total.merchants.size,
        activityCents: total.activityCents,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const uncategorized = totals.get(null)!;
  return {
    transactions,
    matches,
    entries,
    uncategorized: {
      id: null,
      name: 'Uncategorized',
      path: 'Uncategorized',
      depth: 0,
      type: null,
      categoryGroup: null,
      description: null,
      parentId: null,
      color: null,
      icon: null,
      transactionCount: uncategorized.transactionCount,
      merchantCount: uncategorized.merchants.size,
      activityCents: uncategorized.activityCents,
    },
  };
}

export function browseCategoryActivity() {
  const data = categoryBrowseData();
  return { categories: [data.uncategorized, ...data.entries] };
}

export function browseCategoryTransactions(input: {
  categoryId: number | null;
  search?: string;
  offset?: number;
}) {
  const data = categoryBrowseData();
  if (
    input.categoryId !== null &&
    !data.entries.some((category) => category.id === input.categoryId)
  )
    throw new Error('Category no longer exists.');
  const ids = data.transactions
    .filter((row) => data.matches(row, input.categoryId))
    .flatMap((row) => (row.ledgerTransactionId ? [row.ledgerTransactionId] : []));
  return listTransactions({
    ledgerTransactionIds: ids,
    search: input.search,
    offset: input.offset ?? 0,
    limit: 50,
    sortBy: 'date_desc',
  });
}
