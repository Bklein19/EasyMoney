import { expect, test } from 'bun:test';
import { resolveImportParser } from './index.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

test('money parser adapter translates money activity output to app import output', async () => {
  const parser = createMoneyParserAdapter({
    name: 'Test Money Parser',
    meta: {
      id: 'test-money-parser',
      institution: 'Vanguard',
      kind: 'activity-export',
      priority: 100,
      matches: ({ filename }) => filename === 'activity.pdf',
    },
    parseMoneyFile: async filePath => {
      expect(filePath).toBe('/tmp/activity.pdf');
      return {
        covered_from: '2026-06-01',
        covered_to: '2026-06-30',
        transactions: [
          {
            id: 'tx-1',
            date: '2026-06-14',
            amount_cents: -50000,
            description: 'Buy VTI',
            account: 'Brokerage-XXXX1234',
            institution: 'Vanguard',
            category: 'activity',
            raw: { row: 'raw activity row' },
          },
          {
            id: 'tx-2',
            date: '2026-06-20',
            amount_cents: 100000,
            description: 'Transfer of assets',
            account: 'Brokerage-XXXX1234',
            institution: 'Vanguard',
            category: 'in-kind-transfer',
            raw: { row: 'raw transfer row' },
          },
        ],
        balances: [
          {
            date: '2026-06-30',
            account: 'Brokerage-XXXX1234',
            institution: 'Vanguard',
            balance_cents: 1842000,
          },
        ],
      };
    },
  });

  expect(parser.matches({ fileName: 'activity.pdf', headers: [], sample: '' })).toBe(true);
  const result = await parser.parse({
    fileName: 'activity.pdf',
    headers: [],
    rows: [],
    text: '',
    filePath: '/tmp/activity.pdf',
  });

  expect(result.transactions).toEqual([
    {
      sourceRowIndex: 0,
      date: '2026-06-14',
      amountCents: -50000,
      description: 'Buy VTI',
      institution: 'Vanguard',
      account: 'Brokerage-XXXX1234',
      sourceRole: 'activity',
      raw: {
        moneyId: 'tx-1',
        moneyCategory: 'activity',
        row: 'raw activity row',
      },
    },
    {
      sourceRowIndex: 1,
      date: '2026-06-20',
      amountCents: 100000,
      description: 'Transfer of assets',
      institution: 'Vanguard',
      account: 'Brokerage-XXXX1234',
      sourceRole: 'statement-only',
      raw: {
        moneyId: 'tx-2',
        moneyCategory: 'in-kind-transfer',
        row: 'raw transfer row',
      },
    },
  ]);
  expect(result.balances).toEqual([
    {
      sourceRowIndex: 0,
      date: '2026-06-30',
      balanceCents: 1842000,
      institution: 'Vanguard',
      account: 'Brokerage-XXXX1234',
      raw: {},
    },
  ]);
});

test('import parser registry resolves Vanguard activity PDFs', () => {
  const parser = resolveImportParser({
    fileName: 'vanguard-1234-2026-01-01-to-2026-06-30-transaction-history.pdf',
    headers: [],
    sample: '',
  });

  expect(parser?.id).toBe('vanguard-activity-pdf');
  expect(parser?.sourceType).toBe('activity-export');
  expect(parser?.priority).toBe(100);
});
