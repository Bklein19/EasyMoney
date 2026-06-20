import { getDb, syncLedgerReadModelFromLegacyTables } from '../database.js';
import { classifyFlow } from './flowClassification.ts';
import { summarizeReturns, type ReturnSummary } from './returns.ts';
import { deriveTransferLinks, type TransferLink } from './transferLinks.ts';

export interface InvestmentAccountSummary {
  id: number;
  name: string;
  institution: string;
  type: string;
  classification: string;
  flow_treatment: string;
  account_holder: string | null;
}

export interface InvestmentMonthlyRow {
  month: string;
  account_id: number;
  contributions_cents: number;
  dividends_cents: number;
  interest_cents: number;
  gains_cents: number | null;
  end_balance_cents: number | null;
}

export interface InvestmentNetWorthReport {
  accounts: InvestmentAccountSummary[];
  rows: InvestmentMonthlyRow[];
  transfer_links: TransferLink[];
  returns: ReturnSummary[];
}

export interface SavingsRateMonthlyRow {
  month: string;
  income_cents: number;
  market_income_cents: number;
  income_ex_market_gains_cents: number;
  investment_change_cents: number;
  cash_change_cents: number;
  poof_cents: number;
  net_retained_cents: number;
}

export interface SavingsRateAccountMonth {
  account_id: number;
  month: string;
  income_cents: number;
  market_income_cents: number;
  investment_delta_cents: number;
  cash_delta_cents: number;
}

export interface SavingsRateIncomeSource {
  label: string;
  amount_cents: number;
  count: number;
  is_market_income: boolean;
}

export interface SavingsRateReport {
  accounts: Array<Pick<InvestmentAccountSummary, 'id' | 'name' | 'institution' | 'type'>>;
  rows: SavingsRateMonthlyRow[];
  account_months: SavingsRateAccountMonth[];
  income_sources: SavingsRateIncomeSource[];
  account_sources: Array<SavingsRateIncomeSource & { account_id: number }>;
}

interface LedgerTransactionReportRow {
  id: string;
  date: string;
  month: string;
  account_id: number;
  amount_cents: number;
  description: string;
  raw: string | null;
  account_type: string;
}

interface LedgerBalanceReportRow {
  date: string;
  month: string;
  account_id: number;
  balance_cents: number;
}

const CASH_TYPES = new Set(['checking', 'savings', 'cash']);
const INVESTMENT_TYPES = new Set(['investment', 'brokerage', 'retirement']);

function isCashLikeAccount(account: { type: string }) {
  return ['checking', 'savings', 'credit', 'credit_card', 'credit-card', 'loan', 'cash'].includes(account.type);
}

function isCreditType(type: string) {
  return type === 'credit' || type === 'credit_card' || type === 'credit-card';
}

function normalizeDate(value: string | null | undefined, month?: string) {
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    return value.slice(0, 10);
  }
  return month ? `${month}-01` : '';
}

function periodAllocation(input: {
  income_cents: number;
  investment_delta_cents: number;
  cash_delta_cents: number;
}) {
  const net_retained_cents = input.investment_delta_cents + input.cash_delta_cents;
  return {
    investment_change_cents: input.investment_delta_cents,
    cash_change_cents: input.cash_delta_cents,
    net_retained_cents,
    poof_cents: Math.max(0, input.income_cents - net_retained_cents),
  };
}

function isInternalMoneyMove(description: string) {
  const d = description.toLowerCase();
  return (
    /online banking transfer/.test(d) ||
    /funds (received|paid|transferred)|fund ?transfers/.test(d) ||
    /transfer (in|out|from|to)|broker to broker|journaled/.test(d) ||
    /vanguard buy|sequoia des:investment|fid bkg svc .*moneyline/.test(d) ||
    /online payment from chk|payment from chk/.test(d) ||
    /sweep (in|out)/.test(d) ||
    /overdraft protection/.test(d)
  );
}

function isExternalIncome(transaction: { amount_cents: number; description: string; raw?: string | null }) {
  if (transaction.amount_cents <= 0) return false;
  if (isInternalMoneyMove(transaction.description)) return false;

  const d = transaction.description.toLowerCase();
  if (/401\(k\) contributions|rsu vest|espp purchase|direct deposit|payroll|salary|examplepayroll|example university uni/.test(d)) {
    return true;
  }
  if (/interest|dividend|cap gain/.test(d)) return true;
  if (/\bdeposit\b/.test(d)) return true;

  try {
    const raw = transaction.raw ? JSON.parse(transaction.raw) as Record<string, unknown> : {};
    if (raw['section'] === 'Deposits and other additions') return true;
  } catch {
    // Fall back to description-based classification.
  }

  return false;
}

function isMarketIncome(description: string) {
  return /interest|dividend|cap gain/.test(description.toLowerCase());
}

function incomeSourceLabel(description: string) {
  const d = description.toLowerCase();
  if (/401\(k\) contributions/.test(d)) return '401(k) contributions';
  if (/rsu vest/.test(d)) return 'RSU vesting';
  if (/espp purchase/.test(d)) return 'ESPP purchase';
  if (/examplepayroll/.test(d)) return 'Example Payroll payroll';
  if (/example university uni/.test(d)) return 'Example University';
  if (/interest/.test(d)) return 'Interest';
  if (/dividend|cap gain/.test(d)) return 'Dividends';
  if (/\bdeposit\b/.test(d)) return 'Deposits';
  return description.replace(/\s+/g, ' ').slice(0, 80);
}

function getAccounts(): InvestmentAccountSummary[] {
  return getDb().prepare(`
    SELECT
      id,
      name,
      COALESCE(institution, '') AS institution,
      type,
      type AS classification,
      CASE
        WHEN type IN ('checking', 'savings', 'cash', 'credit', 'credit_card', 'credit-card') THEN 'contributions'
        ELSE 'investment'
      END AS flow_treatment,
      accountHolder AS account_holder
    FROM accounts
    ORDER BY institution, name
  `).all() as InvestmentAccountSummary[];
}

function getLedgerTransactions(): LedgerTransactionReportRow[] {
  return getDb().prepare(`
    SELECT
      lt.ledgerTransactionId AS id,
      lt.date,
      substr(lt.date, 1, 7) AS month,
      lt.accountId AS account_id,
      lt.amountCents AS amount_cents,
      COALESCE(lt.description, '') AS description,
      lt.originalDescription AS raw,
      a.type AS account_type
    FROM ledgerTransactions lt
    JOIN accounts a ON a.id = lt.accountId
    ORDER BY lt.date, lt.id
  `).all() as LedgerTransactionReportRow[];
}

function getLedgerBalances(): LedgerBalanceReportRow[] {
  const rows = getDb().prepare(`
    SELECT
      COALESCE(capturedAt, month || '-01') AS date,
      month,
      accountId AS account_id,
      balanceCents AS balance_cents,
      id
    FROM ledgerBalances
    ORDER BY accountId, month, capturedAt, id
  `).all() as Array<LedgerBalanceReportRow & { id: number }>;

  return rows.map(row => ({
    date: normalizeDate(row.date, row.month),
    month: row.month,
    account_id: row.account_id,
    balance_cents: isCreditType(String(getAccountType(row.account_id) || ''))
      ? -Math.abs(row.balance_cents)
      : row.balance_cents,
  }));
}

const accountTypeCache = new Map<number, string>();
function getAccountType(accountId: number) {
  if (accountTypeCache.has(accountId)) return accountTypeCache.get(accountId);
  const row = getDb().prepare('SELECT type FROM accounts WHERE id = ?').get(accountId) as { type: string } | undefined;
  accountTypeCache.set(accountId, row?.type || '');
  return row?.type || '';
}

export function getInvestmentNetWorthReport(): InvestmentNetWorthReport {
  syncLedgerReadModelFromLegacyTables();
  accountTypeCache.clear();

  const accounts = getAccounts();
  const txs = getLedgerTransactions();
  const balanceSnapshots = getLedgerBalances();

  const latestBalanceByMonthAccount = new Map<string, number>();
  const accountsWithBalanceSnapshots = new Set<number>();
  const months = new Set<string>();
  const flowKey = (month: string, accountId: number) => `${month}|${accountId}`;

  for (const tx of txs) months.add(tx.month);
  for (const balance of balanceSnapshots) {
    months.add(balance.month);
    latestBalanceByMonthAccount.set(flowKey(balance.month, balance.account_id), balance.balance_cents);
    accountsWithBalanceSnapshots.add(balance.account_id);
  }

  const flows = new Map<string, { contributions: number; dividends: number; interest: number }>();
  for (const tx of txs) {
    const key = flowKey(tx.month, tx.account_id);
    const flow = flows.get(key) ?? { contributions: 0, dividends: 0, interest: 0 };
    const kind = classifyFlow(tx.description);
    if (kind === 'contribution') flow.contributions += tx.amount_cents;
    else if (kind === 'dividend') flow.dividends += tx.amount_cents;
    else if (kind === 'interest') flow.interest += tx.amount_cents;
    flows.set(key, flow);
  }

  const sortedMonths = [...months].sort();
  const rows: InvestmentMonthlyRow[] = [];
  const perAccount = new Map<number, {
    gainsByMonth: Map<string, number>;
    contribAdjust: Map<string, number>;
    gainsAdjust: Map<string, number>;
    firstMonth: string | null;
    startingAmount: number;
  }>();

  for (const account of accounts) {
    const gainsByMonth = new Map<string, number>();
    let prevBalance: number | null = null;
    let prevBalanceMonth: string | null = null;

    for (const month of sortedMonths) {
      const endBalance = latestBalanceByMonthAccount.get(flowKey(month, account.id)) ?? null;
      if (endBalance !== null && prevBalance !== null && prevBalanceMonth !== null) {
        let totalFlows = 0;
        const gapMonths: string[] = [];
        for (const gapMonth of sortedMonths) {
          if (gapMonth <= prevBalanceMonth || gapMonth > month) continue;
          gapMonths.push(gapMonth);
          const flow = flows.get(flowKey(gapMonth, account.id));
          if (flow) totalFlows += flow.contributions + flow.dividends + flow.interest;
        }
        const totalGains = endBalance - prevBalance - totalFlows;
        const count = gapMonths.length;
        if (count > 0) {
          let distributed = 0;
          for (let index = 0; index < count; index += 1) {
            const slice = index < count - 1 ? Math.round(totalGains / count) : totalGains - distributed;
            gainsByMonth.set(gapMonths[index]!, (gainsByMonth.get(gapMonths[index]!) ?? 0) + slice);
            if (index < count - 1) distributed += slice;
          }
        }
      }
      if (endBalance !== null) {
        prevBalance = endBalance;
        prevBalanceMonth = month;
      }
    }

    const contribAdjust = new Map<string, number>();
    const gainsAdjust = new Map<string, number>();
    let firstMonth: string | null = null;
    let firstBalance = 0;
    for (const month of sortedMonths) {
      const balance = latestBalanceByMonthAccount.get(flowKey(month, account.id));
      if (balance !== undefined) {
        firstMonth = month;
        firstBalance = balance;
        break;
      }
    }
    if (firstMonth !== null) {
      let flowsThrough = 0;
      for (const month of sortedMonths) {
        if (month > firstMonth) break;
        const flow = flows.get(flowKey(month, account.id));
        if (flow) flowsThrough += flow.contributions + flow.dividends + flow.interest;
      }
      const startingAmount = firstBalance - flowsThrough;
      if (startingAmount !== 0) contribAdjust.set(firstMonth, startingAmount);
      perAccount.set(account.id, { gainsByMonth, contribAdjust, gainsAdjust, firstMonth, startingAmount });
    } else {
      perAccount.set(account.id, { gainsByMonth, contribAdjust, gainsAdjust, firstMonth, startingAmount: 0 });
    }

    if (account.flow_treatment === 'contributions' || isCashLikeAccount(account)) {
      for (const [month, gain] of gainsByMonth) {
        if (gain !== 0) contribAdjust.set(month, (contribAdjust.get(month) ?? 0) + gain);
        gainsByMonth.set(month, 0);
      }
    }
  }

  const transferFacts = deriveTransferLinks({
    accounts,
    sortedMonths,
    flows,
    balances: latestBalanceByMonthAccount,
    seeds: new Map(
      [...perAccount].map(([account_id, state]) => [
        account_id,
        {
          account_id,
          firstMonth: state.firstMonth,
          startingAmount: state.startingAmount,
          contributionAdjustments: state.contribAdjust,
        },
      ])
    ),
    transactions: txs,
  });
  for (const adjustment of transferFacts.adjustments) {
    const accountState = perAccount.get(adjustment.account_id);
    if (!accountState) continue;
    accountState.contribAdjust.set(
      adjustment.month,
      (accountState.contribAdjust.get(adjustment.month) ?? 0) + adjustment.contributions_cents
    );
    accountState.gainsAdjust.set(
      adjustment.month,
      (accountState.gainsAdjust.get(adjustment.month) ?? 0) + adjustment.gains_cents
    );
  }

  const returns: ReturnSummary[] = [];
  for (const account of accounts) {
    if (isCashLikeAccount(account)) continue;
    const summary = summarizeReturns({
      account_id: account.id,
      balances: balanceSnapshots
        .filter(balance => balance.account_id === account.id)
        .map(balance => ({ date: balance.date, balance_cents: balance.balance_cents })),
      contribution_flows: txs
        .filter(tx => tx.account_id === account.id && classifyFlow(tx.description) === 'contribution')
        .map(tx => ({ date: normalizeDate(tx.date), amount_cents: tx.amount_cents })),
    });
    if (summary) returns.push(summary);
  }

  for (const account of accounts) {
    const accountState = perAccount.get(account.id)!;
    if (isCashLikeAccount(account)) {
      if (!accountsWithBalanceSnapshots.has(account.id)) continue;

      let previousBalance: number | null = null;
      for (const month of sortedMonths) {
        const endBalance = latestBalanceByMonthAccount.get(flowKey(month, account.id)) ?? null;
        if (endBalance === null) continue;
        const contributions = previousBalance === null ? endBalance : endBalance - previousBalance;
        previousBalance = endBalance;

        rows.push({
          month,
          account_id: account.id,
          contributions_cents: contributions,
          dividends_cents: 0,
          interest_cents: 0,
          gains_cents: 0,
          end_balance_cents: endBalance,
        });
      }
      continue;
    }

    for (const month of sortedMonths) {
      const flow = flows.get(flowKey(month, account.id)) ?? { contributions: 0, dividends: 0, interest: 0 };
      const contributionAdjustment = accountState.contribAdjust.get(month) ?? 0;
      const gainsAdjustment = accountState.gainsAdjust.get(month) ?? 0;
      const endBalance = latestBalanceByMonthAccount.get(flowKey(month, account.id)) ?? null;
      const gapGains = accountState.gainsByMonth.has(month) ? accountState.gainsByMonth.get(month)! : null;
      const gains = gainsAdjustment !== 0 ? (gapGains ?? 0) + gainsAdjustment : gapGains;
      const hasActivity = (
        flow.contributions !== 0 ||
        flow.dividends !== 0 ||
        flow.interest !== 0 ||
        contributionAdjustment !== 0 ||
        endBalance !== null ||
        gains !== null
      );
      if (!hasActivity) continue;

      rows.push({
        month,
        account_id: account.id,
        contributions_cents: flow.contributions + contributionAdjustment,
        dividends_cents: flow.dividends,
        interest_cents: flow.interest,
        gains_cents: gains,
        end_balance_cents: endBalance,
      });
    }
  }

  return { accounts, rows, transfer_links: transferFacts.links, returns };
}

export function getSavingsRateReport(): SavingsRateReport {
  const netWorth = getInvestmentNetWorthReport();
  const accountById = new Map(netWorth.accounts.map(account => [account.id, account]));
  const txs = getLedgerTransactions();

  const incomeByMonth = new Map<string, number>();
  const marketIncomeByMonth = new Map<string, number>();
  const sourceByLabel = new Map<string, SavingsRateIncomeSource>();
  const sourceByAccountLabel = new Map<string, SavingsRateIncomeSource & { account_id: number }>();
  const months = new Set<string>();
  const accountMonths = new Map<string, SavingsRateAccountMonth>();

  const accountMonthFor = (accountId: number, month: string) => {
    const key = `${accountId}\0${month}`;
    const current = accountMonths.get(key) ?? {
      account_id: accountId,
      month,
      income_cents: 0,
      market_income_cents: 0,
      investment_delta_cents: 0,
      cash_delta_cents: 0,
    };
    accountMonths.set(key, current);
    return current;
  };

  for (const tx of txs) {
    months.add(tx.month);
    if (!isExternalIncome(tx)) continue;

    incomeByMonth.set(tx.month, (incomeByMonth.get(tx.month) ?? 0) + tx.amount_cents);
    const accountMonth = accountMonthFor(tx.account_id, tx.month);
    accountMonth.income_cents += tx.amount_cents;
    if (isMarketIncome(tx.description)) {
      marketIncomeByMonth.set(tx.month, (marketIncomeByMonth.get(tx.month) ?? 0) + tx.amount_cents);
      accountMonth.market_income_cents += tx.amount_cents;
    }

    const label = incomeSourceLabel(tx.description);
    const source = sourceByLabel.get(label) ?? {
      label,
      amount_cents: 0,
      count: 0,
      is_market_income: isMarketIncome(tx.description),
    };
    source.amount_cents += tx.amount_cents;
    source.count += 1;
    source.is_market_income = source.is_market_income || isMarketIncome(tx.description);
    sourceByLabel.set(label, source);

    const accountSourceKey = `${tx.account_id}\0${label}`;
    const accountSource = sourceByAccountLabel.get(accountSourceKey) ?? {
      account_id: tx.account_id,
      label,
      amount_cents: 0,
      count: 0,
      is_market_income: isMarketIncome(tx.description),
    };
    accountSource.amount_cents += tx.amount_cents;
    accountSource.count += 1;
    accountSource.is_market_income = accountSource.is_market_income || isMarketIncome(tx.description);
    sourceByAccountLabel.set(accountSourceKey, accountSource);
  }

  const deltasByMonth = new Map<string, { investment: number; cash: number }>();
  for (const row of netWorth.rows) {
    months.add(row.month);
    const account = accountById.get(row.account_id);
    if (!account) continue;
    const deltas = deltasByMonth.get(row.month) ?? { investment: 0, cash: 0 };
    if (INVESTMENT_TYPES.has(account.type)) {
      deltas.investment += row.contributions_cents;
      accountMonthFor(row.account_id, row.month).investment_delta_cents += row.contributions_cents;
    } else if (CASH_TYPES.has(account.type)) {
      deltas.cash += row.contributions_cents;
      accountMonthFor(row.account_id, row.month).cash_delta_cents += row.contributions_cents;
    }
    deltasByMonth.set(row.month, deltas);
  }

  const firstIncomeMonth = [...incomeByMonth.keys()].sort()[0] ?? null;
  const rows = [...months]
    .filter(month => firstIncomeMonth === null || month >= firstIncomeMonth)
    .sort()
    .map((month): SavingsRateMonthlyRow => {
      const income_cents = incomeByMonth.get(month) ?? 0;
      const market_income_cents = marketIncomeByMonth.get(month) ?? 0;
      const deltas = deltasByMonth.get(month) ?? { investment: 0, cash: 0 };
      return {
        month,
        income_cents,
        market_income_cents,
        income_ex_market_gains_cents: income_cents - market_income_cents,
        ...periodAllocation({
          income_cents: income_cents - market_income_cents,
          investment_delta_cents: deltas.investment,
          cash_delta_cents: deltas.cash,
        }),
      };
    });

  return {
    accounts: netWorth.accounts.map(({ id, name, institution, type }) => ({ id, name, institution, type })),
    rows,
    account_months: [...accountMonths.values()].filter(row => firstIncomeMonth === null || row.month >= firstIncomeMonth),
    income_sources: [...sourceByLabel.values()].sort((a, b) => b.amount_cents - a.amount_cents),
    account_sources: [...sourceByAccountLabel.values()],
  };
}
