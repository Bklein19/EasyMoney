interface CategoryNode {
  id: number | string;
  name: string;
  parentId?: number | string | null;
}

/** Display paths only; financial treatment always comes from the backend category type. */
export function categoryPath(category: CategoryNode, categories: CategoryNode[]): CategoryNode[] {
  const byId = new Map(categories.map(row => [String(row.id), row]));
  const path = [category];
  const seen = new Set([String(category.id)]);
  let parent = category.parentId == null ? undefined : byId.get(String(category.parentId));
  while (parent && !seen.has(String(parent.id))) {
    path.unshift(parent);
    seen.add(String(parent.id));
    parent = parent.parentId == null ? undefined : byId.get(String(parent.parentId));
  }
  return path;
}

export function categoryPathLabel(category: CategoryNode, categories: CategoryNode[]) {
  return categoryPath(category, categories).map(row => row.name).join(' › ');
}

export function compareCategoryPaths(a: CategoryNode, b: CategoryNode, categories: CategoryNode[]) {
  const left = categoryPath(a, categories);
  const right = categoryPath(b, categories);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const order = left[index]!.name.localeCompare(right[index]!.name) || String(left[index]!.id).localeCompare(String(right[index]!.id));
    if (order) return order;
  }
  return left.length - right.length;
}
