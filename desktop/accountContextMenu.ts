import type { ApplicationMenuItemConfig } from 'electrobun/main';

export function accountContextMenu(accountId: number): ApplicationMenuItemConfig[] {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error('Invalid account ID');
  return [{ label: 'Edit account…', action: 'edit-account', data: { accountId } }];
}

export function accountIdFromMenuEvent(event: unknown): number | null {
  if (!event || typeof event !== 'object' || !('data' in event)) return null;
  const payload = event.data;
  if (!payload || typeof payload !== 'object' || !('action' in payload) || payload.action !== 'edit-account' || !('data' in payload)) return null;
  const data = payload.data;
  if (!data || typeof data !== 'object' || !('accountId' in data)) return null;
  return typeof data.accountId === 'number' && Number.isSafeInteger(data.accountId) && data.accountId > 0 ? data.accountId : null;
}
