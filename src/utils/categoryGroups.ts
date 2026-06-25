export const CATEGORY_GROUPS = [
  { key: 'income', label: 'Income' },
  { key: 'transfer', label: 'Transfers' },
  { key: 'fixed', label: 'Fixed / Recurring' },
  { key: 'variable', label: 'Variable / Necessary' },
  { key: 'discretionary', label: 'Discretionary' },
  { key: 'savings_investment', label: 'Savings / Investment' },
  { key: 'other', label: 'Other' },
] as const;

export const CATEGORY_GROUP_LABELS = Object.fromEntries(
  CATEGORY_GROUPS.map(group => [group.key, group.label])
) as Record<string, string>;

export function labelCategoryGroup(value: string | null | undefined) {
  if (!value) return 'None';
  return CATEGORY_GROUP_LABELS[value] ?? value.replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

export function categoryGroupKey(value: string | null | undefined) {
  const knownGroupKeys = new Set(CATEGORY_GROUPS.map(group => group.key));
  return value && knownGroupKeys.has(value as (typeof CATEGORY_GROUPS)[number]['key']) ? value : 'other';
}
