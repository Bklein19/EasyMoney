import { useCallback, useMemo, useState, type MouseEvent } from 'react';
import { AccountContextMenu } from './AccountContextMenu';
import { selectAccountIds } from './accountSelection';
import { Check } from 'lucide-react';

export interface PickerAccount {
  id: number;
  name: string;
  institution?: string | null;
  type?: string;
  account_holder?: string | null;
}

type AccountPickerProps = {
  accounts: PickerAccount[];
  variant?: 'chips' | 'owner-groups';
} & ({
  selectionMode: 'single';
  selectedId: number | null;
  onChange: (next: number | null) => void;
} | {
  selectionMode: 'multiple';
  selectedIds: Set<number>;
  onChange: (next: Set<number>) => void;
});

export function AccountPicker(props: AccountPickerProps) {
  const { accounts, variant = 'owner-groups' } = props;
  const selectedIds = props.selectionMode === 'multiple'
    ? props.selectedIds : new Set(props.selectedId === null ? [] : [props.selectedId]);
  const selectionHint = props.selectionMode === 'multiple'
    ? 'Click to select; Command/Ctrl-click to toggle; Shift-click for a range; Command/Ctrl-A for all'
    : 'Select this account';
  const [lastClickedId, setLastClickedId] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ id: number; name: string; metadata: string; x: number; y: number } | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const openContextMenu = (account: PickerAccount, event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.focus();
    const rect = event.currentTarget.getBoundingClientRect();
    const menu = { id: account.id, name: account.name, metadata: [account.institution, account.account_holder].filter(Boolean).join(' · '), x: event.clientX || rect.left, y: event.clientY || rect.bottom };
    setContextMenu(menu);
  };

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
    ? ownerGroups.flatMap(([, items]) => items.map(account => account.id))
    : allIds;

  const selectAccount = (id: number, event: MouseEvent<HTMLButtonElement>) => {
    if (props.selectionMode === 'single') {
      props.onChange(id);
      return;
    }
    if (!event.shiftKey || lastClickedId === null || !visibleIds.includes(lastClickedId)) setLastClickedId(id);
    props.onChange(selectAccountIds(visibleIds, selectedIds, lastClickedId, id, { shift: event.shiftKey, additive: event.metaKey || event.ctrlKey }));
  };

  return (
    <div
      className={`account-picker account-picker--${variant}`}
      tabIndex={-1}
      onKeyDown={event => {
        if (!event.defaultPrevented && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
          event.preventDefault();
          event.stopPropagation();
          if (props.selectionMode === 'single') props.onChange(null);
          else props.onChange(new Set(allIds));
          setLastClickedId(null);
        }
      }}
    >
      {props.selectionMode === 'single' && (
        <button type="button" className={`account-row-picker ${props.selectedId === null ? 'active' : ''}`}
          aria-pressed={props.selectedId === null} onClick={() => props.onChange(null)}>
          <Check size={13} className="account-row-picker__selection" aria-hidden="true" />
          <span className="account-row-picker__name">All accounts</span>
        </button>
      )}
      {variant === 'owner-groups' ? (
        <div className="account-filter account-filter--owner-groups">
          {ownerGroups.map(([owner, ownerAccounts]) => (
            <section className="account-owner-group" key={owner} aria-label={owner}>
              <h3 className="account-owner-group__header">
                <span>{owner}</span>
                {props.selectionMode === 'multiple' && <span className="account-owner-count">{ownerAccounts.filter(account => selectedIds.has(account.id)).length}/{ownerAccounts.length}</span>}
              </h3>
              <div className="account-owner-group__list">
                {ownerAccounts.map(account => (
                  <button
                    key={account.id}
                    type="button"
                    className={selectedIds.has(account.id) ? 'account-row-picker active' : 'account-row-picker'}
                    aria-pressed={selectedIds.has(account.id)}
                    title={selectionHint}
                    onClick={event => selectAccount(account.id, event)}
                    onContextMenu={event => openContextMenu(account, event)}
                  >
                    <Check size={13} className="account-row-picker__selection" aria-hidden="true" />
                    <span className="account-row-picker__name">{account.name}</span>
                    <span className="account-row-picker__meta">{account.institution}</span>
                  </button>
                ))}
              </div>
            </section>
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
              title={selectionHint}
              onClick={event => selectAccount(account.id, event)}
              onContextMenu={event => openContextMenu(account, event)}
            >
              <span className="account-chip-name">{account.name}</span>
              {account.account_holder?.trim() && (
                <span className="account-chip-holder">{account.account_holder}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {contextMenu && <AccountContextMenu {...contextMenu} onClose={closeContextMenu} />}
    </div>
  );
}
