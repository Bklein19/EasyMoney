/** Printed totals are validation evidence, never synthetic transactions. */
export interface StatementValidationEvidence {
  openingBalanceCents: number;
  closingBalanceCents: number;
  creditsCents: number;
  debitsCents: number;
}
export class StatementValidationError extends Error {
  constructor(public readonly code: 'invalid-evidence' | 'statement-arithmetic' | 'parsed-credits' | 'parsed-debits') {
    // Safe for connector logs: no balances, account identifiers or document contents.
    super(`Statement validation failed (${code}). Existing ledger data has not been changed by this validation.`);
    this.name = 'StatementValidationError';
  }
}
export function validateStatementTotals(evidence: StatementValidationEvidence, signedAmounts: number[]) {
  if (![...Object.values(evidence), ...signedAmounts].every(Number.isSafeInteger) || evidence.creditsCents < 0 || evidence.debitsCents < 0) throw new StatementValidationError('invalid-evidence');
  if (evidence.openingBalanceCents + evidence.creditsCents - evidence.debitsCents !== evidence.closingBalanceCents) throw new StatementValidationError('statement-arithmetic');
  const credits = signedAmounts.filter(amount => amount > 0).reduce((sum, amount) => sum + amount, 0);
  const debits = -signedAmounts.filter(amount => amount < 0).reduce((sum, amount) => sum + amount, 0);
  if (credits !== evidence.creditsCents) throw new StatementValidationError('parsed-credits');
  if (debits !== evidence.debitsCents) throw new StatementValidationError('parsed-debits');
  return { ...evidence, status: 'passed' as const, checks: ['statement-arithmetic', 'parsed-credits', 'parsed-debits'] };
}
