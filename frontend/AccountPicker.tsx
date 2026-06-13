import React, { useEffect, useMemo, useRef, useState } from "react";

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
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const pickerActive = useRef(false);
  const [lastClickedId, setLastClickedId] = useState<number | null>(null);
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

  const allIds = useMemo(() => accounts.map((a) => a.id), [accounts]);
  const setExactly = (ids: number[]) => {
    setLastClickedId(null);
    onChange(new Set(ids));
  };
  const invertSelection = () => {
    setLastClickedId(null);
    onChange(new Set(allIds.filter((x) => !selectedIds.has(x))));
  };
  const rangeBetween = (fromId: number, toId: number) => {
    const from = allIds.indexOf(fromId);
    const to = allIds.indexOf(toId);
    if (from === -1 || to === -1) return [toId];
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    return allIds.slice(start, end + 1);
  };
  const selectAccount = (id: number, e: React.MouseEvent<HTMLButtonElement>) => {
    setLastClickedId(id);
    if (e.altKey) {
      invertSelection();
      return;
    }
    if (e.shiftKey && lastClickedId !== null) {
      const range = rangeBetween(lastClickedId, id);
      onChange(e.metaKey || e.ctrlKey ? new Set([...selectedIds, ...range]) : new Set(range));
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onChange(next);
      return;
    }
    onChange(new Set([id]));
  };

  // A shortcut is "active" when the current selection is exactly its account set.
  const isExactly = (ids: number[]) =>
    ids.length === selectedIds.size && ids.every((id) => selectedIds.has(id));

  useEffect(() => {
    const isInPicker = (target: EventTarget | null) =>
      target instanceof Node && pickerRef.current?.contains(target);
    const handlePointerDown = (e: PointerEvent) => {
      pickerActive.current = Boolean(isInPicker(e.target));
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!pickerActive.current || e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setLastClickedId(null);
        onChange(new Set(allIds));
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [allIds, onChange]);

  return (
    <div
      ref={pickerRef}
      className="account-picker"
      tabIndex={-1}
      onFocusCapture={() => {
        pickerActive.current = true;
      }}
      onKeyDown={(e) => {
        if (e.defaultPrevented) return;
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
          e.preventDefault();
          setExactly(allIds);
        }
      }}
    >
      <div className="account-picker-shortcuts">
        <button type="button" onClick={() => setExactly(allIds)}>All</button>
        <button type="button" onClick={() => setExactly([])}>None</button>
        <button type="button" onClick={invertSelection}>
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
            title="Command-click to toggle, Shift-click to select a range, Option-click to invert"
            onClick={(e) => selectAccount(a.id, e)}
          >
            <span className="account-chip-name">{a.name}</span>
            {a.account_holder && <span className="account-chip-holder">{a.account_holder}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
