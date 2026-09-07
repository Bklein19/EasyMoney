import { z } from 'zod';
import { getDb } from '../database.ts';

export const budgetTemplateSchema = z.object({
  globalBudget: z.number().finite().nonnegative(),
  categoryPercents: z.record(z.string(), z.number().finite().min(0).max(100)),
});
export const budgetPlansSchema = z.object({
  globalBudgets: z.record(z.string().max(100), z.number().finite().nonnegative()),
  dreamBudget: budgetTemplateSchema,
  savedBudgets: z.array(budgetTemplateSchema.extend({
    id: z.string().min(1), name: z.string().trim().min(1).max(200), updatedAt: z.string(),
  })).max(1000),
});
export type BudgetPlans = z.infer<typeof budgetPlansSchema>;
const emptyPlans: BudgetPlans = { globalBudgets: {}, dreamBudget: { globalBudget: 0, categoryPercents: {} }, savedBudgets: [] };

export function getBudgetPlans() {
  const row = getDb().prepare('SELECT payloadJson, revision FROM budgetPlans WHERE id = 1').get() as
    { payloadJson: string; revision: number } | undefined;
  return { plans: row ? budgetPlansSchema.parse(JSON.parse(row.payloadJson)) : emptyPlans, revision: row?.revision ?? 0 };
}

// The first browser migration wins. Reopening an old browser cannot overwrite newer plans.
export function migrateBudgetPlans(input: BudgetPlans) {
  const plans = budgetPlansSchema.parse(input);
  getDb().prepare('INSERT OR IGNORE INTO budgetPlans (id, payloadJson, revision) VALUES (1, ?, 1)').run(JSON.stringify(plans));
  return getBudgetPlans();
}

export function saveBudgetPlans(input: { plans: BudgetPlans; revision: number }) {
  const plans = budgetPlansSchema.parse(input.plans);
  const result = getDb().prepare('UPDATE budgetPlans SET payloadJson = ?, revision = revision + 1 WHERE id = 1 AND revision = ?')
    .run(JSON.stringify(plans), input.revision);
  if (!result.changes) throw new Error('Budget plans changed in another window. Reload before saving again.');
  return getBudgetPlans();
}
