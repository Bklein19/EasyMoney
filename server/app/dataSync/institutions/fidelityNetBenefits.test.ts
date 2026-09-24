import { describe, expect, test } from 'bun:test';
import type { Page } from 'playwright';
import type { runAuthenticatedHttpRequest } from '../authenticatedHttp.ts';
import { fetchNetBenefitsStatements, netBenefitsStatementPeriods, parseNetBenefitsStatementForm } from './fidelityNetBenefits.ts';

const fixture = `<script>var planNumber = "12345";</script><form name="frmRequest" method="post" action="/nbretail/savings2/sod/soddetail">
<input type="hidden" name="txntoken" value="synthetic&amp;token"><input type="hidden" name="sodReqIndicator" value="HACK">
<input type="hidden" name="dateRange" value="HACK"><input type="hidden" name="ytdDateRange" value="01/01/2026-09/22/2026">
<input type="hidden" name="sodPreview" value="N"><input type="hidden" name="consentReq" value="N"></form>`;

describe('NetBenefits HTTP statement contract', () => {
  test('reads fresh hidden fields and authoritative plan identity', async () => {
    const form = await parseNetBenefitsStatementForm(fixture);
    expect(form.planId).toBe('12345');
    expect(form.availableThrough).toBe('2026-09-22');
    expect(form.fields.txntoken).toBe('synthetic&token');
  });
  test('rejects missing token, conflicting plans, and off-origin action', async () => {
    for (const bad of [fixture.replace('name="txntoken"','name="other"'),
      fixture + '<script>planNumber="67890";</script>',
      fixture.replace('/nbretail/savings2/sod/soddetail','https://example.test/collect')]) {
      await expect(parseNetBenefitsStatementForm(bad)).rejects.toThrow();
    }
  });
  test('includes overlapping month and latest partial month', () => {
    expect(netBenefitsStatementPeriods('2026-07-24','2026-09-22')).toEqual([
      { from:'2026-07-01',through:'2026-07-31' },
      { from:'2026-08-01',through:'2026-08-31' },
      { from:'2026-09-01',through:'2026-09-22' },
    ]);
    expect(netBenefitsStatementPeriods('2024-02-15','2024-02-29')).toEqual([{from:'2024-02-01',through:'2024-02-29'}]);
    expect(() => netBenefitsStatementPeriods('2026-02-30','2026-03-31')).toThrow();
    expect(() => netBenefitsStatementPeriods('2026-09-30','2026-09-01')).toThrow();
  });
  test('downloads each month with a fresh token and clamps to server availability', async () => {
    let gets = 0;
    const posted: Array<Record<string,string|number|boolean>> = [];
    const request: typeof runAuthenticatedHttpRequest = async (_page, req) => {
      if (req.method === 'POST') posted.push(req.form!);
      else gets += 1;
      return { requestUrl:req.url,finalUrl:req.url,status:200,statusText:'OK',headers:{'content-type':'text/html'},redirects:[],
        body:Buffer.from(req.method === 'POST' ? '<html>statement</html>' : fixture.replace('synthetic&amp;token', `fresh-${gets}`)) };
    };
    const dates: string[] = [];
    await fetchNetBenefitsStatements({request:{}} as Page,['12345'],{from:'2026-08-15',through:'2026-09-23'},async statement => { dates.push(statement.through); }, request);
    expect(dates).toEqual(['2026-08-31','2026-09-22']);
    expect(posted.map(form=>form.txntoken)).toEqual(['fresh-2','fresh-3']);
    expect(posted.map(form=>form.dateRange)).toEqual(['08/01/2026-08/31/2026','09/01/2026-09/22/2026']);
  });
  test('empty plans do not request; unmatched plans and malformed responses fail closed', async () => {
    let calls = 0;
    const request: typeof runAuthenticatedHttpRequest = async (_page, req) => {
      calls += 1;
      return {requestUrl:req.url,finalUrl:req.url,status:200,statusText:'OK',headers:{'content-type':'text/html'},redirects:[],body:Buffer.from(fixture)};
    };
    const page = {request:{}} as Page;
    const range = {from:'2026-08-01',through:'2026-09-23'};
    await fetchNetBenefitsStatements(page,[],range,async()=>{},request);
    expect(calls).toBe(0);
    for (const plans of [['67890'],['12345','67890']]) {
      await expect(fetchNetBenefitsStatements(page,plans,range,async()=>{},request)).rejects.toThrow('every retirement plan');
    }
    await expect(fetchNetBenefitsStatements(page,['12345'],range,async()=>{},async (...args)=>({...await request(...args),status:401}))).rejects.toThrow('authentication');
    await expect(fetchNetBenefitsStatements(page,['12345'],range,async()=>{},async (...args)=>({...await request(...args),body:Buffer.from('<html>Sign in</html>')}))).rejects.toThrow('metadata');
  });
});
