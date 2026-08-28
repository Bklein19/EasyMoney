import { getDb } from '../../database.ts';
import type { SyncAccountCoverage } from './connector.ts';

interface SyncAccountCoverageRow {
  id: number;
  name: string;
  institution: string | null;
  type: string;
  last4: string | null;
  latestFactDate: string | null;
  earliestFactDate: string | null;
  latestBalanceDate: string | null;
  earliestBalanceDate: string | null;
  balanceDates: string | null;
  sourceAccountName: string | null;
  sourceAccountNames: string | null;
  accountAliases: string | null;
  accountHolder: string | null;
}

function splitValues(value: string | null, separator: string): string[] {
  return value?.split(separator).map(item => item.trim()).filter(Boolean) ?? [];
}

export function loadSyncAccountCoverage(): SyncAccountCoverage[] {
  const rows = getDb().prepare(`
    WITH facts AS (
      SELECT sa.accountId, st.date, 'transaction' AS factType
      FROM sourceTransactions st
      JOIN sourceAccounts sa ON sa.id = st.sourceAccountId
      JOIN sourceFiles sf ON sf.id = st.sourceFileId AND sf.status = 'committed'
      UNION ALL
      SELECT sa.accountId, sb.date, 'balance' AS factType
      FROM sourceBalances sb
      JOIN sourceAccounts sa ON sa.id = sb.sourceAccountId
      JOIN sourceFiles sf ON sf.id = sb.sourceFileId AND sf.status = 'committed'
    )
    SELECT
      a.id,
      a.name,
      a.institution,
      a.type,
      a.last4,
      a.accountHolder,
      MIN(f.date) AS earliestFactDate,
      MAX(f.date) AS latestFactDate,
      MIN(CASE WHEN f.factType = 'balance' THEN f.date END) AS earliestBalanceDate,
      MAX(CASE WHEN f.factType = 'balance' THEN f.date END) AS latestBalanceDate,
      GROUP_CONCAT(DISTINCT CASE WHEN f.factType = 'balance' THEN SUBSTR(f.date, 1, 10) END) AS balanceDates,
      (
        SELECT sa2.sourceAccountName
        FROM sourceAccounts sa2
        JOIN sourceFiles sf2 ON sf2.id = sa2.sourceFileId
        WHERE sa2.accountId = a.id
        ORDER BY COALESCE(sf2.committedAt, sf2.createdAt) DESC, sf2.id DESC
        LIMIT 1
      ) AS sourceAccountName,
      (
        SELECT GROUP_CONCAT(sa3.sourceAccountName, '|')
        FROM sourceAccounts sa3
        WHERE sa3.accountId = a.id AND NULLIF(TRIM(sa3.sourceAccountName), '') IS NOT NULL
      ) AS sourceAccountNames,
      (
        SELECT GROUP_CONCAT(aa.alias, '|')
        FROM accountAliases aa
        WHERE aa.accountId = a.id AND NULLIF(TRIM(aa.alias), '') IS NOT NULL
      ) AS accountAliases
    FROM accounts a
    LEFT JOIN facts f ON f.accountId = a.id
    WHERE COALESCE(a.status, 'active') = 'active'
    GROUP BY a.id
    ORDER BY a.id
  `).all() as SyncAccountCoverageRow[];

  const artifactRows = getDb().prepare(`
    SELECT sa.accountId, sf.fileName
    FROM sourceAccounts sa
    JOIN sourceFiles sf ON sf.id = sa.sourceFileId
    JOIN accounts a ON a.id = sa.accountId
    WHERE sa.accountId IS NOT NULL
      AND COALESCE(a.status, 'active') = 'active'
    ORDER BY sa.accountId, COALESCE(sf.committedAt, sf.createdAt) DESC, sf.id DESC
  `).all() as Array<{ accountId: number; fileName: string }>;
  const artifactFileNames = new Map<number, string[]>();
  for (const row of artifactRows) {
    const names = artifactFileNames.get(row.accountId) ?? [];
    names.push(row.fileName);
    artifactFileNames.set(row.accountId, names);
  }

  return rows.map(row => ({
    ...row,
    balanceDates: splitValues(row.balanceDates, ','),
    sourceAccountNames: splitValues(row.sourceAccountNames, '|'),
    accountAliases: splitValues(row.accountAliases, '|'),
    artifactFileNames: artifactFileNames.get(row.id) ?? [],
  }));
}
