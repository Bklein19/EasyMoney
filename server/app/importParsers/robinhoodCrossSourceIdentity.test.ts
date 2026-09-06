import { expect, test } from 'bun:test';

import { robinhoodCreditCardCsvParser } from './easyMoneyCsvProfiles.ts';
import {
  robinhoodBankingCrossSourceIdentity,
  robinhoodCreditCrossSourceIdentity,
} from './robinhoodCrossSourceIdentity.ts';

test('Robinhood credit CSV imports only posted transactions', async () => {
  const headers = ['Date', 'Time', 'Cardholder', 'Amount', 'Points', 'Balance', 'Status', 'Type', 'Merchant', 'Description'];
  const row = (status: string, description: string) => ({
    Date: '2026-09-05',
    Time: '12:00:00',
    Cardholder: 'Example Person',
    Amount: '12.34',
    Points: '0',
    Balance: '0',
    Status: status,
    Type: 'Purchase',
    Merchant: 'Example Merchant',
    Description: description,
  });
  const parsed = await robinhoodCreditCardCsvParser.parse({
    fileName: 'robinhood.csv',
    headers,
    rows: [row('Posted', 'POSTED SHOP CA'), row('Pending', 'PENDING SHOP CA'), row('Declined', 'DECLINED SHOP CA')],
    text: '',
  });

  expect(parsed.transactions.map(transaction => transaction?.description ?? null)).toEqual([
    'POSTED SHOP CA',
    null,
    null,
  ]);
  expect(parsed.transactions[0]?.raw?.crossSourceIdentity).toBe('robinhood-credit:postedshopca');
});

test('Robinhood cross-source identities reconcile export formatting differences', () => {
  expect(robinhoodCreditCrossSourceIdentity('INSTACART.COM CA'))
    .toBe(robinhoodCreditCrossSourceIdentity('INSTACART.COMCA'));
  expect(robinhoodCreditCrossSourceIdentity('WL *STEAM PURCHASE 425-889- CREDIT'))
    .toBe(robinhoodCreditCrossSourceIdentity('WL *STEAM PURCHASE 425-889-9642 WA'));
  expect(robinhoodBankingCrossSourceIdentity('Internal Transfer from Checking'))
    .toBe(robinhoodBankingCrossSourceIdentity('Internal Transfer from Personal Checking'));
  expect(robinhoodBankingCrossSourceIdentity('Internal Transfer to Savings'))
    .toBe(robinhoodBankingCrossSourceIdentity('Internal Transfer to Joint Savings with Example'));
});
