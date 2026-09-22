import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './ContextMenu.css';

export function ContextMenu({ x, y, label, onClose, children }: {
  x: number; y: number; label: string; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const menu = ref.current!;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
  }, [x, y]);
  useEffect(() => {
    // Preserve the trigger across StrictMode's effect setup/cleanup replay.
    const previousFocus = returnFocus.current ?? document.activeElement;
    returnFocus.current = previousFocus;
    const items = () => [...ref.current!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    items()[0]?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        onClose();
        if (event.key === 'Escape') {
          event.preventDefault();
          if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
        }
      }
      const entries = items();
      const index = entries.indexOf(document.activeElement as HTMLElement);
      if (event.key === ' ' && index >= 0) { event.preventDefault(); entries[index]?.click(); }
      const next = event.key === 'ArrowDown' ? (index + 1) % entries.length
        : event.key === 'ArrowUp' ? (index - 1 + entries.length) % entries.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : null;
      if (next !== null) { event.preventDefault(); entries[next]?.focus(); }
    };
    const scroll = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  return createPortal(<div ref={ref} role="menu" aria-label={label} className="web-context-menu"
    onContextMenu={event => event.preventDefault()} style={{ left: x, top: y }}>{children}</div>, document.body);
}
