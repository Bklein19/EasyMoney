import { expect, test } from 'bun:test';
import { StatementValidationError, validateStatementTotals } from './statementValidation';
import { parseWellsFargoStatementText } from './moneyParsers/wells-fargo-statement-pdf';
import { createMoneyParserAdapter } from './moneyAdapter';

const evidence = { openingBalanceCents: -10000, closingBalanceCents: -11000, creditsCents: 2000, debitsCents: 3000 };
test('checks credits and debits independently, not just net movement', () => {
  expect(validateStatementTotals(evidence, [2000, -1500, -1500]).status).toBe('passed');
  expect(() => validateStatementTotals(evidence, [1000, -2000])).toThrow('parsed-credits');
  expect(() => validateStatementTotals(evidence, [2000, -1500])).toThrow('parsed-debits');
});
test('invalid evidence and inconsistent printed arithmetic fail safely', () => {
  expect(() => validateStatementTotals({ ...evidence, creditsCents: NaN }, [])).toThrow('invalid-evidence');
  expect(() => validateStatementTotals({ ...evidence, closingBalanceCents: 0 }, [])).toThrow('statement-arithmetic');
  expect(new StatementValidationError('parsed-credits').message).not.toContain('2000');
});
function statement() {
  return ['WELLS FARGO AUTOGRAPH VISA', 'Account ending in 1234', 'Statement Period 01/01/2026 to 01/31/2026',
    'Account Summary', 'Previous Balance $100.00', '- Payments $10.00', '- Other Credits $10.00',
    '+ Cash Advances $0.00', '+ Purchases, Balance Transfers & $30.00', 'Other Charges', '+ Fees Charged $0.00', '+ Interest Charged $0.00', '= New Balance $110.00',
    'Payments', '01/15 01/15REFERENCE1 THANK YOU 10.00',
    'Other Credits', '1234 01/16 01/16REFERENCE2 REFUND 10.00',
    'Purchases, Balance Transfers & Other Charges',
    '1234 01/20 01/21REFERENCE3 PURCHASE 15.00',
    '1234 01/20 01/21REFERENCE4 PURCHASE 15.00'].join('\n');
}
test('Wells touching PDF columns and card-prefixed credits reconcile without collapsing occurrences', () => {
  const result = parseWellsFargoStatementText(statement(), 'wells-fargo-autograph-visa-1234-2026-01-31.pdf');
  expect(result.transactions).toHaveLength(4);
  expect(result.transactions.slice(2).map(t => t.date)).toEqual(['2026-01-21', '2026-01-21']);
  expect(result.balances[0]?.raw?.statementValidation).toMatchObject({ status: 'passed', creditsCents: 2000, debitsCents: 3000 });
});
test('a dropped row or unreadable advertised summary fails the production parser', () => {
  expect(() => parseWellsFargoStatementText(statement().replace('1234 01/20 01/21REFERENCE4 PURCHASE 15.00', ''), 'card.pdf')).toThrow('parsed-debits');
  expect(() => parseWellsFargoStatementText(statement().replace('- Other Credits $10.00', ''), 'card.pdf')).toThrow('invalid-evidence');
});
test('production adapter preserves validation evidence as balance metadata, never a transaction', async () => {
  const adapter = createMoneyParserAdapter({ meta: { id: 'synthetic', institution: 'Wells Fargo', kind: 'statement', priority: 50, matches: () => true }, name: 'Synthetic', parseMoneyFile: async () => parseWellsFargoStatementText(statement(), 'card.pdf') });
  const result = await adapter.parse({ filePath: 'card.pdf', fileName: 'card.pdf', headers: [], rows: [], text: '' });
  expect(result.transactions).toHaveLength(4);
  expect(result.transactions.map(t => t?.amountCents)).toEqual([1000, 1000, -1500, -1500]);
  expect(result.balances[0]?.raw?.statementValidation).toMatchObject({ status: 'passed' });
});
test('unsupported summary is not silently labeled validated', () => {
  const result = parseWellsFargoStatementText(statement().replace('Account Summary', 'Legacy format'), 'card.pdf');
  expect(result.balances[0]?.raw?.statementValidation).toMatchObject({ status: 'unavailable' });
});
test('production adapter propagates validation failure before returning import facts', async () => {
  const adapter = createMoneyParserAdapter({ meta: { id: 'synthetic', institution: 'Wells Fargo', kind: 'statement', priority: 50, matches: () => true }, name: 'Synthetic', parseMoneyFile: async () => parseWellsFargoStatementText(statement().replace('REFUND 10.00', 'REFUND 1.00'), 'card.pdf') });
  await expect(adapter.parse({ filePath: 'card.pdf', fileName: 'card.pdf', headers: [], rows: [], text: '' })).rejects.toThrow('parsed-credits');
});
