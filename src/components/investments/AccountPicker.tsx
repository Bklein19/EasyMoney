import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';

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
}: {
  accounts: PickerAccount[];
  selectedIds: Set<number>;
  onChange: (next: Set<number>) => void;
}) {
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const pickerActive = useRef(false);
  const [lastClickedId, setLastClickedId] = useState<number | null>(null);

  const allIds = useMemo(() => accounts.map(account => account.id), [accounts]);
  const holders = useMemo(() => {
    const holderMap = new Map<string, number[]>();
    for (const account of accounts) {
      if (!account.account_holder) continue;
      const ids = holderMap.get(account.account_holder) ?? [];
      ids.push(account.id);
      holderMap.set(account.account_holder, ids);
    }
    return [...holderMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [accounts]);

  const setExactly = (ids: number[]) => {
    setLastClickedId(null);
    onChange(new Set(ids));
  };

  const invertSelection = () => {
    setLastClickedId(null);
    onChange(new Set(allIds.filter(id => !selectedIds.has(id))));
  };

  const rangeBetween = (fromId: number, toId: number) => {
    const from = allIds.indexOf(fromId);
    const to = allIds.indexOf(toId);
    if (from === -1 || to === -1) return [toId];
    return allIds.slice(Math.min(from, to), Math.max(from, to) + 1);
  };

  const isExactly = (ids: number[]) =>
    ids.length === selectedIds.size && ids.every(id => selectedIds.has(id));

  const selectAccount = (id: number, event: MouseEvent<HTMLButtonElement>) => {
    setLastClickedId(id);
    if (event.altKey) {
      invertSelection();
      return;
    }
    if (event.shiftKey && lastClickedId !== null) {
      const range = rangeBetween(lastClickedId, id);
      onChange(event.metaKey || event.ctrlKey ? new Set([...selectedIds, ...range]) : new Set(range));
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onChange(next);
      return;
    }
    onChange(new Set([id]));
  };

  useEffect(() => {
    const isInPicker = (target: EventTarget | null) =>
      target instanceof Node && Boolean(pickerRef.current?.contains(target));
    const handlePointerDown = (event: PointerEvent) => {
      pickerActive.current = isInPicker(event.target);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!pickerActive.current || event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setExactly(allIds);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [allIds]);

  return (
    <div
      ref={pickerRef}
      className="account-picker"
      tabIndex={-1}
      onFocusCapture={() => {
        pickerActive.current = true;
      }}
    >
      <div className="account-picker-shortcuts">
        <button type="button" onClick={() => setExactly(allIds)}>All</button>
        <button type="button" onClick={() => setExactly([])}>None</button>
        <button type="button" onClick={invertSelection}>Invert</button>
        {holders.map(([holder, ids]) => (
          <button
            key={holder}
            type="button"
            className={isExactly(ids) ? 'active' : ''}
            title={`Select only ${holder}'s accounts`}
            onClick={() => setExactly(ids)}
          >
            {holder}
          </button>
        ))}
      </div>

      <div className="account-filter">
        {accounts.map(account => (
          <button
            key={account.id}
            type="button"
            className={selectedIds.has(account.id) ? 'account-chip active' : 'account-chip'}
            aria-pressed={selectedIds.has(account.id)}
            title="Command-click to toggle, Shift-click to select a range, Option-click to invert"
            onClick={event => selectAccount(account.id, event)}
          >
            <span className="account-chip-name">{account.name}</span>
            <span className="account-chip-meta">{account.institution || account.type}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
