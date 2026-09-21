import type { ApplicationMenuItemConfig } from 'electrobun/main';
import type { AccountMenuRequest } from './rpc';

export function accountContextMenu({ accountId, name, institution, owner }: AccountMenuRequest): ApplicationMenuItemConfig[] {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error('Invalid account ID');
  const metadata = [institution?.trim(), owner?.trim()].filter(Boolean).join(' · ');
  return [
    { label: name.trim() || 'Account', enabled: false },
    ...(metadata ? [{ label: metadata, enabled: false }] : []),
    { type: 'divider' },
    { label: 'Edit…', action: 'edit-account', data: { accountId } },
  ];
}

export function accountIdFromMenuEvent(event: unknown): number | null {
  if (!event || typeof event !== 'object' || !('data' in event)) return null;
  const payload = event.data;
  if (!payload || typeof payload !== 'object' || !('action' in payload) || payload.action !== 'edit-account' || !('data' in payload)) return null;
  const data = payload.data;
  if (!data || typeof data !== 'object' || !('accountId' in data)) return null;
  return typeof data.accountId === 'number' && Number.isSafeInteger(data.accountId) && data.accountId > 0 ? data.accountId : null;
}
