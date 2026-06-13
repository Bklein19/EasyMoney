import React, { useMemo } from "react";

export interface PickerAccount {
  id: number;
  name: string;
  institution: string;
  type: string;
  account_holder: string | null;
}

// Shared account picker: a wrap-row of per-account chips plus quick-select holder
// shortcuts. Shortcuts are bulk-toggles over the same per-account selection.
export function AccountPicker({
  accounts,
  selectedIds,
  onChange,
}: {
  accounts: PickerAccount[];
  selectedIds: Set<number>;
  onChange: (next: Set<number>) => void;
}) {
  const holders = useMemo(() => {
    const holderMap = new Map<string, number[]>();
    for (const a of accounts) {
      if (a.account_holder) {
        const arr = holderMap.get(a.account_holder) ?? [];
        arr.push(a.id);
        holderMap.set(a.account_holder, arr);
      }
    }
    return [...holderMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [accounts]);

  const allIds = accounts.map((a) => a.id);
  const setExactly = (ids: number[]) => onChange(new Set(ids));
  const toggle = (id: number, invert: boolean) => {
    if (invert) {
      onChange(new Set(allIds.filter((x) => !selectedIds.has(x))));
      return;
    }
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  // A shortcut is "active" when the current selection is exactly its account set.
  const isExactly = (ids: number[]) =>
    ids.length === selectedIds.size && ids.every((id) => selectedIds.has(id));

  return (
    <div className="account-picker">
      <div className="account-picker-shortcuts">
        <button type="button" onClick={() => setExactly(allIds)}>All</button>
        <button type="button" onClick={() => setExactly([])}>None</button>
        <button type="button" onClick={() => onChange(new Set(allIds.filter((x) => !selectedIds.has(x))))}>
          Invert
        </button>
        {holders.map(([holder, ids]) => (
          <button
            key={`holder-${holder}`}
            type="button"
            className={`shortcut-chip${isExactly(ids) ? " active" : ""}`}
            onClick={() => setExactly(ids)}
            title={`Select only ${holder}'s accounts`}
          >
            {holder}
          </button>
        ))}
      </div>
      <div className="account-filter">
        {accounts.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`account-chip${selectedIds.has(a.id) ? " active" : ""}`}
            aria-pressed={selectedIds.has(a.id)}
            title="Option-click any account to invert the selection"
            onClick={(e) => toggle(a.id, e.altKey)}
          >
            <span className="account-chip-name">{a.name}</span>
            {a.account_holder && <span className="account-chip-holder">{a.account_holder}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
