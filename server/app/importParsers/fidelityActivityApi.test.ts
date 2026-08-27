import { describe, expect, test } from 'bun:test';

import { fidelityRetailActivityRemoteAccountId } from './fidelityAccountIdentity.ts';
import {
  fidelityActivityApiParser,
  parseFidelityActivityApi,
} from './fidelityActivityApi.ts';
import { IMPORT_PARSERS, resolveImportParser } from './index.ts';

function epoch(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`) / 1_000;
}

function parseArtifact(value: unknown, fileName = 'fidelity-retail-example-activity-2026-08-01-to-2026-08-31.json') {
  return parseFidelityActivityApi({
    fileName,
    headers: [],
    rows: [],
    text: JSON.stringify(value),
  });
}

function brokerageTransaction(overrides: Record<string, unknown> = {}) {
  return {
    acctNum: 'Z00-000000',
    date: epoch('2026-08-20'),
    amtDetail: { net: 12.345 },
    description: '  DIVIDEND   RECEIVED  ',
    catDetail: { txnTypeDesc: 'Dividend' },
    securityDetail: { desc: 'Example Fund', symbol: 'EXMPL' },
    quantity: '1.25',
    txnNum: 'example-transaction',
    ...overrides,
  };
}

function retirementTransaction(overrides: Record<string, unknown> = {}) {
  return {
    acctNum: '12345',
    date: epoch('2026-08-21'),
    amtDetail: { net: 1_200.45 },
    description: 'Contribution',
    catDetail: { txnCatDesc: 'Employee contribution' },
    dcDetails: [
      { fundDetail: { longName: 'Example Index Fund' } },
      { fundDetail: { longName: 'Example Bond Fund' } },
      { fundDetail: { longName: 'Example Index Fund' } },
    ],
    ...overrides,
  };
}

describe('Fidelity retail activity account identities', () => {
  test('normalizes full brokerage identities and namespaces five-digit retirement tokens', () => {
    expect(fidelityRetailActivityRemoteAccountId('Z00-000000')).toBe('fidelity:Z00000000');
    expect(fidelityRetailActivityRemoteAccountId('Z00000000')).toBe('fidelity:Z00000000');
    expect(fidelityRetailActivityRemoteAccountId('123-456789')).toBe('fidelity:123456789');
    expect(fidelityRetailActivityRemoteAccountId('  12345  ')).toBe('fidelity:retail-token:12345');
  });

  test.each([
    '',
    '1234',
    '123456',
    'ending in 1234',
    'Account Z00-000000',
    'Z00-000000 extra',
    'prefix Z00-000000 suffix',
    'not-an-account',
  ])('rejects invalid activity account identity %p', value => {
    expect(fidelityRetailActivityRemoteAccountId(value)).toBeNull();
  });
});

describe('Fidelity activity API parser', () => {
  test('parses brokerage facts with exact identity, UTC date, rounded amount, and metadata', () => {
    const result = parseArtifact({
      errors: [],
      data: { transactions: [brokerageTransaction()] },
    });

    expect(result).toMatchObject({
      coveredFrom: '2026-08-20',
      coveredTo: '2026-08-20',
      balances: [],
      transactions: [{
        sourceRowIndex: 0,
        date: '2026-08-20T00:00:00.000Z',
        amountCents: 1235,
        description: 'DIVIDEND RECEIVED',
        institution: 'Fidelity',
        account: 'Fidelity account ending in 0000',
        remoteAccountId: 'fidelity:Z00000000',
        sourceRole: 'activity',
        raw: {
          source: 'fidelity-activity-api-json',
          transactionNumber: 'example-transaction',
          transactionType: 'Dividend',
          securityDescription: 'Example Fund',
          symbol: 'EXMPL',
          quantity: '1.25',
        },
      }],
    });
  });

  test('parses five-digit retirement facts with category and unique fund names', () => {
    const result = parseArtifact({
      data: { transactions: [retirementTransaction()] },
    });

    expect(result).toMatchObject({
      coveredFrom: '2026-08-21',
      coveredTo: '2026-08-21',
      transactions: [{
        sourceRowIndex: 0,
        date: '2026-08-21T00:00:00.000Z',
        amountCents: 120045,
        description: 'Employee contribution: Contribution: Example Index Fund: Example Bond Fund',
        account: 'Fidelity retirement plan 12345',
        remoteAccountId: 'fidelity:retail-token:12345',
        sourceRole: 'activity',
      }],
    });
  });

  test('keeps source row indexes and coverage while omitting zero-net facts', () => {
    const result = parseArtifact({
      data: {
        transactions: [
          brokerageTransaction({
            date: epoch('2026-08-19'),
            amtDetail: { net: 0 },
            description: 'No cash movement',
          }),
          brokerageTransaction({
            date: epoch('2026-08-22'),
            amtDetail: { net: -3.5 },
            description: 'Fee',
          }),
        ],
      },
    });

    expect(result.transactions).toEqual([
      null,
      expect.objectContaining({
        sourceRowIndex: 1,
        amountCents: -350,
        date: '2026-08-22T00:00:00.000Z',
      }),
    ]);
    expect(result.coveredFrom).toBe('2026-08-19');
    expect(result.coveredTo).toBe('2026-08-22');
  });

  test('accepts an empty successful response without inventing identity or coverage', () => {
    expect(parseArtifact({ errors: [], data: { transactions: [] } })).toEqual({
      transactions: [],
      balances: [],
      coveredFrom: null,
      coveredTo: null,
    });
  });

  test.each([
    {
      name: 'malformed JSON',
      text: '{',
      message: 'not valid JSON',
    },
    {
      name: 'reported API errors',
      text: JSON.stringify({ errors: [{ code: 'EXAMPLE' }], data: { transactions: [] } }),
      message: 'contains errors',
    },
    {
      name: 'missing transactions array',
      text: JSON.stringify({ errors: [], data: {} }),
      message: 'missing transactions',
    },
  ])('rejects $name', ({ text, message }) => {
    expect(() => parseFidelityActivityApi({
      fileName: 'fidelity-retail-example-activity-2026-08-01-to-2026-08-31.json',
      headers: [],
      rows: [],
      text,
    })).toThrow(message);
  });

  test.each([
    {
      name: 'missing account identity',
      transaction: brokerageTransaction({ acctNum: undefined }),
      message: 'transaction account is invalid',
    },
    {
      name: 'invalid account identity',
      transaction: brokerageTransaction({ acctNum: '1234' }),
      message: 'transaction account is invalid',
    },
    {
      name: 'non-numeric amount',
      transaction: brokerageTransaction({ amtDetail: { net: '12.34' } }),
      message: 'account or amount is invalid',
    },
    {
      name: 'missing amount detail',
      transaction: brokerageTransaction({ amtDetail: undefined }),
      message: 'account or amount is invalid',
    },
    {
      name: 'fractional epoch',
      transaction: brokerageTransaction({ date: epoch('2026-08-20') + 0.5 }),
      message: 'date is invalid',
    },
    {
      name: 'epoch before supported range',
      transaction: brokerageTransaction({ date: 946_684_799 }),
      message: 'date is invalid',
    },
    {
      name: 'epoch after supported range',
      transaction: brokerageTransaction({ date: 4_102_444_801 }),
      message: 'date is invalid',
    },
  ])('rejects a transaction with $name', ({ transaction, message }) => {
    expect(() => parseArtifact({ data: { transactions: [transaction] } })).toThrow(message);
  });

  test('rejects non-finite JSON numbers', () => {
    const text = JSON.stringify({
      data: { transactions: [brokerageTransaction()] },
    }).replace('12.345', '1e400');

    expect(() => parseFidelityActivityApi({
      fileName: 'fidelity-retail-example-activity-2026-08-01-to-2026-08-31.json',
      headers: [],
      rows: [],
      text,
    })).toThrow('account or amount is invalid');
  });

  test('rejects mixed brokerage and retirement account identities', () => {
    expect(() => parseArtifact({
      data: { transactions: [brokerageTransaction(), retirementTransaction()] },
    })).toThrow('response contains multiple accounts');
  });
});

describe('Fidelity activity API matcher and registry', () => {
  const fileName = 'fidelity-retail-example-activity-2026-08-01-to-2026-08-31.json';
  const sample = JSON.stringify({ data: { transactions: [brokerageTransaction()] } });

  test('requires both the generated JSON filename and structural response shape', () => {
    expect(fidelityActivityApiParser.matches({ fileName, headers: [], sample })).toBe(true);
    expect(fidelityActivityApiParser.matches({
      fileName: 'renamed.json',
      headers: [],
      sample,
    })).toBe(false);
    expect(fidelityActivityApiParser.matches({
      fileName,
      headers: [],
      sample: JSON.stringify({ data: {} }),
    })).toBe(false);
    expect(fidelityActivityApiParser.matches({ fileName, headers: [], sample: '{' })).toBe(false);
  });

  test('recognizes a structurally complete prefix when the parser sample truncates large JSON', () => {
    const largeArtifact = JSON.stringify({
      errors: [],
      data: {
        transactions: [brokerageTransaction({ description: `Example ${'detail '.repeat(1_000)}` })],
      },
    });
    const truncatedSample = largeArtifact.slice(0, 4_096);

    expect(largeArtifact.length).toBeGreaterThan(4_096);
    expect(() => JSON.parse(truncatedSample)).toThrow();
    expect(fidelityActivityApiParser.matches({ fileName, headers: [], sample: truncatedSample })).toBe(true);
    expect(resolveImportParser({ fileName, headers: [], sample: truncatedSample })?.id)
      .toBe('fidelity-activity-api-json');
  });

  test('is the sole registry match for plain and stored artifact filenames', () => {
    for (const candidate of [fileName, `${'a'.repeat(64)}-${fileName}`]) {
      const file = { fileName: candidate, headers: [], sample };
      expect(IMPORT_PARSERS.filter(parser => parser.matches({
        ...file,
        fileName: candidate.replace(/^[0-9a-f]{64}-/, ''),
      })).map(parser => parser.id)).toEqual(['fidelity-activity-api-json']);
      expect(resolveImportParser(file)?.id).toBe('fidelity-activity-api-json');
    }
  });
});
