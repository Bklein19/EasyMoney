import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';

export function AccountContextMenu({ id, name, metadata, x, y, onClose }: {
  id: number; name: string; metadata: string; x: number; y: number; onClose: () => void;
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
    style={{ left: Math.max(8, Math.min(x, window.innerWidth - 224)), top: Math.max(8, Math.min(y, window.innerHeight - 112)) }}>
    <div className="account-context-menu__label" role="presentation">{name}
      {metadata && <div className="account-context-menu__metadata">{metadata}</div>}
    </div>
    <Link role="menuitem" to={`/accounts?edit=${id}`} onClick={onClose}>
      <span>Edit…</span>
    </Link>
  </div>, document.body);
}
