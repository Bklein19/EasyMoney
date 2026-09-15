import { expect, test } from 'bun:test';
import { checkCashStatement, checkInvestmentRollForward, checkTiaaRollForward } from './printedStatementChecks';
import { parseBofaDepositStatementText } from './moneyParsers/bofa-statement-pdf';
import { validateRecognizedRows } from './statementValidation';
test('Marcus interest is included in deposits, not added twice', () => {
  const text = 'Beginning Balance $100.00\nDeposits and Other Credits $21.00\nInterest Paid this Period $1.00\nWithdrawals and Other Debits $5.00\nEnding Balance $116.00';
  expect(checkCashStatement('marcus', text, [2000, 100, -500]).status).toBe('passed');
  expect(() => checkCashStatement('marcus', text, [2000, -500])).toThrow();
});
test('BofA deposit checks and fees are separate debits', () => {
  const text = 'Account summary\nBeginning balance on January 1, 2026 $100.00\nDeposits and other additions 50.00\nWithdrawals and other subtractions -10.00\nChecks -20.00\nService fees -1.00\nEnding balance on January 31, 2026 $119.00';
  expect(checkCashStatement('bofa-deposit', text, [5000, -1000, -2000, -100]).status).toBe('passed');
});
test('Wells deposit missing rows fail even when their signs offset', () => {
  const text = 'Beginning balance on 1/1 $100.00\nDeposits/Additions 20.00\nWithdrawals/Subtractions -20.00\nEnding balance on 1/31 $100.00';
  expect(() => checkCashStatement('wells-deposit', text, [])).toThrow('parsed-credits');
});
test('TIAA first column is current period and market movement is not a transaction', () => {
  const text = 'Beginning balance $100.00 $0.00\nYour contributions 10.00 999.00\nEmployer contributions 5.00 99.00\nOther Credits 2.00 88.00\nDistributions/Other Debits - 2.00 -77.00\nGains/Loss - 3.00 66.00\nEnding balance $112.00 $1000.00';
  expect(checkTiaaRollForward(text, 11200)).toMatchObject({ status: 'passed', transactionCompleteness: 'unavailable' });
  expect(() => checkTiaaRollForward(text, 11300)).toThrow('statement-arithmetic');
});
test('Merrill summary includes market movement and transfers, dash means printed zero', () => {
  const text = 'Opening Value (01/01) $100.00\nTotal Credits 10.00\nTotal Debits (5.00)\nSecurities You Transferred In/Out -\nMarket Gains/(Losses) (2.00)\nClosing Value (01/31) $103.00';
  expect(checkInvestmentRollForward('merrill', text, 10300).status).toBe('passed');
});
test('Morgan Stanley roll-forward uses net flows once', () => {
  expect(checkInvestmentRollForward('morgan-stanley', 'TOTAL BEGINNING VALUE $100.00\nNet Credits/Debits/Transfers $20.00\nChange in Value (5.00)\nTOTAL ENDING VALUE $115.00', 11500).status).toBe('passed');
});
test('NetBenefits cannot certify unhandled movement categories', () => {
  expect(checkInvestmentRollForward('netbenefits', 'Beginning Balance $0.00\nWithdrawals $2.00', 0).status).toBe('unavailable');
});
test('BofA side-by-side check columns preserve both checks and reconcile', () => {
  const text = ['Your Adv Plus Banking', 'Account number: 1234', 'for January 1, 2026 to January 31, 2026', 'Account summary',
    'Beginning balance on January 1, 2026 $100.00', 'Deposits and other additions 0.00', 'Withdrawals and other subtractions 0.00', 'Checks -30.00', 'Service fees 0.00', 'Ending balance on January 31, 2026 $70.00',
    'Checks', 'Date Check # Amount   Date Check # Amount', '01/02/26 1001 -10.00     01/03/26 1002 -20.00', 'Total checks -$30.00'].join('\n');
  const result = parseBofaDepositStatementText(text, 'bofa-checking.pdf');
  expect(result.transactions.map(row => row.amount_cents)).toEqual([-1000, -2000]);
  expect(result.balances[0]?.raw?.statementValidation).toMatchObject({ status: 'passed' });
  const missingNumber = parseBofaDepositStatementText(text.replace('01/02/26 1001', '01/02/26     '), 'bofa-checking.pdf');
  expect(missingNumber.transactions.map(row => row.amount_cents)).toEqual([-1000, -2000]);
});
test('row coverage cannot manufacture assurance when there are no recognized rows', () => {
  expect(validateRecognizedRows(0, 0).status).toBe('unavailable');
  expect(() => validateRecognizedRows(2, 1)).toThrow('unparsed-rows');
});
test('TIAA omitted zero categories do not borrow values from later account detail', () => {
  const text = 'Beginning balance $100.00\nYour contributions 10.00\nGains/Loss 2.00\nEnding balance $112.00\nPersonal rate of return\nOther Credits 500.00';
  expect(checkTiaaRollForward(text, 11200).status).toBe('passed');
});
test('TIAA fees participate in the printed roll-forward', () => {
  expect(checkTiaaRollForward('Beginning balance $100.00\nFees -2.00\nGains/Loss 3.00\nEnding balance $101.00\nPersonal rate of return', 10100).status).toBe('passed');
});
