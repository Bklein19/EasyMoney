export type SequoiaFundPortfolioAccount = {
  fundAccountNumber: string;
  fundAcctNumbMasked: string;
  fundSecIssueId: string;
  fund: {
    fundIdNumStripLeadingZeros: string;
    fundName: string;
  };
};

export type SequoiaFundPortfolio = {
  groupKey: string;
  registration: string[];
  accountList: SequoiaFundPortfolioAccount[];
};

export type SequoiaFundActivityWindow = {
  range: '90' | '' | 'PRIOR12' | 'ALL';
  startDate: string;
  endDate: string;
};

export type SequoiaFundHistoryFields = {
  acctNumber: '';
  customFormField_MaxReturnCount: '';
  endDate: string;
  groupKey: string;
  range: SequoiaFundActivityWindow['range'];
  requestCode: 'H';
  securityID: '';
  startDate: string;
};

export type SequoiaFundActivityExportFields = SequoiaFundHistoryFields & {
  customFormField_fundName: '';
  customFormField_requestCode: 'H';
  customFormField_transType: 'all';
  eventLinkTypeId: '';
};

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function collection(value: unknown, message: string): unknown[] {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === 'object') return Object.values(value);
  throw new Error(message);
}

function opaqueIdentifier(value: unknown, message: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error(message);
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  return value;
}

function registration(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error('Sequoia Fund portfolio registration is invalid');
  }
  return [...value];
}

function parsePortfolioAccount(value: unknown): SequoiaFundPortfolioAccount {
  const account = record(value, 'Sequoia Fund portfolio account is invalid');
  const fund = record(account.fund, 'Sequoia Fund portfolio fund is invalid');
  return {
    fundAccountNumber: opaqueIdentifier(
      account.fundAccountNumber,
      'Sequoia Fund portfolio account number is invalid',
    ),
    fundAcctNumbMasked: opaqueIdentifier(
      account.fundAcctNumbMasked,
      'Sequoia Fund portfolio masked account number is invalid',
    ),
    fundSecIssueId: opaqueIdentifier(
      account.fundSecIssueId,
      'Sequoia Fund portfolio security identifier is invalid',
    ),
    fund: {
      fundIdNumStripLeadingZeros: opaqueIdentifier(
        fund.fundIdNumStripLeadingZeros,
        'Sequoia Fund portfolio fund identifier is invalid',
      ),
      fundName: requiredString(fund.fundName, 'Sequoia Fund portfolio fund name is invalid'),
    },
  };
}

export function parseSequoiaFundPortfolio(value: unknown): SequoiaFundPortfolio {
  const root = record(value, 'Sequoia Fund portfolio response was not an object');
  const groups = collection(
    root.portfolioGroupList,
    'Sequoia Fund portfolio groups are invalid',
  );
  if (groups.length !== 1) {
    throw new Error('Sequoia Fund login must expose exactly one portfolio group');
  }

  const group = record(groups[0], 'Sequoia Fund portfolio group is invalid');
  const accounts = collection(
    group.accountList,
    'Sequoia Fund portfolio accounts are invalid',
  );
  if (accounts.length === 0) throw new Error('Sequoia Fund portfolio group has no accounts');

  return {
    groupKey: opaqueIdentifier(group.groupKey, 'Sequoia Fund portfolio group key is invalid'),
    registration: registration(group.registration),
    accountList: accounts.map(parsePortfolioAccount),
  };
}

function isoDate(value: string, label: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`${label} must use YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${label} must be a valid date`);
  }
  return date;
}

function subtractCalendarMonths(date: Date, months: number): Date {
  const targetMonthStart = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() - months,
    1,
  ));
  const lastTargetDay = new Date(Date.UTC(
    targetMonthStart.getUTCFullYear(),
    targetMonthStart.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  return new Date(Date.UTC(
    targetMonthStart.getUTCFullYear(),
    targetMonthStart.getUTCMonth(),
    Math.min(date.getUTCDate(), lastTargetDay),
  ));
}

function compactDate(value: string): string {
  return value.replaceAll('-', '');
}

export function sequoiaFundActivityWindow(
  from: string,
  through: string,
): SequoiaFundActivityWindow {
  const start = isoDate(from, 'Sequoia Fund activity start');
  const end = isoDate(through, 'Sequoia Fund activity through date');
  if (start.getTime() > end.getTime()) {
    throw new Error('Sequoia Fund activity start must not be after the through date');
  }

  if (start.getTime() >= subtractCalendarMonths(end, 3).getTime()) {
    return { range: '90', startDate: compactDate(from), endDate: compactDate(through) };
  }
  if (start.getTime() >= subtractCalendarMonths(end, 6).getTime()) {
    return { range: '', startDate: compactDate(from), endDate: compactDate(through) };
  }
  if (start.getTime() >= subtractCalendarMonths(end, 12).getTime()) {
    return { range: 'PRIOR12', startDate: '', endDate: '' };
  }
  return { range: 'ALL', startDate: '', endDate: '' };
}

export function sequoiaFundHistoryFields(
  groupKey: string,
  window: SequoiaFundActivityWindow,
): SequoiaFundHistoryFields {
  return {
    acctNumber: '',
    customFormField_MaxReturnCount: '',
    endDate: window.endDate,
    groupKey: opaqueIdentifier(groupKey, 'Sequoia Fund portfolio group key is invalid'),
    range: window.range,
    requestCode: 'H',
    securityID: '',
    startDate: window.startDate,
  };
}

export function sequoiaFundActivityExportFields(
  history: SequoiaFundHistoryFields,
  defaults: Readonly<Record<string, string>> = {},
): Record<string, string> & SequoiaFundActivityExportFields {
  return {
    ...defaults,
    ...history,
    startDate: '',
    endDate: '',
    customFormField_fundName: '',
    customFormField_requestCode: 'H',
    customFormField_transType: 'all',
    eventLinkTypeId: '',
  };
}

export function parseSequoiaFundHistoryResponse(value: unknown): number {
  const root = record(value, 'Sequoia Fund history response was not an object');
  const data = record(root.data, 'Sequoia Fund history response data is invalid');
  if (!Array.isArray(data.portHistList)) {
    throw new Error('Sequoia Fund history response records are invalid');
  }
  return data.portHistList.length;
}
