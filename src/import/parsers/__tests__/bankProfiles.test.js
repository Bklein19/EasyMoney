import { describe, expect, test } from 'bun:test';
import { BANK_PROFILES } from '../index';
import { detectBank, normalizeTransaction } from '../../../utils/bankProfiles';

describe('bank import parser profiles', () => {
  test('keeps institution profile definitions outside generic bank profile utilities', () => {
    expect(BANK_PROFILES.map(profile => profile.name)).toEqual([
      'Chase Credit Card',
      'Wells Fargo Checking',
      'Wells Fargo Credit Card',
      'Wells Fargo',
      'Bank of America',
      'Robinhood Credit Card',
      'American Express Credit Card',
      'Apple Card',
      'Capital One',
      'Citi',
    ]);
  });

  test.each([
    ['Chase Credit Card', ['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount'], 'chase.csv'],
    ['Wells Fargo Checking', ['Date', 'Description', 'Amount', 'CheckNumber', 'Status'], 'wells.csv'],
    ['Wells Fargo Credit Card', ['DATE', 'DESCRIPTION', 'AMOUNT', 'CHECK #', 'STATUS'], 'wells-card.csv'],
    ['Wells Fargo', ['Date', 'Description', 'Deposits', 'Withdrawals'], 'wells-split.csv'],
    ['Bank of America', ['Date', 'Description', 'Amount', 'Running Bal.'], 'bofa.csv'],
    ['Robinhood Credit Card', ['Date', 'Time', 'Cardholder', 'Amount', 'Points', 'Balance', 'Status', 'Type', 'Merchant', 'Description'], 'robinhood.csv'],
    ['American Express Credit Card', ['Date', 'Description', 'Amount'], 'amex.csv'],
    ['Apple Card', ['Transaction Date', 'Clearing Date', 'Description', 'Merchant', 'Category', 'Type', 'Amount (USD)', 'Purchased By'], 'apple-card.csv'],
    ['Capital One', ['Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit'], 'capital-one.csv'],
    ['Citi', ['Status', 'Date', 'Description', 'Debit', 'Credit'], 'citi.csv'],
  ])('detects %s from its parser fingerprint', (expectedName, headers, fileName) => {
    expect(detectBank(headers, fileName)?.name).toBe(expectedName);
  });

  test('requires filename evidence for ambiguous American Express headers', () => {
    expect(detectBank(['Date', 'Description', 'Amount'], 'generic.csv')?.name).not.toBe('American Express Credit Card');
    expect(detectBank(['Date', 'Description', 'Amount'], 'american express activity.csv')?.name).toBe('American Express Credit Card');
  });

  test('normalizes card charges using parser-specific amount semantics', () => {
    const robinhood = BANK_PROFILES.find(profile => profile.name === 'Robinhood Credit Card');

    expect(normalizeTransaction({
      Date: '2026-01-12',
      Description: 'CARD PURCHASE',
      Merchant: 'Coffee Shop',
      Amount: '9.50',
    }, robinhood)).toMatchObject({
      amount: -9.5,
      merchant: 'Coffee Shop',
      type: 'debit',
    });
  });
});
