import { getDb } from '../database.js';
import type { AccountListResponse, AccountSummary } from './types';

interface AccountRow {
  id: number;
  name: string;
  institution: string | null;
  type: string;
  balanceCents: number | null;
  currency: string | null;
  status: string | null;
  archivedAt: string | null;
  updatedAt: string | null;
}

export interface ListAccountsOptions {
  includeArchived?: boolean;
}

function toAccountSummary(row: AccountRow): AccountSummary {
  return {
    id: row.id,
    name: row.name,
    institution: row.institution,
    type: row.type,
    balance: row.balanceCents === null ? 0 : row.balanceCents / 100,
    currency: row.currency ?? 'USD',
    status: row.status ?? 'active',
    archivedAt: row.archivedAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeAccountMetadata(changes: Record<string, unknown>) {
  const allowed = new Set(['name', 'institution', 'type', 'currency']);
  const unsupported = Object.keys(changes).filter(field => !allowed.has(field));
  if (unsupported.length) {
    throw new Error(`Accounts only support metadata updates: ${unsupported.join(', ')}`);
  }

  const normalized: Record<string, string | null> = {};
  if ('name' in changes) {
    const name = String(changes.name || '').trim();
    if (!name) throw new Error('Account name is required.');
    normalized.name = name;
  }
  if ('institution' in changes) {
    const institution = changes.institution === null || changes.institution === undefined
      ? null
      : String(changes.institution).trim() || null;
    normalized.institution = institution;
  }
  if ('type' in changes) {
    const type = String(changes.type || '').trim();
    if (!type) throw new Error('Account type is required.');
    normalized.type = type;
  }
  if ('currency' in changes) {
    const currency = String(changes.currency || '').trim().toUpperCase();
    if (!currency) throw new Error('Account currency is required.');
    normalized.currency = currency;
  }

  return normalized;
}

function assertAccountExists(id: number) {
  const account = getDb().prepare('SELECT id FROM accounts WHERE id = ?').get(id) as { id: number } | undefined;
  if (!account) throw new Error(`Account not found: ${id}`);
}

export function listAccounts(options: ListAccountsOptions = {}): AccountListResponse {
  const where = options.includeArchived ? '' : "WHERE COALESCE(a.status, 'active') != 'archived'";
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
         COALESCE(a.status, 'active') AS status,
         a.archivedAt,
         a.updatedAt
       FROM accounts a
       ${where}
       ORDER BY a.name ASC, a.id ASC`
    )
    .all() as AccountRow[];

  return { accounts: rows.map(toAccountSummary) };
}

export function updateAccountMetadata(id: number | string, changes: Record<string, unknown>) {
  const accountId = Number(id);
  if (!Number.isFinite(accountId)) throw new Error('Invalid account id');
  const metadata = normalizeAccountMetadata(changes);
  assertAccountExists(accountId);
  if (!Object.keys(metadata).length) return { ok: true, accountId };

  getDb().prepare(`
    UPDATE accounts
    SET ${Object.keys(metadata).map(field => `${field} = @${field}`).join(', ')},
        updatedAt = @updatedAt
    WHERE id = @id
  `).run({
    ...metadata,
    updatedAt: new Date().toISOString(),
    id: accountId,
  });

  return { ok: true, accountId };
}

export function archiveAccount(id: number | string) {
  const accountId = Number(id);
  if (!Number.isFinite(accountId)) throw new Error('Invalid account id');
  assertAccountExists(accountId);
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE accounts
    SET status = 'archived',
        archivedAt = COALESCE(archivedAt, @now),
        updatedAt = @now
    WHERE id = @id
  `).run({ id: accountId, now });
  return { ok: true, accountId };
}

export function unarchiveAccount(id: number | string) {
  const accountId = Number(id);
  if (!Number.isFinite(accountId)) throw new Error('Invalid account id');
  assertAccountExists(accountId);
  getDb().prepare(`
    UPDATE accounts
    SET status = 'active',
        archivedAt = NULL,
        updatedAt = @now
    WHERE id = @id
  `).run({ id: accountId, now: new Date().toISOString() });
  return { ok: true, accountId };
}
