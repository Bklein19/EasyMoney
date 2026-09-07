// Keep full percentage precision when saving; round only dollar amounts to cents.
export function budgetAmounts(template: { globalBudget: number; categoryPercents: Record<string, number> }) {
  return Object.fromEntries(Object.entries(template.categoryPercents).map(([id, percent]) =>
    [id, Math.round(template.globalBudget * percent) / 100]));
}

export function budgetPercentages(amounts: Record<string, number>, total: number) {
  return Object.fromEntries(Object.entries(amounts).map(([id, amount]) =>
    [id, total > 0 ? amount / total * 100 : 0]));
}
