import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const SidebarSlotContext = createContext<{
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
}>({ target: null, setTarget: () => {} });

export function SidebarContextProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return <SidebarSlotContext.Provider value={{ target, setTarget }}>{children}</SidebarSlotContext.Provider>;
}

export function SidebarContextSlot() {
  const { setTarget } = useContext(SidebarSlotContext);
  return <div ref={setTarget} />;
}

export function SidebarContent({ children }: { children: ReactNode }) {
  const { target } = useContext(SidebarSlotContext);
  return target ? createPortal(children, target) : null;
}

export function SidebarAccountList({ accounts, value, onChange }: {
  accounts: { id: number; name: string; institution?: string | null; status?: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return <SidebarContent>
    <section aria-label="Accounts" className="sidebar-context-section">
      <h2 className="sidebar-context-title">Accounts</h2>
      <button className={`sidebar-link ${!value ? 'active' : ''}`} aria-pressed={!value} onClick={() => onChange('')}>All accounts</button>
      {accounts.filter(account => account.status !== 'archived').map(account => <button
        key={account.id} className={`sidebar-link sidebar-context-account ${value === String(account.id) ? 'active' : ''}`}
        aria-pressed={value === String(account.id)} onClick={() => onChange(String(account.id))}>
        <span>{account.name}</span><small>{account.institution}</small>
      </button>)}
    </section>
  </SidebarContent>;
}
