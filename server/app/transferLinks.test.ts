import { expect, test } from 'bun:test';
import { deriveTransferLinks } from './transferLinks';

test('an older transfer between the same accounts does not consume a later confirmed closure', () => {
  const input: Parameters<typeof deriveTransferLinks>[0] = {
    accounts:[{id:1,type:'investment'},{id:2,type:'investment'}],
    sortedMonths:['2026-01','2026-06','2026-07','2026-08'],
    flows:new Map([
      ['2026-07|1',{contributions:-1000000,dividends:0,interest:0}],
      ['2026-07|2',{contributions:1000000,dividends:0,interest:0}],
    ]),
    balances:new Map([['2026-06|1',2000000],['2026-08|1',0]]),
    seeds:new Map([[1,{account_id:1,firstMonth:'2026-01',startingAmount:1000000,contributionAdjustments:new Map([['2026-01',1000000]]),gainsByMonth:new Map([['2026-06',1000000]])}]]),
    transactions:[
      {id:'out',date:'2026-07-01',month:'2026-07',account_id:1,amount_cents:-1000000,description:'Transfer out'},
      {id:'in',date:'2026-07-01',month:'2026-07',account_id:2,amount_cents:1000000,description:'Transfer in'},
    ],
    confirmedTransfers:[{id:'closure:1',sourceAccountId:1,destinationAccountId:2,effectiveDate:'2026-08-19',reason:'reporting-closure'}],
  };
  const report=deriveTransferLinks(input);
  expect(report.links).toHaveLength(2);
  expect(report.links.find(r=>r.id==='closure:1')).toMatchObject({confirmation:'confirmed',evidence_status:'awaiting-bank-records',amount_cents:null,basis_cents:500000});
  expect(report.adjustments.filter(a=>a.link_id==='closure:1'&&a.account_id===2)).toEqual([
    {link_id:'closure:1',reason:'reporting-closure',account_id:2,month:'2026-08',contributions_cents:500000,gains_cents:-500000},
  ]);
  expect(deriveTransferLinks({...input,accounts:[...input.accounts].reverse()})).toEqual(report);
});
