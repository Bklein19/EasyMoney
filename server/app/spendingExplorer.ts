import type { CategorySummary, TransactionListItem } from './types';

export interface SpendingNode {
  id: string;
  name: string;
  kind: 'root' | 'category' | 'merchant' | 'merchant-group';
  amountCents: number;
  transactionIds: number[];
  children: SpendingNode[];
}

type Category = Pick<CategorySummary, 'id' | 'name' | 'parentId'>;
type Expense = Pick<TransactionListItem, 'id' | 'amount' | 'category' | 'merchant' | 'description'>;

/** Only receives expenses selected by the report's existing transaction-flow semantics.
 * This is gross spending, matching the report; refunds are not netted into the rings.
 */
export function buildSpendingTree(expenses: Expense[], categories: Category[]): SpendingNode {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const root: SpendingNode = {
    id: 'spending',
    name: 'All spending',
    kind: 'root',
    amountCents: 0,
    transactionIds: [],
    children: [],
  };
  const children = new Map<SpendingNode, Map<string, SpendingNode>>();

  function child(parent: SpendingNode, id: string, name: string, kind: SpendingNode['kind']) {
    const index = children.get(parent) ?? new Map<string, SpendingNode>();
    children.set(parent, index);
    let node = index.get(id);
    if (!node) {
      node = { id, name, kind, amountCents: 0, transactionIds: [], children: [] };
      index.set(id, node);
      parent.children.push(node);
    }
    // Choose a deterministic label for case/punctuation variants of a merchant.
    if (name.localeCompare(node.name) < 0) node.name = name;
    return node;
  }

  const paths = new Map<number, Category[]>();
  function categoryPath(category: Category): Category[] {
    const cached = paths.get(category.id);
    if (cached) return cached;
    const path: Category[] = [];
    const seen = new Set<number>();
    let current: Category | undefined = category;
    while (current && !seen.has(current.id)) {
      path.unshift(current);
      seen.add(current.id);
      current = current.parentId == null ? undefined : byId.get(current.parentId);
    }
    // Corrupt cyclic metadata must not hide spending or create infinite nesting.
    const safePath = current ? [category] : path;
    paths.set(category.id, safePath);
    return safePath;
  }

  for (const expense of expenses) {
    const amountCents = Math.round(Math.abs(expense.amount) * 100);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) continue;
    const lineage = [root];
    const category = expense.category
      ? (byId.get(expense.category.id) ?? { ...expense.category, parentId: null })
      : null;
    let parent = root;
    // The app treats an explicit Uncategorized category and no annotation alike.
    // Combine them for exploration without changing either saved annotation.
    const path =
      category && category.name.toLowerCase() !== 'uncategorized'
        ? categoryPath(category)
        : [{ id: null, name: 'Uncategorized' }];
    for (const entry of path) {
      const id = `${parent.id}/category:${entry.id ?? 'uncategorized'}`;
      parent = child(parent, id, entry.name, 'category');
      lineage.push(parent);
    }
    const name = expense.merchant?.trim() || expense.description?.trim() || 'Unknown merchant';
    const key =
      name
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim() || 'unknown';
    lineage.push(
      child(parent, `${parent.id}/merchant:${encodeURIComponent(key)}`, name, 'merchant'),
    );
    for (const node of lineage) {
      node.amountCents += amountCents;
      node.transactionIds.push(expense.id);
    }
  }

  function sort(node: SpendingNode) {
    node.transactionIds.sort((a, b) => a - b);
    node.children.sort((a, b) => b.amountCents - a.amountCents || a.id.localeCompare(b.id));
    node.children.forEach(sort);
    const merchants = node.children.filter((child) => child.kind === 'merchant');
    if (node.kind === 'category' && merchants.length > 24) {
      const smaller = merchants.slice(12);
      const grouped: SpendingNode = {
        id: `${node.id}/merchant-group:smaller`,
        name: `${smaller.length.toLocaleString('en-US')} smaller merchants`,
        kind: 'merchant-group',
        amountCents: smaller.reduce((sum, child) => sum + child.amountCents, 0),
        transactionIds: smaller.flatMap((child) => child.transactionIds).sort((a, b) => a - b),
        children: smaller,
      };
      const smallerIds = new Set(smaller.map((child) => child.id));
      node.children = [...node.children.filter((child) => !smallerIds.has(child.id)), grouped].sort(
        (a, b) => b.amountCents - a.amountCents || a.id.localeCompare(b.id),
      );
    }
  }
  sort(root);
  return root;
}
