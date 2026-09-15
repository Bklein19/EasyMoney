import { expect, test } from 'bun:test';
import { checkCashStatement, checkInvestmentRollForward, checkTiaaRollForward, checkSequoiaShares, checkFidelityAccountRollForward, checkVanguardEmptyActivity } from './printedStatementChecks';
import { parseBofaDepositStatementText } from './moneyParsers/bofa-statement-pdf';
import { validateRecognizedRows } from './statementValidation';
import { parseFidelity401kHtml } from './moneyParsers/fidelity-401k-html';
import { parseTiaaStatementText } from './moneyParsers/tiaa-statement-pdf';

test('retirement reporting evidence and validation survive together after integration', () => {
  const fidelity = parseFidelity401kHtml('Statement Period: 01/01/2026 to 01/31/2026 Beginning Balance $100.00 Your Contributions $10.00 Employer Contributions $5.00 Change in Market Value $2.00 Ending Balance $117.00');
  expect(fidelity.transactions).toEqual([]);
  expect(fidelity.balances[0]?.raw).toMatchObject({
    statementCashFlow: {netContributionsCents:1500}, statementValidation:{status:'passed'},
  });
  const text = 'Your balance on March 31, 2026: $117.00\nFor January 1, 2026 to March 31, 2026';
  const layout = 'Beginning balance $100.00\nYour contributions 10.00\nEmployer contributions 5.00\nGains/Loss 2.00\nEnding balance $117.00\nPersonal rate of return';
  const tiaa = parseTiaaStatementText(text,layout);
  expect(tiaa.transactions).toEqual([]);
  expect(tiaa.balances[0]?.raw).toMatchObject({
    statementCashFlow: {netContributionsCents:1500}, statementValidation:{status:'passed'},
  });
});
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
  expect(checkInvestmentRollForward('netbenefits', 'Beginning Balance $2.00\nWithdrawals -$2.00\nEnding Balance $0.00', 0).status).toBe('unavailable');
});

test('NetBenefits bounds summary, supports omitted zero rows and fees, rejects incomplete evidence', () => {
  const text = 'Loans Withdrawals Transfers Beginning Balance $100.00 Your Contributions $10.00 Fees -$1.00 Change in Market Value -$2.00 Ending Balance $107.00 Withdrawals $900.00';
  expect(checkInvestmentRollForward('netbenefits', text, 10700).status).toBe('passed');
  expect(checkInvestmentRollForward('netbenefits', 'Beginning Balance $0.00 Ending Balance $0.00', 0).status).toBe('passed');
  expect(() => checkInvestmentRollForward('netbenefits', text, 10800)).toThrow('statement-arithmetic');
  expect(() => checkInvestmentRollForward('netbenefits', 'Beginning Balance $0.00 Fees -$1.00', 0)).toThrow('invalid-evidence');
  expect(checkInvestmentRollForward('netbenefits', 'Beginning Balance $0.00 Unknown credit $1.00 Unknown debit -$1.00 Ending Balance $0.00', 0).status).toBe('unavailable');
});

test('Fidelity summary separates current period and excludes nested costs from subtraction total', () => {
  const text = 'Beginning Account Value $100.00 $900.00\nAdditions 20.00 500.00\nSubtractions -11.00 -400.00\n Transaction Costs, Fees & Charges -1.00 -20.00\nChange in Investment Value * -2.00 700.00\nEnding Account Value ** $107.00 $1700.00';
  expect(checkFidelityAccountRollForward(text,10700).status).toBe('passed');
  expect(() => checkFidelityAccountRollForward(text.replace('-11.00','-10.00'),10700)).toThrow('statement-arithmetic');
  expect(checkFidelityAccountRollForward('Beginning Account Value as of Jan 1, 2026 -\nEnding Account Value as of Dec 31, 2026 ** -',0).status).toBe('passed');
});

test('Sequoia validates every share movement without manufacturing reinvestment transactions', () => {
  const text = 'Beginning Balance as of 01/01/26 $100.00 $10.00 10.000\n02/01/26 Shares Purchased -ACH 20.00 10.00 2.000 12.000\n03/01/26 Income Reinvest 0.10 1.20 12.00 0.100 12.100\nEnding Balance as of 03/31/26 $145.20 $12.00 12.100';
  expect(checkSequoiaShares(text,14520,1)).toMatchObject({status:'passed',activityRows:2});
  expect(checkSequoiaShares(text.replace('Shares Purchased -ACH','Fund Purchase 12345').replace('Income Reinvest','ST CG Rein'),14520,1).status).toBe('passed');
  expect(() => checkSequoiaShares(text,14520,0)).toThrow('unparsed-rows');
  expect(() => checkSequoiaShares(text.replace('0.100 12.100','0.200 12.100'),14520,1)).toThrow('statement-arithmetic');
  expect(() => checkSequoiaShares(text.replace('Income Reinvest','Unknown Movement'),14520,1)).toThrow('unparsed-rows');
  const empty = 'Beginning Balance as of 01/01/26 $100.00 $10.00 10.000\nNo transactions this period.\nEnding Balance as of 03/31/26 $120.00 $12.00 10.000';
  expect(checkSequoiaShares(empty,12000,0).status).toBe('passed');
  expect(() => checkSequoiaShares(empty.replace('No transactions this period.',''),12000,0)).toThrow('invalid-evidence');
});

test('Vanguard certifies only a bounded entirely empty activity table', () => {
  const empty='Completed transactions\n\nIf you had an adjustment';
  expect(checkVanguardEmptyActivity(empty,0).status).toBe('passed');
  expect(checkVanguardEmptyActivity('No recognized dates',0).status).toBe('unavailable');
  expect(checkVanguardEmptyActivity(empty.replace('\n\n','\nMalformed row\n'),0).status).toBe('unavailable');
  expect(() => checkVanguardEmptyActivity(empty,1)).toThrow('unparsed-rows');
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
