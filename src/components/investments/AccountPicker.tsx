import { useMemo, useState, type MouseEvent } from 'react';
import { selectAccountIds } from './accountSelection';
import { Check, ChevronRight, Folder } from 'lucide-react';

export interface PickerAccount {
  id: number;
  name: string;
  institution: string;
  type: string;
  account_holder?: string | null;
}

export function AccountPicker({
  accounts,
  selectedIds,
  onChange,
  variant = 'chips',
}: {
  accounts: PickerAccount[];
  selectedIds: Set<number>;
  onChange: (next: Set<number>) => void;
  variant?: 'chips' | 'owner-groups';
}) {
  const [lastClickedId, setLastClickedId] = useState<number | null>(null);
  const [collapsedOwners, setCollapsedOwners] = useState<Set<string>>(new Set());

  const allIds = useMemo(() => accounts.map(account => account.id), [accounts]);
  const ownerGroups = useMemo(() => {
    const groups = new Map<string, PickerAccount[]>();
    for (const account of accounts) {
      const owner = account.account_holder?.trim() || 'No owner';
      const group = groups.get(owner) ?? [];
      group.push(account);
      groups.set(owner, group);
    }
    return [...groups.entries()].sort((a, b) => {
      if (a[0] === 'No owner') return 1;
      if (b[0] === 'No owner') return -1;
      return a[0].localeCompare(b[0]);
    });
  }, [accounts]);

  const visibleIds = variant === 'owner-groups'
    ? ownerGroups.filter(([owner]) => !collapsedOwners.has(owner)).flatMap(([, items]) => items.map(account => account.id))
    : allIds;

  const selectAccount = (id: number, event: MouseEvent<HTMLButtonElement>) => {
    if (!event.shiftKey || lastClickedId === null || !visibleIds.includes(lastClickedId)) setLastClickedId(id);
    onChange(selectAccountIds(visibleIds, selectedIds, lastClickedId, id, { shift: event.shiftKey, additive: event.metaKey || event.ctrlKey }));
  };

  return (
    <div
      className={`account-picker account-picker--${variant}`}
      tabIndex={-1}
      onKeyDown={event => {
        if (!event.defaultPrevented && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
          event.preventDefault();
          event.stopPropagation();
          onChange(new Set(allIds));
          setLastClickedId(null);
        }
      }}
    >
      {variant === 'owner-groups' ? (
        <div className="account-filter account-filter--owner-groups">
          {ownerGroups.map(([owner, ownerAccounts]) => (
            <details className="account-owner-group" key={owner} open={!collapsedOwners.has(owner)} onToggle={event => {
              const open = event.currentTarget.open;
              setCollapsedOwners(current => {
                if (current.has(owner) === !open) return current;
                const next = new Set(current);
                if (open) next.delete(owner);
                else next.add(owner);
                return next;
              });
            }}>
              <summary className="account-owner-group__header">
                <ChevronRight size={13} className="account-owner-chevron" aria-hidden="true" />
                <Folder size={16} aria-hidden="true" />
                <span>{owner}</span>
                <span className="account-owner-count">{ownerAccounts.filter(account => selectedIds.has(account.id)).length}/{ownerAccounts.length}</span>
              </summary>
              <div className="account-owner-group__list">
                {ownerAccounts.map(account => (
                  <button
                    key={account.id}
                    type="button"
                    className={selectedIds.has(account.id) ? 'account-row-picker active' : 'account-row-picker'}
                    aria-pressed={selectedIds.has(account.id)}
                    title="Click to select; Command/Ctrl-click to toggle; Shift-click for a range; Command/Ctrl-A for all"
                    onClick={event => selectAccount(account.id, event)}
                  >
                    <Check size={13} className="account-row-picker__selection" aria-hidden="true" />
                    <span className="account-row-picker__name">{account.name}</span>
                    <span className="account-row-picker__meta">{account.type}</span>
                  </button>
                ))}
              </div>
            </details>
          ))}
        </div>
      ) : (
        <div className="account-filter">
          {accounts.map(account => (
            <button
              key={account.id}
              type="button"
              className={selectedIds.has(account.id) ? 'account-chip active' : 'account-chip'}
              aria-pressed={selectedIds.has(account.id)}
              title="Click to select; Command/Ctrl-click to toggle; Shift-click for a range; Command/Ctrl-A for all"
              onClick={event => selectAccount(account.id, event)}
            >
              <span className="account-chip-name">{account.name}</span>
              {account.account_holder?.trim() && (
                <span className="account-chip-holder">{account.account_holder}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
