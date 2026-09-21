import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { Pencil } from 'lucide-react';

export function AccountContextMenu({ id, name, x, y, onClose }: {
  id: number; name: string; x: number; y: number; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    ref.current?.querySelector<HTMLAnchorElement>('a')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const dismiss = () => onClose();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        onClose();
        if (event.key === 'Escape') {
          event.preventDefault();
          if (previousFocus instanceof HTMLElement) previousFocus.focus();
        }
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keydown);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', keydown);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [onClose]);
  return createPortal(<div ref={ref} role="menu" aria-label={name} className="account-context-menu"
    style={{ left: Math.max(8, Math.min(x, window.innerWidth - 224)), top: Math.max(8, Math.min(y, window.innerHeight - 92)) }}>
    <div className="account-context-menu__label" role="presentation">{name}</div>
    <Link role="menuitem" to={`/accounts?edit=${id}`} onClick={onClose}>
      <Pencil size={14} strokeWidth={1.7} aria-hidden="true" />
      <span>Edit account…</span>
    </Link>
  </div>, document.body);
}
