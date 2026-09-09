import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import {
  fidelityActivityBody, fidelityActivityEpoch, fidelityStatementDownloadBody,
  fidelityStatementListBody, parseFidelityHttpAccounts, fidelityHttpEndpoints,
} from './fidelityHttp.ts';
import { assertFidelityActivityHistoryRequest, runAuthenticatedFidelity } from './fidelity.ts';

const brokerage = { acctNum: 'Z00001234', acctType: 'Brokerage', preferenceDetail: { name: 'Example investment' } };
const retirement = { acctNum: '12345', acctType: 'WPS', preferenceDetail: { defaultAcctName: 'Example retirement' } };

describe('Fidelity HTTP protocol', () => {
  test('discovers independent brokerage and retirement identities while excluding linked stock-plan holdings', () => {
    expect(parseFidelityHttpAccounts({ acctDetails: [brokerage, retirement,
      { acctType: 'SPS', parentBrokAcctNum: brokerage.acctNum, spsAcctKey: 'holding-one' },
    ] })).toEqual([
      { acctNum: brokerage.acctNum, acctType: 'Brokerage', acctName: 'Example investment' },
      { acctNum: retirement.acctNum, acctType: 'WPS', acctName: 'Example retirement' },
    ]);
  });

  test('fails closed on partial errors, unsupported accounts, absent identities, and repeated identities', () => {
    for (const response of [
      {}, { acctDetails: [brokerage, brokerage] },
      { acctDetails: [{ acctType: 'Brokerage' }] },
      { acctDetails: [{ acctType: 'Annuity', acctNum: '12345678' }] },
      { acctDetails: [brokerage], sysMsgs: { sysMsg: [{ type: 'error' }] } },
    ]) expect(() => parseFidelityHttpAccounts(response)).toThrow();
    expect(parseFidelityHttpAccounts({ acctDetails: [] })).toEqual([]);
  });

  test('constructs exact activity scope across winter, summer, and DST transition dates', () => {
    const account = parseFidelityHttpAccounts({ acctDetails: [brokerage] })[0]!;
    for (const [date, instant] of [
      ['2026-01-01', '2026-01-01T05:00:00Z'],
      ['2026-07-01', '2026-07-01T04:00:00Z'],
      ['2026-03-08', '2026-03-08T05:00:00Z'],
      ['2026-11-01', '2026-11-01T04:00:00Z'],
    ]) {
      expect(fidelityActivityEpoch(date!)).toBe(Date.parse(instant!) / 1000);
      const request = {
        url: fidelityHttpEndpoints.activity, method: 'POST',
        postData: JSON.stringify(fidelityActivityBody(account, date!, date!)),
      };
      expect(() => assertFidelityActivityHistoryRequest(request, {
        siteAccountId: account.acctNum, from: date!, through: date!,
      })).not.toThrow();
    }
    expect(() => fidelityActivityBody(account, '2026-02-30', '2026-03-01')).toThrow();
    expect(() => fidelityActivityBody(account, '2026-07-02', '2026-07-01')).toThrow();
  });

  test('uses whole year document lists and server account types for exact document requests', () => {
    expect(fidelityStatementListBody(2025)).toMatchObject({ startDate: '2025-01-01', endDate: '2026-01-01' });
    const account = parseFidelityHttpAccounts({ acctDetails: [retirement] })[0]!;
    expect(fidelityStatementDownloadBody('synthetic-document', account)).toEqual({
      id: 'synthetic-document', formatType: 'PDF', docType: 'STMT', acctType: 'WPS',
    });
  });

  test('runs discovery and empty activity over HTTP without any page operations', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'fidelity-http-test-'));
    const requests: Array<{ url: string; body: Record<string, any> }> = [];
    const page = { request: {
      async fetch(url: string, options: { data: Buffer }) {
        const body = JSON.parse(options.data.toString());
        requests.push({ url, body });
        const response = url === fidelityHttpEndpoints.accounts ? { acctDetails: [brokerage, retirement] }
          : url === fidelityHttpEndpoints.activity ? { data: { transactions: [] }, errors: [] }
            : { statement: { docDetails: { docDetail: [] } } };
        return {
          status: () => 200, statusText: () => 'OK', url: () => url,
          headersArray: () => [{ name: 'content-type', value: 'application/json' }],
          body: async () => Buffer.from(JSON.stringify(response)), dispose: async () => {},
        };
      },
    } } as unknown as Page;
    try {
      const result = await runAuthenticatedFidelity(page, {
        outputDir, from: '2025-12-28', through: '2026-01-03', session: 'synthetic',
      }, () => {});
      expect(result.accountsDiscovered).toBe(2);
      expect(result.artifacts).toEqual([]);
      expect(await readdir(outputDir)).toEqual([]);
      expect(requests.map(request => request.url)).toEqual([
        fidelityHttpEndpoints.accounts, fidelityHttpEndpoints.activity, fidelityHttpEndpoints.activity,
        fidelityHttpEndpoints.statements, fidelityHttpEndpoints.statements,
      ]);
      expect(requests[1]!.body.filter.accounts[0].acctNum).toBe(brokerage.acctNum);
      expect(requests[2]!.body.filter.accounts[0].acctNum).toBe(retirement.acctNum);
      expect(requests[3]!.body.startDate).toBe('2025-01-01');
      expect(requests[4]!.body.startDate).toBe('2026-01-01');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
