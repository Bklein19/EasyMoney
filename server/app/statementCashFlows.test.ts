import { expect, test } from 'bun:test';
import { readStatementCashFlow, selectStatementCashFlows } from './statementCashFlows';
import { parseTiaaStatementText } from './importParsers/moneyParsers/tiaa-statement-pdf';
import { parseFidelity401kHtml } from './importParsers/moneyParsers/fidelity-401k-html';

test('quarterly totals are evidence, not transactions; ignore year-to-date and fund repetitions', () => {
  const parsed = parseTiaaStatementText(`For April 1, 2026 to June 30, 2026\nYour balance on June 30, 2026: $20,000.00\nYour contributions $1,000.00 $4,000.00\nEmployer contributions $500.00 $2,000.00\nOther Credits $20.00 $40.00\nDistributions/Other Debits - $100.00 - $200.00\nYour contributions $300.00`);
  expect(parsed.transactions).toEqual([]);
  expect(readStatementCashFlow(parsed.balances[0]!.raw!)).toEqual({from:'2026-04-01',to:'2026-06-30',netContributionsCents:142000});
});
test('Fidelity contribution totals survive without fabricated events', () => {
  const parsed = parseFidelity401kHtml('Statement Period: 04/01/2026 to 04/30/2026 Ending Balance $20,000.00 Your Contributions $1,000.00');
  expect(parsed.transactions).toEqual([]);
  expect(readStatementCashFlow(parsed.balances[0]!.raw!)?.netContributionsCents).toBe(100000);
});
test('identical downloads count once; contradictory or overlapping periods fail closed', () => {
  const flow = {from:'2026-04-01',to:'2026-06-30',netContributionsCents:10000};
  expect(selectStatementCashFlows([flow, flow])).toEqual([flow]);
  expect(() => selectStatementCashFlows([flow,{...flow,netContributionsCents:20000}])).toThrow('disagree');
  expect(() => selectStatementCashFlows([flow,{...flow,from:'2026-05-01'}])).toThrow('Overlapping');
});
