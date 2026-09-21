import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
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
  value: string;
  onChange: (value: string) => void;
}) {
  return <SidebarContent>
    <section aria-label="Accounts" className="sidebar-context-section">
      <h2 className="sidebar-context-title">Accounts</h2>
      <AccountPicker selectionMode="single"
        accounts={accounts.filter(account => account.status !== 'archived').map(account => ({
          ...account, account_holder: account.accountHolder ?? account.account_holder,
        }))}
        selectedId={value ? Number(value) : null}
        onChange={id => onChange(id === null ? '' : String(id))} />
    </section>
  </SidebarContent>;
}
