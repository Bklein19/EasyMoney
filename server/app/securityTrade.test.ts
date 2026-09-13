import { expect, test } from 'bun:test';
import { readSecurityTrade } from './securityTrade';
import { parseVanguardActivityCsv } from './importParsers/vanguardActivityCsv';
import { parseVanguardStatementText } from './importParsers/moneyParsers/vanguard-statement-pdf';

const headers = 'Account Number,Trade Date,Settlement Date,Transaction Type,Transaction Description,Investment Name,Symbol,Shares,Share Price,Principal Amount,Commissions and Fees,Net Amount,Accrued Interest,Account Type';
test('Vanguard parsers expose identical structured trade evidence and preserve snapshot dates', () => {
  const csv = parseVanguardActivityCsv({fileName:'activity.csv',headers:[],rows:[],text:`${headers}\n12345678,2025-12-31,2026-01-02,Buy,Buy,EXAMPLE FUND,TEST,2.50000,40,-100,0,-100,0,CASH`});
  const pdf = parseVanguardStatementText('January 31, 2026, monthly transaction statement\nIndividual brokerage account—XXXX5678\nIndividual brokerage account $0.00 $100.00\nCompleted transactions\n01/02 12/31 TEST EXAMPLE FUND Buy Cash 2.5000 40.00 0.00 -100.00');
  expect(csv.transactions[0]?.date).toBe('2025-12-31');
  expect(pdf.transactions[0]?.date).toBe('2025-12-31');
  expect(pdf.transactions[0]?.raw.securityTrade).toEqual(csv.transactions[0]?.raw?.securityTrade);
  expect(pdf.transactions[0]?.raw.securityTrade).toEqual({tradeDate:'2025-12-31',settlementDate:'2026-01-02',symbol:'TEST',quantity:'2.5',action:'buy'});
  expect(pdf.balances[0]?.date).toBe('2026-01-31');
});

test('non-trade statement rows retain settlement date and have no invented trade identity', () => {
  const pdf = parseVanguardStatementText('January 31, 2026, monthly transaction statement\nCompleted transactions\n01/03 01/02 CASH Dividend Cash 0.0000 0.00 0.00 10.00');
  expect(pdf.transactions[0]?.date).toBe('2026-01-03');
  expect(pdf.transactions[0]?.raw.securityTrade).toBeUndefined();
});

test('structured trade validation rejects invalid dates, incomplete identities and zero quantities', () => {
  const good={tradeDate:'2026-01-02',settlementDate:'2026-01-05',symbol:'test',quantity:'002.5000',action:'buy'};
  expect(readSecurityTrade(good)?.quantity).toBe('2.5');
  for (const invalid of [{tradeDate:'2026-02-30'},{settlementDate:'2026-01-01'},{quantity:'0.000'},{symbol:''},{action:'dividend'}]) expect(readSecurityTrade({...good,...invalid})).toBeNull();
});
