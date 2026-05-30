import { add, apiAction, update } from '../db/api';
import { useApiTable } from './useApiTable';

export function useAccounts() {
  const accounts = useApiTable('accounts');

  async function addAccount(account) {
    return add('accounts', {
      ...account,
      currentBalance: account.currentBalance || 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  async function updateAccount(id, changes) {
    return update('accounts', id, {
      ...changes,
      updatedAt: new Date().toISOString(),
    });
  }

  async function deleteAccount(id) {
    return apiAction(`/accounts/${id}/deep`, { method: 'DELETE' });
  }

  async function updateBalance(id, newBalance) {
    return update('accounts', id, {
      currentBalance: newBalance,
      updatedAt: new Date().toISOString(),
    });
  }

  return { accounts, addAccount, updateAccount, deleteAccount, updateBalance };
}
