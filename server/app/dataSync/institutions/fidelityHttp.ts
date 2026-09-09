/** Request contracts verified against Fidelity's authenticated application traffic. */
export const fidelityHttpEndpoints = {
  accounts: 'https://dpservice.fidelity.com/ftgw/dp/customer-am-acctnxt/v2/accounts',
  activity: 'https://digital.fidelity.com/ftgw/digital/activityapi/api/v1/transactions/history',
  statements: 'https://digitalservices.fidelity.com/ftgw/dp/retail-am-financialdoc/v1/accounts/communications/financial-documents/statements',
  document: 'https://digitalservices.fidelity.com/ftgw/dp/retail-am-financialdoc/v2/accounts/communications/financial-documents/download',
} as const;

export interface FidelityHttpAccount {
  acctNum: string;
  acctName: string;
  acctType: string;
}

export function fidelityHttpHeaders(activity = false): Record<string, string> {
  return activity ? {
    accept: 'application/json', 'content-type': 'application/json',
    appid: 'ap182468', appname: 'activity-orders-ui',
  } : {
    accept: 'application/json', 'content-type': 'application/json',
    appid: 'AP160308', appname: 'Document Access Hub',
    'fid-originating-app-id': 'AP160308', 'fid-originating-app-version': '1.0',
  };
}

export function fidelityAccountListBody(): object {
  return {
    acctCategory: 'Brokerage,StockPlans,Annuity,Charitable,FidelityCreditCards,InternalDigital,BrokerageLending,RegisteredStock,WorkplaceBenefits,WorkplaceContributions',
    filters: {
      returnCustomerAttrDetail: true, returnPreferenceDetail: true,
      returnAcctRelAttrDetail: true, returnAcctIndDetail: true,
      returnOrderedAccounts: true, returnAcctStateDetail: true,
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function parseFidelityHttpAccounts(value: unknown): FidelityHttpAccount[] {
  const root = record(value);
  if (!Array.isArray(root?.acctDetails)) throw new Error('Fidelity HTTP account metadata is missing');
  const messages = record(root.sysMsgs)?.sysMsg;
  if (Array.isArray(messages) && messages.some(message => record(message)?.type === 'error')) {
    throw new Error('Fidelity HTTP account discovery reported a server error');
  }
  const accounts: FidelityHttpAccount[] = [];
  const ids = new Set<string>();
  for (const item of root.acctDetails) {
    const account = record(item);
    if (!account || typeof account.acctType !== 'string') {
      throw new Error('Fidelity HTTP account metadata is invalid');
    }
    // Stock-plan lots link to their parent brokerage; they are not independent
    // activity accounts. Never derive an account identity from a holding key.
    if (account.acctType === 'SPS' && !account.acctNum) continue;
    if (!['Brokerage', 'WPS'].includes(account.acctType)) {
      throw new Error('Fidelity HTTP account category is not supported');
    }
    const preferences = record(account.preferenceDetail);
    const name = preferences?.name || preferences?.defaultAcctName || account.acctType;
    if (typeof account.acctNum !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$/.test(account.acctNum)
        || typeof name !== 'string' || !name.trim() || ids.has(account.acctNum)) {
      throw new Error('Fidelity HTTP account identity is missing or ambiguous');
    }
    ids.add(account.acctNum);
    accounts.push({ acctNum: account.acctNum, acctName: name.trim(), acctType: account.acctType });
  }
  return accounts;
}

/** Midnight in Fidelity's Eastern calendar, including DST on the requested day. */
export function fidelityActivityEpoch(date: string): number {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(midnight)
      || new Date(midnight).toISOString().slice(0, 10) !== date) {
    throw new Error('Fidelity HTTP activity date is invalid');
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'longOffset',
  }).formatToParts(new Date(midnight + 12 * 60 * 60_000));
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(parts.find(part => part.type === 'timeZoneName')?.value ?? '');
  if (!match) throw new Error('Fidelity HTTP activity timezone is invalid');
  let candidate = midnight - (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
  // On a DST transition midnight can use the preceding offset rather than noon's.
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
  });
  const hour = Number(local.format(new Date(candidate)));
  if (hour === 23) candidate += 60 * 60_000;
  else if (hour === 1) candidate -= 60 * 60_000;
  return candidate / 1000;
}

export function fidelityActivityBody(account: FidelityHttpAccount, from: string, through: string): object {
  if (from > through) throw new Error('Fidelity HTTP activity range is invalid');
  return { filter: {
    accounts: [{ ...account }],
    searchCriteriaDetail: {
      txnFromDate: fidelityActivityEpoch(from), txnToDate: fidelityActivityEpoch(through),
      includeBasketNames: false, includeCoreFundSettlementTransactions: false,
    },
  } };
}

export function fidelityStatementListBody(year: number): object {
  if (!Number.isInteger(year) || year < 1900 || year > 9998) throw new Error('Fidelity statement year is invalid');
  return {
    startDate: `${year}-01-01`, endDate: `${year + 1}-01-01`, docType: 'STMT',
    hasCryptoAccount: false, annuityAccountLookup: true,
  };
}

export function fidelityStatementDownloadBody(id: string, account: FidelityHttpAccount): object {
  if (!id.trim()) throw new Error('Fidelity statement identity is missing');
  return { id, formatType: 'PDF', docType: 'STMT', acctType: account.acctType };
}
