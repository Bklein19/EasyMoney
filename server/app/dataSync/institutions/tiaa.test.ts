import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { meta as tiaaStatementMeta } from '../../importParsers/moneyParsers/tiaa-statement-pdf.ts';
import {
  assertTiaaActivityAccount,
  selectTiaaStatementAccount,
  tiaaActivityAccountIds,
  tiaaActivityPeriod,
  tiaaFormRequest,
  tiaaStatementPeriod,
  validateTiaaActivityArtifact,
  validateTiaaStatementArtifact,
} from './tiaa.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, { recursive: true, force: true })
  ));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'easymoney-tiaa-test-'));
  temporaryDirectories.push(path);
  return path;
}

describe('TIAA artifact discovery metadata', () => {
  test('maps dynamically offered activity periods without assuming fixed years', () => {
    expect(tiaaActivityPeriod('Current year', 'current', 2026)).toEqual({
      label: 'Current year',
      value: 'current',
      year: 2026,
      coveredFrom: '2026-01-01',
      coveredThrough: '2026-12-31',
    });
    expect(tiaaActivityPeriod(' Activity for 2024 ', 'prior', 2026)).toEqual({
      label: 'Activity for 2024',
      value: 'prior',
      year: 2024,
      coveredFrom: '2024-01-01',
      coveredThrough: '2024-12-31',
    });
    expect(tiaaActivityPeriod('Last 90 days', 'recent', 2026)).toBeNull();
  });

  test('maps dynamically offered statement labels to exact quarter coverage', () => {
    expect(tiaaStatementPeriod('Retirement Q2 / 2026 View')).toEqual({
      label: 'RETIREMENT Q2/2026',
      year: 2026,
      quarter: 2,
      coveredFrom: '2026-04-01',
      coveredThrough: '2026-06-30',
    });
    expect(tiaaStatementPeriod('Tax form 2026')).toBeNull();
  });

  test('requires an unambiguous statement-to-account association', () => {
    const accounts = [
      { routingKey: 'first', identityTokens: ['1111'] },
      { routingKey: 'second', identityTokens: ['2222'] },
    ];
    expect(selectTiaaStatementAccount(accounts, 'Retirement account ending 2222')).toBe(accounts[1]);
    expect(() => selectTiaaStatementAccount(accounts, 'Consolidated retirement statement'))
      .toThrow('association is ambiguous');
    expect(() => selectTiaaStatementAccount(accounts, 'Accounts 1111 and 2222'))
      .toThrow('association is ambiguous');
  });
});

describe('TIAA authenticated API requests', () => {
  test('derives GET and form-encoded POST requests from authenticated form metadata', () => {
    expect(tiaaFormRequest(
      'https://my.tiaa.org/private/participantdata/quickendownload',
      'POST',
      'application/x-www-form-urlencoded',
      [['account', 'one'], ['account', 'two'], ['period', '2026']],
    )).toEqual({
      url: 'https://my.tiaa.org/private/participantdata/quickendownload',
      method: 'POST',
      data: 'account=one&account=two&period=2026',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(tiaaFormRequest(
      '/private/participantdata/quickendownload',
      'GET',
      '',
      [['period', '2026']],
    )).toEqual({
      url: 'https://my.tiaa.org/private/participantdata/quickendownload?period=2026',
      method: 'GET',
    });
  });

  test('rejects untrusted destinations and unsupported form encodings', () => {
    expect(() => tiaaFormRequest('https://example.com/export', 'GET', '', []))
      .toThrow('invalid destination');
    expect(() => tiaaFormRequest(
      'https://my.tiaa.org/export',
      'POST',
      'multipart/form-data',
      [],
    )).toThrow('unsupported encoding');
  });
});

describe('TIAA parser-backed artifact validation', () => {
  test('extracts one remote account identity and validates the production activity parser', async () => {
    const directory = await temporaryDirectory();
    const fileName = 'tiaa-retirement-annuity-2026-account-acde1234abcd-2026-01-01-to-2026-12-31.csv';
    const path = join(directory, fileName);
    const text = [
      'Date,AccountId,Action,Security,Price,Quantity,Amount,Text,Memo,Commission',
      '01/05/2026,RET123,Contribution,TIAA Traditional,1.00,100,100.00,Employee contribution,,0',
    ].join('\n');
    await writeFile(path, text);

    expect(tiaaActivityAccountIds(text)).toEqual(['RET123']);
    expect(assertTiaaActivityAccount(['RET123'])).toBe('RET123');
    await expect(validateTiaaActivityArtifact(path)).resolves.toEqual({
      size: Buffer.byteLength(text),
      remoteAccountId: 'RET123',
      coveredFrom: '2026-01-05',
      coveredThrough: '2026-01-05',
    });
  });

  test('rejects consolidated activity exports instead of guessing an account route', () => {
    const text = [
      'Date,AccountId,Action,Security,Price,Quantity,Amount,Text,Memo,Commission',
      '01/05/2026,RET123,Contribution,TIAA Traditional,1.00,100,100.00,Employee contribution,,0',
      '01/06/2026,RET456,Contribution,TIAA Traditional,1.00,100,100.00,Employee contribution,,0',
    ].join('\n');
    expect(() => assertTiaaActivityAccount(tiaaActivityAccountIds(text)))
      .toThrow('exactly one remote account');
  });

  test('accepts stable hexadecimal routing keys in parser-recognized statement filenames', async () => {
    const directory = await temporaryDirectory();
    const fileName = 'tiaa-2026-06-30-retirement-q2-2026-acde1234abcd.pdf';
    const path = join(directory, fileName);
    const body = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(10_000, 0x20)]);
    await writeFile(path, body);

    expect(tiaaStatementMeta.matches({ filename: fileName, sample: '' })).toBe(true);
    await expect(validateTiaaStatementArtifact(path, fileName, async () => ({
      transactions: [],
      balances: [{
        date: '2026-06-30',
        account: 'Retirement Annuity',
        institution: 'TIAA',
        balance_cents: 123_45,
      }],
      covered_from: '2026-04-01',
      covered_to: '2026-06-30',
    }))).resolves.toEqual({
      size: body.length,
      coveredFrom: '2026-04-01',
      coveredThrough: '2026-06-30',
    });
  });
});
