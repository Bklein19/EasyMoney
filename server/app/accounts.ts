import { getDb } from '../database.js';
import type { AccountListResponse, AccountSummary } from './types';

interface AccountRow {
  id: number;
  name: string;
  institution: string | null;
  type: string;
  balanceCents: number | null;
  currency: string | null;
  updatedAt: string | null;
}

function toAccountSummary(row: AccountRow): AccountSummary {
  return {
    id: row.id,
    name: row.name,
    institution: row.institution,
    type: row.type,
    balance: row.balanceCents === null ? 0 : row.balanceCents / 100,
    currency: row.currency ?? 'USD',
    updatedAt: row.updatedAt,
  };
}

export function listAccounts(): AccountListResponse {
  const rows = getDb()
    .prepare(
      `SELECT
         a.id,
         a.name,
         a.institution,
         a.type,
         (
           SELECT lb.balanceCents
           FROM ledgerBalances lb
           WHERE lb.accountId = a.id
           ORDER BY lb.month DESC, lb.id DESC
           LIMIT 1
         ) AS balanceCents,
         a.currency,
         a.updatedAt
       FROM accounts a
       ORDER BY a.name ASC, a.id ASC`
    )
    .all() as AccountRow[];

  return { accounts: rows.map(toAccountSummary) };
}
