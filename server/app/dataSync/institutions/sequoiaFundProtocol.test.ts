import { describe, expect, test } from 'bun:test';

import {
  parseSequoiaFundHistoryResponse,
  parseSequoiaFundPortfolio,
  sequoiaFundActivityExportFields,
  sequoiaFundActivityWindow,
  sequoiaFundHistoryFields,
} from './sequoiaFundProtocol.ts';

function portfolioAccount(overrides: Record<string, unknown> = {}) {
  return {
    fundAccountNumber: 'opaque-account',
    fundAcctNumbMasked: 'masked-account',
    fundSecIssueId: 'opaque-security',
    fund: {
      fundIdNumStripLeadingZeros: 'opaque-fund',
      fundName: 'Fixture Fund',
    },
    ...overrides,
  };
}

describe('Sequoia Fund portfolio protocol', () => {
  test('parses the one login-level group and preserves opaque values', () => {
    const parsed = parseSequoiaFundPortfolio({
      portfolioGroupList: [{
        groupKey: '  opaque group key  ',
        registration: ['Fixture registration', 'Secondary line'],
        accountList: [portfolioAccount({
          fundAccountNumber: '00001234',
          fundAcctNumbMasked: 'XX 1234',
          fundSecIssueId: ' security/id ',
          fund: {
            fundIdNumStripLeadingZeros: '0007',
            fundName: ' Fixture Fund ',
          },
        })],
      }],
    });

    expect(parsed).toEqual({
      groupKey: '  opaque group key  ',
      registration: ['Fixture registration', 'Secondary line'],
      accountList: [{
        fundAccountNumber: '00001234',
        fundAcctNumbMasked: 'XX 1234',
        fundSecIssueId: ' security/id ',
        fund: {
          fundIdNumStripLeadingZeros: '0007',
          fundName: ' Fixture Fund ',
        },
      }],
    });
  });

  test('handles record-shaped group and account collections and finite numeric identifiers', () => {
    expect(parseSequoiaFundPortfolio({
      portfolioGroupList: {
        primary: {
          groupKey: 17,
          accountList: {
            first: portfolioAccount({
              fundAccountNumber: 101,
              fundAcctNumbMasked: 202,
              fundSecIssueId: 303,
              fund: {
                fundIdNumStripLeadingZeros: 404,
                fundName: 'Fixture Fund',
              },
            }),
          },
        },
      },
    })).toEqual({
      groupKey: '17',
      registration: [],
      accountList: [{
        fundAccountNumber: '101',
        fundAcctNumbMasked: '202',
        fundSecIssueId: '303',
        fund: {
          fundIdNumStripLeadingZeros: '404',
          fundName: 'Fixture Fund',
        },
      }],
    });
  });

  test('requires exactly one group and at least one structurally valid account', () => {
    expect(() => parseSequoiaFundPortfolio({ portfolioGroupList: [] })).toThrow(
      'exactly one portfolio group',
    );
    expect(() => parseSequoiaFundPortfolio({
      portfolioGroupList: [{ groupKey: 'group-a', accountList: [] }],
    })).toThrow('has no accounts');
    expect(() => parseSequoiaFundPortfolio({
      portfolioGroupList: [
        { groupKey: 'group-a', accountList: [portfolioAccount()] },
        { groupKey: 'group-b', accountList: [portfolioAccount()] },
      ],
    })).toThrow('exactly one portfolio group');
    expect(() => parseSequoiaFundPortfolio({
      portfolioGroupList: [{
        groupKey: 'group-a',
        registration: ['valid', 2],
        accountList: [portfolioAccount()],
      }],
    })).toThrow('registration is invalid');
    expect(() => parseSequoiaFundPortfolio({
      portfolioGroupList: [{
        groupKey: 'group-a',
        accountList: [portfolioAccount({ fundSecIssueId: Number.POSITIVE_INFINITY })],
      }],
    })).toThrow('security identifier is invalid');
  });
});

describe('Sequoia Fund activity protocol', () => {
  test('uses the exact three-month preset with compact requested dates', () => {
    expect(sequoiaFundActivityWindow('2026-05-28', '2026-08-28')).toEqual({
      range: '90',
      startDate: '20260528',
      endDate: '20260828',
    });
  });

  test('uses custom compact dates beyond three months through six months', () => {
    expect(sequoiaFundActivityWindow('2026-05-27', '2026-08-28')).toEqual({
      range: '',
      startDate: '20260527',
      endDate: '20260828',
    });
    expect(sequoiaFundActivityWindow('2026-02-28', '2026-08-28')).toEqual({
      range: '',
      startDate: '20260228',
      endDate: '20260828',
    });
  });

  test('uses the prior-year and all-history presets with blank dates', () => {
    expect(sequoiaFundActivityWindow('2026-02-27', '2026-08-28')).toEqual({
      range: 'PRIOR12',
      startDate: '',
      endDate: '',
    });
    expect(sequoiaFundActivityWindow('2025-08-28', '2026-08-28')).toEqual({
      range: 'PRIOR12',
      startDate: '',
      endDate: '',
    });
    expect(sequoiaFundActivityWindow('2025-08-27', '2026-08-28')).toEqual({
      range: 'ALL',
      startDate: '',
      endDate: '',
    });
  });

  test('clamps calendar-month boundaries and rejects invalid windows', () => {
    expect(sequoiaFundActivityWindow('2026-02-28', '2026-05-31').range).toBe('90');
    expect(() => sequoiaFundActivityWindow('2026-02-30', '2026-08-28')).toThrow(
      'must be a valid date',
    );
    expect(() => sequoiaFundActivityWindow('2026-08-29', '2026-08-28')).toThrow(
      'must not be after',
    );
  });

  test('builds exact aggregate history fields', () => {
    const window = sequoiaFundActivityWindow('2026-05-28', '2026-08-28');
    expect(sequoiaFundHistoryFields('opaque-group', window)).toEqual({
      acctNumber: '',
      customFormField_MaxReturnCount: '',
      endDate: '20260828',
      groupKey: 'opaque-group',
      range: '90',
      requestCode: 'H',
      securityID: '',
      startDate: '20260528',
    });
  });

  test('preserves optional export defaults while enforcing aggregate CSV fields', () => {
    const history = sequoiaFundHistoryFields(
      'opaque-group',
      sequoiaFundActivityWindow('2025-01-01', '2026-08-28'),
    );
    expect(sequoiaFundActivityExportFields(history, {
      csrf_token: 'opaque-csrf',
      requestCode: 'wrong',
      customFormField_transType: 'wrong',
    })).toEqual({
      csrf_token: 'opaque-csrf',
      acctNumber: '',
      customFormField_MaxReturnCount: '',
      endDate: '',
      groupKey: 'opaque-group',
      range: 'ALL',
      requestCode: 'H',
      securityID: '',
      startDate: '',
      customFormField_fundName: '',
      customFormField_requestCode: 'H',
      customFormField_transType: 'all',
      eventLinkTypeId: '',
    });
  });

  test('mirrors the site by leaving CSV dates blank after establishing dated history state', () => {
    const history = sequoiaFundHistoryFields(
      'opaque-group',
      sequoiaFundActivityWindow('2026-05-28', '2026-08-28'),
    );
    expect(history).toMatchObject({ startDate: '20260528', endDate: '20260828' });
    expect(sequoiaFundActivityExportFields(history)).toMatchObject({
      startDate: '',
      endDate: '',
      range: '90',
    });
  });

  test('validates history response shape and returns only the record count', () => {
    expect(parseSequoiaFundHistoryResponse({
      data: { portHistList: [{ opaque: 'not returned' }, { opaque: 'also not returned' }] },
    })).toBe(2);
    expect(parseSequoiaFundHistoryResponse({ data: { portHistList: [] } })).toBe(0);
    expect(() => parseSequoiaFundHistoryResponse({ data: { portHistList: {} } })).toThrow(
      'records are invalid',
    );
    expect(() => parseSequoiaFundHistoryResponse({ portHistList: [] })).toThrow(
      'response data is invalid',
    );
  });
});
