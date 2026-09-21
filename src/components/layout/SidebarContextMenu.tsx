import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export function SidebarContextMenu({ x, y, onCustomize, onClose }: {
  x: number; y: number; onCustomize: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('button')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' || event.key === 'Tab') onClose(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return createPortal(<div ref={ref} role="menu" aria-label="Sidebar" className="account-context-menu"
    style={{ left: Math.max(8, Math.min(x, window.innerWidth - 224)), top: Math.max(8, Math.min(y, window.innerHeight - 52)) }}>
    <button type="button" role="menuitem" onClick={onCustomize}>Customize sidebar…</button>
  </div>, document.body);
}
