import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { AccountPicker, type PickerAccount } from '../investments/AccountPicker';

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
  accounts: (PickerAccount & { status?: string; accountHolder?: string | null })[];
  value: number[] | undefined;
  onChange: (value: number[]) => void;
}) {
  return <SidebarContent>
    <section aria-label="Accounts" className="sidebar-context-section">
      <h2 className="sidebar-context-title"><Link to="/accounts">Accounts</Link></h2>
      <AccountPicker selectionMode="multiple"
        accounts={accounts.filter(account => account.status !== 'archived').map(account => ({
          ...account, account_holder: account.accountHolder ?? account.account_holder,
        }))}
        selectedIds={new Set(value ?? accounts.filter(account => account.status !== 'archived').map(account => account.id))}
        onChange={ids => onChange([...ids])} />
    </section>
  </SidebarContent>;
}
