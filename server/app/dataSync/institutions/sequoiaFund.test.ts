import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sequoiaFundActivityParser } from '../../importParsers/sequoiaFundActivity.ts';
import {
  meta as sequoiaFundStatementMeta,
  sequoiaFundStatementAccount,
} from '../../importParsers/moneyParsers/sequoia-fund-pdf.ts';
import {
  classifySequoiaFundArtifactBytes,
  parseSequoiaFundActivityCsvRequest,
  parseSequoiaFundHistoryRequest,
  parseSequoiaFundStatementList,
  populateSequoiaFundActivityForm,
  safeSequoiaFundErrorMessage,
  selectAllSequoiaFundTransactions,
  selectSequoiaFundActivityExportSubmitter,
  selectSequoiaFundDuration,
  sequoiaFundAccountsFromOptions,
  sequoiaFundLoginAccountFromOptions,
  sequoiaFundActivityAccountCrosswalk,
  sequoiaFundActivityFilterRequestMatches,
  sequoiaFundActivityResponseMetadataAccepted,
  sequoiaFundActivityRequest,
  sequoiaFundBrowserSession,
  sequoiaFundHistoryAccountIdentity,
  selectSequoiaFundActivityExportForm,
  sequoiaFundStatementJobs,
  validateSequoiaFundArtifact,
  type SequoiaFundActivityForm,
  type SequoiaFundActivityFormCandidate,
} from './sequoiaFund.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function activityForm(
  action: string,
  method: SequoiaFundActivityForm['method'] = 'POST',
  enctype = 'application/x-www-form-urlencoded',
): SequoiaFundActivityForm {
  return {
    action,
    method,
    enctype,
    fields: {
      groupKey: 'fixture-group',
      securityID: 'fixture-security',
      acctNumber: 'fixture-account',
      startDate: '2026-01-01',
      endDate: '2026-08-23',
    },
  };
}

function observedHistory(groupKey: string, requestCode = 'fixture-request'): Record<string, string> {
  return {
    acctNumber: '',
    customFormField_MaxReturnCount: '',
    endDate: '',
    groupKey,
    range: 'fixture-range',
    requestCode,
    securityID: '',
    startDate: '',
  };
}

function blankObservedExportForm(): SequoiaFundActivityFormCandidate {
  return {
    action: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionHistoryCSV',
    method: 'POST',
    enctype: 'application/x-www-form-urlencoded',
    fields: {
      acctNumber: '',
      customFormField_MaxReturnCount: '',
      endDate: '',
      groupKey: '',
      range: '',
      requestCode: '',
      securityID: '',
      startDate: '',
      customFormField_fundName: '',
      customFormField_requestCode: '',
      customFormField_transType: '',
      eventLinkTypeId: '',
    },
    hints: ['transactionHistoryCSV'],
  };
}

describe('Sequoia Fund account and request discovery', () => {
  test('discovers every account and deduplicates responsive copies without assuming a count', () => {
    const accounts = sequoiaFundAccountsFromOptions([
      { label: 'All fund accounts', value: 'all-funds' },
      { label: 'Investment account ending 1111', value: 'remote-a' },
      { label: 'Investment account ending 2222', value: 'remote-b' },
      { label: 'Investment account ending 3333', value: 'remote-c' },
      { label: 'Investment account ending 1111', value: 'remote-a' },
    ]);

    expect(accounts.map(account => account.accountToken)).toEqual([
      'last4-1111',
      'last4-2222',
      'last4-3333',
    ]);
    expect(accounts.map(account => account.accountName)).toEqual([
      'Sequoia Fund - 1111',
      'Sequoia Fund - 2222',
      'Sequoia Fund - 3333',
    ]);
  });

  test('treats the all-accounts option as a placeholder and requires one real account per login', () => {
    expect(sequoiaFundLoginAccountFromOptions([
      { label: 'All fund accounts', value: 'all-funds' },
      { label: 'Investment account ending 1111', value: 'remote-a' },
    ])).toMatchObject({ accountToken: 'last4-1111', value: 'remote-a' });

    expect(() => sequoiaFundLoginAccountFromOptions([
      { label: 'Investment account ending 1111', value: 'remote-a' },
      { label: 'Investment account ending 2222', value: 'remote-b' },
    ])).toThrow('exactly one investment account');
  });

  test('uses a stable opaque token when the site does not expose last four digits', () => {
    const first = sequoiaFundAccountsFromOptions([{ label: 'Investment account', value: 'opaque-account-a' }]);
    const second = sequoiaFundAccountsFromOptions([{ label: 'Investment account', value: 'opaque-account-a' }]);

    expect(first[0]?.accountToken).toMatch(/^key-[a-f0-9]{12}$/);
    expect(second[0]?.accountToken).toBe(first[0]?.accountToken);
  });

  test('rejects duplicate account identities instead of mixing artifacts', () => {
    expect(() => sequoiaFundAccountsFromOptions([
      { label: 'Investment account ending 1111', value: 'remote-a' },
      { label: 'Second investment account ending 1111', value: 'remote-b' },
    ])).toThrow('ambiguous account identities');
  });

  test('chooses the smallest discovered duration that covers the requested range', () => {
    const options = [
      { label: 'Prior 30 days', value: '30d' },
      { label: 'Prior 3 months', value: '3m' },
      { label: 'Prior 12 months', value: '12m' },
      { label: 'All available history', value: 'all' },
    ];
    const today = new Date('2026-08-23T12:00:00Z');

    expect(selectSequoiaFundDuration(options, '2026-03-01', today).value).toBe('12m');
    expect(selectSequoiaFundDuration(options, '2020-01-01', today).value).toBe('all');
    expect(selectAllSequoiaFundTransactions([
      { label: 'Purchases', value: 'purchases' },
      { label: 'All transaction types', value: 'all-types' },
    ]).value).toBe('all-types');
  });

  test('selects the dynamically discovered export form instead of the visible filter form', () => {
    const candidates: SequoiaFundActivityFormCandidate[] = [
      {
        action: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionhistory',
        method: 'GET',
        enctype: 'application/x-www-form-urlencoded',
        fields: { duration: '12m' },
        hints: ['transactionHistoryOptions'],
      },
      {
        action: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionHistoryCSV',
        method: 'POST',
        enctype: 'application/x-www-form-urlencoded',
        fields: { groupKey: 'fixture-group' },
        hints: ['port-history-csv'],
      },
      {
        action: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/posttaxltdetailsCSV',
        method: 'POST',
        enctype: 'application/x-www-form-urlencoded',
        fields: { securityID: 'fixture-security' },
        hints: ['taxlot-history-csv'],
      },
    ];

    expect(selectSequoiaFundActivityExportForm(
      candidates,
      'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionhistory',
    )).toMatchObject({
      action: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionHistoryCSV',
      method: 'POST',
    });
  });

  test('encodes a dynamically discovered same-origin GET action as query parameters', () => {
    const request = sequoiaFundActivityRequest(
      activityForm(
        'https://secureaccountview.com/BFWeb/clients/sequoiafund/export-current-history?stale=ignored',
        'GET',
      ),
      'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionhistory',
    );

    expect(request).toEqual({
      url: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/export-current-history?groupKey=fixture-group&securityID=fixture-security&acctNumber=fixture-account&startDate=2026-01-01&endDate=2026-08-23',
      method: 'GET',
      headers: { Referer: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionhistory' },
    });
  });

  test('encodes a dynamically discovered same-origin POST action using its form encoding', () => {
    const request = sequoiaFundActivityRequest(
      activityForm('https://secureaccountview.com/BFWeb/clients/sequoiafund/export-current-history'),
      'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionhistory',
    );

    expect(request).toEqual({
      url: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/export-current-history',
      method: 'POST',
      headers: { Referer: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionhistory' },
      form: {
        groupKey: 'fixture-group',
        securityID: 'fixture-security',
        acctNumber: 'fixture-account',
        startDate: '2026-01-01',
        endDate: '2026-08-23',
      },
    });
    expect(() => sequoiaFundActivityRequest(
      activityForm('https://example.test/BFWeb/clients/sequoiafund/export'),
      'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionhistory',
    )).toThrow('same-origin');
  });

  test('crosswalks populated history fields into the blank export form and applies the requested range', () => {
    const populated = populateSequoiaFundActivityForm({
      ...blankObservedExportForm(),
      fields: { ...blankObservedExportForm().fields, exportType: 'csv' },
    }, {
      groupKey: 'fixture-group-b',
      securityID: 'fixture-security-b',
      acctNumber: 'fixture-account-b',
      customFormField_MaxReturnCount: '500',
      range: 'fixture-range',
      requestCode: 'fixture-request',
      startDate: '01/01/2025',
      endDate: '08/27/2026',
    }, '2026-03-01', '2026-08-27');

    expect(populated.fields).toEqual({
      groupKey: 'fixture-group-b',
      securityID: 'fixture-security-b',
      acctNumber: 'fixture-account-b',
      customFormField_MaxReturnCount: '500',
      range: 'fixture-range',
      requestCode: 'fixture-request',
      startDate: '03/01/2026',
      endDate: '08/27/2026',
      customFormField_fundName: '',
      customFormField_requestCode: '',
      customFormField_transType: '',
      eventLinkTypeId: '',
      exportType: 'csv',
    });
  });

  test('preserves legitimate blank optional history fields while requiring server-issued account state', () => {
    const populated = populateSequoiaFundActivityForm(
      blankObservedExportForm(),
      observedHistory('fixture-group'),
      '2026-01-01',
      '2026-08-27',
    );

    expect(populated.fields).toMatchObject({
      acctNumber: '',
      endDate: '',
      groupKey: 'fixture-group',
      range: 'fixture-range',
      requestCode: 'fixture-request',
      securityID: '',
      startDate: '',
    });
    expect(() => populateSequoiaFundActivityForm(
      blankObservedExportForm(),
      observedHistory(''),
      '2026-01-01',
      '2026-08-27',
    )).toThrow('account state is incomplete');
  });

  test('rejects a blank export form without the observed account crosswalk fields', () => {
    expect(() => populateSequoiaFundActivityForm({
      ...activityForm('https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionHistoryCSV'),
      fields: { groupKey: '' },
      hints: ['transactionHistoryCSV'],
    }, {
      groupKey: 'fixture-group',
      securityID: 'fixture-security',
      acctNumber: 'fixture-account',
      customFormField_MaxReturnCount: '500',
      range: 'fixture-range',
      requestCode: 'fixture-request',
      startDate: '2026-01-01',
      endDate: '2026-08-27',
    }, '2026-01-01', '2026-08-27')).toThrow('metadata is incomplete');
  });

  test('binds two filter selections to distinct stable server account state, not request nonces', () => {
    const first = observedHistory('fixture-group-a');
    const second = observedHistory('fixture-group-b');
    const crosswalk = sequoiaFundActivityAccountCrosswalk([
      { accountValue: 'fixture-account-a', historyFields: first },
      { accountValue: 'fixture-account-b', historyFields: second },
    ]);

    expect(crosswalk.changedFieldNames).toEqual(['groupKey']);
    expect(crosswalk.bindingFieldNames).toEqual(['groupKey']);
    expect(crosswalk.bindings.map(binding => binding.bindingIdentity)).toEqual([
      sequoiaFundHistoryAccountIdentity(first),
      sequoiaFundHistoryAccountIdentity(second),
    ]);
    expect(new Set(crosswalk.bindings.map(binding => binding.bindingIdentity)).size).toBe(2);

    expect(() => sequoiaFundActivityAccountCrosswalk([
      { accountValue: 'fixture-account-a', historyFields: observedHistory('fixture-shared', 'request-a') },
      { accountValue: 'fixture-account-b', historyFields: observedHistory('fixture-shared', 'request-b') },
    ])).toThrow('not one-to-one');
  });

  test('classifies the exact filter, history, and CSV request sequence without ordinal replay', () => {
    const filterOptions = {
      method: 'GET',
      accountField: 'fundAccount',
      accountValue: 'fixture-account-a',
      durationField: 'duration',
      durationValue: 'fixture-duration',
      transactionTypeField: 'transActionType',
      transactionTypeValue: 'fixture-type',
    };
    expect(sequoiaFundActivityFilterRequestMatches({
      ...filterOptions,
      url: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionhistory' +
        '?fundAccount=fixture-account-a&duration=fixture-duration&transActionType=fixture-type',
    })).toBe(true);
    expect(sequoiaFundActivityFilterRequestMatches({
      ...filterOptions,
      url: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionhistory' +
        '?fundAccount=fixture-account-b&duration=fixture-duration&transActionType=fixture-type',
    })).toBe(false);

    const firstHistory = observedHistory('fixture-group-a');
    const secondHistory = observedHistory('fixture-group-b');
    const historySnapshot = (fields: Record<string, string>) => ({
      url: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionhistoryJSON',
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      body: new URLSearchParams(fields).toString(),
    });
    expect(parseSequoiaFundHistoryRequest(historySnapshot(firstHistory))).toEqual(firstHistory);
    expect(parseSequoiaFundHistoryRequest(historySnapshot(secondHistory))).toEqual(secondHistory);
    expect(parseSequoiaFundHistoryRequest({
      ...historySnapshot(firstHistory),
      method: 'GET',
    })).toBeNull();
    expect(parseSequoiaFundHistoryRequest(historySnapshot({ ...firstHistory, groupKey: '' }))).toBeNull();

    const exportState = populateSequoiaFundActivityForm(
      blankObservedExportForm(),
      firstHistory,
      '2026-01-01',
      '2026-08-27',
    ).fields;
    const csvSnapshot = {
      url: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionHistoryCSV',
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: new URLSearchParams({ ...exportState, csrf_token: 'fixture-csrf' }).toString(),
    };
    expect(parseSequoiaFundActivityCsvRequest(csvSnapshot, exportState)).toMatchObject(exportState);
    expect(parseSequoiaFundActivityCsvRequest({
      ...csvSnapshot,
      body: new URLSearchParams({ ...exportState, groupKey: 'fixture-other' }).toString(),
    }, exportState)).toBeNull();
    expect(parseSequoiaFundActivityCsvRequest({
      ...csvSnapshot,
      body: new URLSearchParams({ ...exportState, eventLinkTypeId: 'fixture-other' }).toString(),
    }, exportState)).toBeNull();
    expect(parseSequoiaFundActivityCsvRequest({
      ...csvSnapshot,
      body: `${csvSnapshot.body}&groupKey=fixture-duplicate`,
    }, exportState)).toBeNull();
    expect(parseSequoiaFundActivityCsvRequest({
      ...csvSnapshot,
      url: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/unknown.csv',
    }, exportState)).toBeNull();
  });

  test('rejects a discovered export form with duplicate successful control names', () => {
    expect(() => selectSequoiaFundActivityExportForm([{
      ...blankObservedExportForm(),
      duplicateFieldNames: ['groupKey'],
    }], 'https://secureaccountview.com/BFWeb/clients/sequoiafund/transactionhistory')).toThrow(
      'duplicate fields',
    );
  });

  test('uses the unique observed export submitter and rejects ambiguous or overridden controls', () => {
    expect(selectSequoiaFundActivityExportSubmitter([])).toBeNull();
    expect(selectSequoiaFundActivityExportSubmitter([{
      index: 2,
      visible: true,
      disabled: false,
      exportSemantic: false,
      resetSemantic: false,
      hasFormOverride: false,
    }])).toBe(2);
    expect(selectSequoiaFundActivityExportSubmitter([
      {
        index: 0,
        visible: true,
        disabled: false,
        exportSemantic: false,
        resetSemantic: false,
        hasFormOverride: false,
      },
      {
        index: 1,
        visible: true,
        disabled: false,
        exportSemantic: true,
        resetSemantic: false,
        hasFormOverride: false,
      },
    ])).toBe(1);
    expect(() => selectSequoiaFundActivityExportSubmitter([
      {
        index: 0,
        visible: true,
        disabled: false,
        exportSemantic: true,
        resetSemantic: false,
        hasFormOverride: false,
      },
      {
        index: 1,
        visible: true,
        disabled: false,
        exportSemantic: true,
        resetSemantic: false,
        hasFormOverride: false,
      },
    ])).toThrow('ambiguous');
    expect(() => selectSequoiaFundActivityExportSubmitter([{
      index: 0,
      visible: true,
      disabled: false,
      exportSemantic: true,
      resetSemantic: false,
      hasFormOverride: true,
    }])).toThrow('overrides');
  });
});

describe('Sequoia Fund statement discovery', () => {
  test('expands every API document and maps each to one discovered account', () => {
    const accounts = sequoiaFundAccountsFromOptions([
      { label: 'Investment account ending 1111', value: 'remote-a' },
      { label: 'Investment account ending 2222', value: 'remote-b' },
    ]);
    const list = parseSequoiaFundStatementList({
      success: true,
      data: {
        sessionId: 'fixture-session',
        statements: [
          {
            documentId: 'document-a',
            statementType: 'quarterly',
            statementDate: '2026-03-31',
            fundAccount: 'Account ending 1111',
          },
          {
            documentId: 'document-b',
            statementType: 'quarterly',
            statementDate: '06/30/2026',
            accountDescription: 'Account ending 2222',
          },
          {
            documentId: 'outside-range',
            statementType: 'quarterly',
            statementDate: '2025-12-31',
            fundAccount: 'Account ending 1111',
          },
        ],
      },
    });
    const jobs = sequoiaFundStatementJobs(
      accounts,
      list,
      {
        csrfToken: null,
        links: [
          {
            rawTarget: '/BFWeb/clients/sequoiafund/statements/document-a/quarterly?token=fixture-a',
            context: 'Account ending 1111',
          },
          {
            rawTarget: '/BFWeb/clients/sequoiafund/statements/document-b/quarterly?token=fixture-b',
            context: 'Account ending 2222',
          },
        ],
      },
      'https://secureaccountview.com/BFWeb/clients/sequoiafund/viewStatements',
      '2026-01-01',
      '2026-12-31',
    );

    expect(jobs).toHaveLength(2);
    expect(jobs.map(job => job.account.accountToken).sort()).toEqual(['last4-1111', 'last4-2222']);
    expect(jobs.every(job => job.request.method === 'GET')).toBe(true);
    expect(jobs.every(job => job.request.url.startsWith(
      'https://secureaccountview.com/BFWeb/clients/sequoiafund/statements/',
    ))).toBe(true);
    expect(jobs.every(job => /^sequoia-fund-account-last4-\d{4}-\d{4}-\d{2}-\d{2}-statement-[a-f0-9]{10}\.pdf$/.test(
      job.fileName,
    ))).toBe(true);
  });

  test('rejects statement metadata that cannot distinguish multiple accounts', () => {
    const accounts = sequoiaFundAccountsFromOptions([
      { label: 'Investment account ending 1111', value: 'remote-a' },
      { label: 'Investment account ending 2222', value: 'remote-b' },
    ]);
    const list = parseSequoiaFundStatementList({
      success: true,
      data: {
        sessionId: 'fixture-session',
        statements: [{
          documentId: 'document-a',
          statementType: 'quarterly',
          statementDate: '2026-03-31',
        }],
      },
    });

    expect(() => sequoiaFundStatementJobs(
      accounts,
      list,
      { csrfToken: 'fixture-csrf', links: [] },
      'https://secureaccountview.com/BFWeb/clients/sequoiafund/viewStatements',
      '2026-01-01',
      '2026-12-31',
    )).toThrow('account mapping is ambiguous');
  });

  test('rejects statement documents without an observed direct download target', () => {
    const accounts = sequoiaFundAccountsFromOptions([
      { label: 'Investment account ending 1111', value: 'remote-a' },
    ]);
    const list = parseSequoiaFundStatementList({
      success: true,
      data: {
        sessionId: 'fixture-session',
        statements: [{
          documentId: 'document-a',
          statementType: 'quarterly',
          statementDate: '2026-03-31',
        }],
      },
    });

    expect(() => sequoiaFundStatementJobs(
      accounts,
      list,
      { csrfToken: 'fixture-csrf', links: [] },
      'https://secureaccountview.com/BFWeb/clients/sequoiafund/viewStatements',
      '2026-01-01',
      '2026-12-31',
    )).toThrow('download metadata is unavailable');
  });
});

describe('Sequoia Fund parser validation', () => {
  test('accepts missing response metadata while still rejecting an observed failed response', () => {
    expect(sequoiaFundActivityResponseMetadataAccepted(null)).toBe(true);
    expect(sequoiaFundActivityResponseMetadataAccepted({ ok: true })).toBe(true);
    expect(sequoiaFundActivityResponseMetadataAccepted({ ok: false })).toBe(false);
  });

  test('redacts discovered selector values from browser errors', () => {
    const selector = 'opaqueSelector-9qZ';
    const message = safeSequoiaFundErrorMessage(
      new Error(`selectOption failed for ${selector} at https://secureaccountview.com/private`),
      [selector],
    );

    expect(message).toContain('<redacted-selection>');
    expect(message).toContain('<redacted-url>');
    expect(message).not.toContain(selector);
    expect(message).not.toContain('secureaccountview.com');
  });

  test('classifies parser-safe and rejected artifact byte signatures without exposing content', () => {
    expect(classifySequoiaFundArtifactBytes(new Uint8Array())).toBe('empty');
    expect(classifySequoiaFundArtifactBytes(Buffer.from('%PDF-1.7 fixture'))).toBe('pdf');
    expect(classifySequoiaFundArtifactBytes(Buffer.from('<html>login</html>'))).toBe('html');
    expect(classifySequoiaFundArtifactBytes(Buffer.from('{"error":true}'))).toBe('json');
    expect(classifySequoiaFundArtifactBytes(Buffer.from('Date,Amount\n01/01/2026,1.00'))).toBe('csv');
    expect(classifySequoiaFundArtifactBytes(Buffer.from('Date\tAmount\n01/01/2026\t1.00'))).toBe('tabular-text');
    expect(classifySequoiaFundArtifactBytes(Uint8Array.from([65, 0, 66, 0]))).toBe('utf16-or-binary');
    expect(classifySequoiaFundArtifactBytes(Buffer.from('plain text'))).toBe('text');
  });

  test('activity artifacts carry account identity through the matching parser', async () => {
    const directory = await mkdtemp('/private/tmp/easymoney-sequoia-test-');
    temporaryDirectories.push(directory);
    const account = sequoiaFundAccountsFromOptions([
      { label: 'Investment account ending 1111', value: 'remote-a' },
    ])[0]!;
    const fileName = 'sequoia-fund-account-last4-1111-activity-2026-01-01-to-2026-08-23.csv';
    const path = join(directory, fileName);
    await writeFile(path, [
      'Transaction Date,Transaction Type,Description,Dollar Amount',
      '08/01/2026,Fund Purchase,Electronic contribution,"$400.00"',
      '08/02/2026,Withdrawal,Distribution,"$25.00"',
    ].join('\n'));

    const validated = await validateSequoiaFundArtifact(path, 'activity', account);
    expect(validated).toMatchObject({
      parserId: 'sequoia-fund-activity-csv',
      accountToken: 'last4-1111',
      accountName: 'Sequoia Fund - 1111',
      transactionCount: 2,
      balanceCount: 0,
    });

    const parsed = await sequoiaFundActivityParser.parse({
      fileName,
      headers: [],
      rows: [],
      text: await Bun.file(path).text(),
      filePath: path,
    });
    expect(parsed.transactions[0]).toMatchObject({ amountCents: 40_000, account: 'Sequoia Fund - 1111' });
    expect(parsed.transactions[1]).toMatchObject({ amountCents: -2_500, account: 'Sequoia Fund - 1111' });
  });

  test('rejects HTML masquerading as an activity artifact before parser success', async () => {
    const directory = await mkdtemp('/private/tmp/easymoney-sequoia-test-');
    temporaryDirectories.push(directory);
    const account = sequoiaFundAccountsFromOptions([
      { label: 'Investment account ending 1111', value: 'remote-a' },
    ])[0]!;
    const path = join(
      directory,
      'sequoia-fund-account-last4-1111-activity-2026-01-01-to-2026-08-23.csv',
    );
    await writeFile(path, '<html>,authentication required\nnot financial data');

    await expect(validateSequoiaFundArtifact(path, 'activity', account)).rejects.toThrow('signature is invalid');
  });

  test('statement parser accepts account-identifiable names and checks visible last four digits', () => {
    const fileName = 'sequoia-fund-account-last4-1111-2026-06-30-statement-a1b2c3d4e5.pdf';
    expect(sequoiaFundStatementMeta.matches({ filename: fileName, sample: '' })).toBe(true);
    expect(sequoiaFundStatementAccount(fileName, 'Fund account number: XXXX1111')).toBe('Sequoia Fund - 1111');
    expect(() => sequoiaFundStatementAccount(
      fileName,
      'Fund account number: XXXX2222',
    )).toThrow('does not match its artifact identity');
  });
});

test('Sequoia Fund uses observed browser exports and the shared browser-native request transport', async () => {
  const source = await Bun.file(new URL('./sequoiaFund.ts', import.meta.url)).text();

  expect(source).toContain('runBrowserNativeRequest(page');
  expect(source).not.toContain('page.context().request');
  expect(source).toContain('page.waitForRequest');
  expect(source).toContain('locator.selectOption(value)');
  expect(source).toContain('element.form.requestSubmit()');
  expect(source).toContain("page.waitForEvent('download'");
  expect(source).not.toContain('replay');
  expect(source).not.toContain('waitForTimeout');
});

test('Sequoia Fund always starts headed without reading or writing saved authentication', async () => {
  expect(sequoiaFundBrowserSession('sequoia-fund-catchup', '/private/tmp/fixture-profile')).toEqual({
    name: 'sequoia-fund-catchup',
    startUrl: 'https://secureaccountview.com/BFWeb/clients/sequoiafund/index',
    profilePath: '/private/tmp/fixture-profile',
    persistAuthentication: false,
    contextOptions: { headless: false },
  });

  const source = await Bun.file(new URL('./sequoiaFund.ts', import.meta.url)).text();
  expect(source).not.toContain('playwrightHasSavedAuthentication');
  expect(source).toContain('cachedAuthentication: false');
});
