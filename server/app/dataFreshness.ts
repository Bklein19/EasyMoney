import { getDb } from '../database.js';

const STALE_AFTER_DAYS = 45;
const DUE_AFTER_DAYS = 30;

interface DataFreshnessRow {
  accountId: number;
  accountName: string;
  institution: string | null;
  accountType: string;
  accountStatus: string | null;
  latestTransactionDate: string | null;
  latestBalanceDate: string | null;
  transactionCount: number;
  balanceCount: number;
  latestImportFileName: string | null;
  latestParserName: string | null;
  latestSourceType: string | null;
  latestImportedAt: string | null;
}

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function daysBetween(fromDate: string | null, toDate: string) {
  if (!fromDate) return null;
  const from = new Date(`${fromDate.slice(0, 10)}T00:00:00Z`).getTime();
  const to = new Date(`${toDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, Math.floor((to - from) / 86_400_000));
}

function maxDate(...dates: Array<string | null>) {
  return dates.filter(Boolean).sort().at(-1) ?? null;
}

function statusFor(daysSinceLatestFact: number | null) {
  if (daysSinceLatestFact === null) return 'no-data';
  if (daysSinceLatestFact > STALE_AFTER_DAYS) return 'stale';
  if (daysSinceLatestFact > DUE_AFTER_DAYS) return 'due';
  return 'current';
}

function supportedDownloadsFor(institution: string | null, accountType: string) {
  const normalizedInstitution = String(institution || '').toLowerCase();
  const normalizedType = String(accountType || '').toLowerCase();
  const downloads = new Set<string>();

  if (['checking', 'savings', 'cash'].includes(normalizedType)) {
    downloads.add('Activity CSV');
  }
  if (['investment', 'retirement', 'brokerage'].includes(normalizedType)) {
    downloads.add('Activity export');
    downloads.add('Statement PDF');
  }

  if (normalizedInstitution.includes('bank of america')) {
    downloads.add('Activity CSV');
    downloads.add('Statement PDF');
  } else if (normalizedInstitution.includes('chase')) {
    downloads.add('Credit-card activity CSV');
  } else if (normalizedInstitution.includes('wells fargo')) {
    downloads.add('Activity CSV');
    downloads.add('Statement PDF');
  } else if (normalizedInstitution.includes('vanguard')) {
    downloads.add('Activity PDF');
    downloads.add('Statement PDF');
  } else if (normalizedInstitution.includes('fidelity')) {
    downloads.add('Statement PDF');
    downloads.add('Investment report PDF');
  } else if (normalizedInstitution.includes('merrill')) {
    downloads.add('Activity CSV');
    downloads.add('Statement PDF');
  } else if (normalizedInstitution.includes('morgan stanley')) {
    downloads.add('Activity PDF');
    downloads.add('Statement PDF');
  } else if (normalizedInstitution.includes('tiaa')) {
    downloads.add('Activity CSV');
    downloads.add('Statement PDF');
  } else if (normalizedInstitution.includes('marcus')) {
    downloads.add('Statement PDF');
  } else if (normalizedInstitution.includes('robinhood')) {
    downloads.add('Statement PDF');
    downloads.add('Banking or credit-card CSV');
  } else if (normalizedInstitution.includes('sequoia')) {
    downloads.add('Statement PDF');
  }

  return Array.from(downloads);
}

export function getDataFreshnessReport(options: { today?: string } = {}) {
  const today = options.today || isoDate(new Date());
  const rows = getDb().prepare(`
    WITH transactionFacts AS (
      SELECT
        sa.accountId,
        MAX(st.date) AS latestTransactionDate,
        COUNT(st.id) AS transactionCount
      FROM sourceTransactions st
      JOIN sourceAccounts sa ON sa.id = st.sourceAccountId
      JOIN sourceFiles sf ON sf.id = st.sourceFileId
      WHERE sa.accountId IS NOT NULL
        AND sf.status = 'committed'
      GROUP BY sa.accountId
    ),
    balanceFacts AS (
      SELECT
        sa.accountId,
        MAX(sb.date) AS latestBalanceDate,
        COUNT(sb.id) AS balanceCount
      FROM sourceBalances sb
      JOIN sourceAccounts sa ON sa.id = sb.sourceAccountId
      JOIN sourceFiles sf ON sf.id = sb.sourceFileId
      WHERE sa.accountId IS NOT NULL
        AND sf.status = 'committed'
      GROUP BY sa.accountId
    )
    SELECT
      a.id AS accountId,
      a.name AS accountName,
      a.institution,
      a.type AS accountType,
      a.status AS accountStatus,
      tf.latestTransactionDate,
      bf.latestBalanceDate,
      COALESCE(tf.transactionCount, 0) AS transactionCount,
      COALESCE(bf.balanceCount, 0) AS balanceCount,
      (
        SELECT sf.fileName
        FROM sourceAccounts sa
        JOIN sourceFiles sf ON sf.id = sa.sourceFileId
        WHERE sa.accountId = a.id
          AND sf.status = 'committed'
        ORDER BY COALESCE(sf.committedAt, sf.createdAt) DESC, sf.id DESC
        LIMIT 1
      ) AS latestImportFileName,
      (
        SELECT sf.parserName
        FROM sourceAccounts sa
        JOIN sourceFiles sf ON sf.id = sa.sourceFileId
        WHERE sa.accountId = a.id
          AND sf.status = 'committed'
        ORDER BY COALESCE(sf.committedAt, sf.createdAt) DESC, sf.id DESC
        LIMIT 1
      ) AS latestParserName,
      (
        SELECT sf.sourceType
        FROM sourceAccounts sa
        JOIN sourceFiles sf ON sf.id = sa.sourceFileId
        WHERE sa.accountId = a.id
          AND sf.status = 'committed'
        ORDER BY COALESCE(sf.committedAt, sf.createdAt) DESC, sf.id DESC
        LIMIT 1
      ) AS latestSourceType,
      (
        SELECT COALESCE(sf.committedAt, sf.createdAt)
        FROM sourceAccounts sa
        JOIN sourceFiles sf ON sf.id = sa.sourceFileId
        WHERE sa.accountId = a.id
          AND sf.status = 'committed'
        ORDER BY COALESCE(sf.committedAt, sf.createdAt) DESC, sf.id DESC
        LIMIT 1
      ) AS latestImportedAt
    FROM accounts a
    LEFT JOIN transactionFacts tf ON tf.accountId = a.id
    LEFT JOIN balanceFacts bf ON bf.accountId = a.id
    WHERE COALESCE(a.status, 'active') != 'archived'
    ORDER BY COALESCE(a.institution, ''), a.name, a.id
  `).all() as DataFreshnessRow[];

  const accounts = rows.map(row => {
    const latestFactDate = maxDate(row.latestTransactionDate, row.latestBalanceDate);
    const daysSinceLatestFact = daysBetween(latestFactDate, today);
    const status = statusFor(daysSinceLatestFact);
    return {
      accountId: row.accountId,
      accountName: row.accountName,
      institution: row.institution,
      accountType: row.accountType,
      accountStatus: row.accountStatus || 'active',
      latestTransactionDate: row.latestTransactionDate,
      latestBalanceDate: row.latestBalanceDate,
      latestFactDate,
      daysSinceLatestFact,
      status,
      transactionCount: row.transactionCount,
      balanceCount: row.balanceCount,
      latestImportFileName: row.latestImportFileName,
      latestParserName: row.latestParserName,
      latestSourceType: row.latestSourceType,
      latestImportedAt: row.latestImportedAt,
      suggestedDownloads: supportedDownloadsFor(row.institution, row.accountType),
    };
  });

  const summary = accounts.reduce(
    (current, account) => ({
      totalAccounts: current.totalAccounts + 1,
      currentAccounts: current.currentAccounts + (account.status === 'current' ? 1 : 0),
      dueAccounts: current.dueAccounts + (account.status === 'due' ? 1 : 0),
      staleAccounts: current.staleAccounts + (account.status === 'stale' ? 1 : 0),
      noDataAccounts: current.noDataAccounts + (account.status === 'no-data' ? 1 : 0),
    }),
    { totalAccounts: 0, currentAccounts: 0, dueAccounts: 0, staleAccounts: 0, noDataAccounts: 0 }
  );

  return {
    today,
    dueAfterDays: DUE_AFTER_DAYS,
    staleAfterDays: STALE_AFTER_DAYS,
    summary,
    accounts,
  };
}
