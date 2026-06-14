import { getDb } from '../database.js';
import type { AccountListResponse, AccountSummary } from './types';

interface AccountRow {
  id: number;
  name: string;
  institution: string | null;
  type: string;
  currentBalance: number | null;
  currency: string | null;
  updatedAt: string | null;
}

function toAccountSummary(row: AccountRow): AccountSummary {
  return {
    id: row.id,
    name: row.name,
    institution: row.institution,
    type: row.type,
    balance: row.currentBalance ?? 0,
    currency: row.currency ?? 'USD',
    updatedAt: row.updatedAt,
  };
}

export function listAccounts(): AccountListResponse {
  const rows = getDb()
    .prepare(
      `SELECT id, name, institution, type, currentBalance, currency, updatedAt
       FROM accounts
       ORDER BY name ASC, id ASC`
    )
    .all() as AccountRow[];

  return { accounts: rows.map(toAccountSummary) };
}
