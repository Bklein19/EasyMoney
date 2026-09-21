import { useEffect, type RefObject } from 'react';

interface Point { x: number; y: number }
interface Rect { left: number; right: number; top: number; bottom: number }

// Safe triangle from the departure point to the submenu's near edge.
export function insideMenuCorridor(point: Point, origin: Point, panel: Rect): boolean {
  const edge = origin.x < panel.left ? panel.left : panel.right;
  const width = edge - origin.x;
  if (Math.abs(width) < 1) return false;
  const progress = (point.x - origin.x) / width;
  if (progress < 0 || progress > 1) return false;
  const upper = origin.y + (panel.top - 12 - origin.y) * progress;
  const lower = origin.y + (panel.bottom + 12 - origin.y) * progress;
  return point.y >= upper - 6 && point.y <= lower + 6;
}

export function useMenuAim(ref: RefObject<HTMLDetailsElement | null>, customizing: boolean) {
  useEffect(() => {
    const details = ref.current;
    const summary = details?.querySelector('summary');
    const panel = details?.querySelector<HTMLElement>('.sidebar-overflow-panel');
    if (!details || !summary || !panel) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingDelay = 0;
    let hoverOnly = false;
    let departure: Point | null = null;
    let previous: Point | null = null;
    const clear = () => { clearTimeout(timer); timer = undefined; pendingDelay = 0; };
    const position = () => {
      const rect = summary.getBoundingClientRect();
      const width = panel.offsetWidth;
      const left = rect.right + width + 4 <= window.innerWidth ? rect.right + 4 : Math.max(8, rect.left - width - 4);
      panel.style.left = `${left}px`;
      panel.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - panel.offsetHeight - 8))}px`;
    };
    const schedule = (delay: number) => {
      clear();
      pendingDelay = delay;
      timer = setTimeout(() => { if (hoverOnly && !customizing) details.open = false; }, delay);
    };
    const open = () => {
      if (details.open) return;
      hoverOnly = true; details.open = true; position();
    };
    const enter = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      clear(); departure = null;
      void open();
    };
    const leave = (event: PointerEvent) => {
      if (!hoverOnly || customizing || event.pointerType !== 'mouse') return;
      departure = { x: event.clientX, y: event.clientY };
      previous = departure;
      schedule(450);
    };
    const move = (event: PointerEvent) => {
      if (!details.open || !hoverOnly || customizing || !departure) return;
      const point = { x: event.clientX, y: event.clientY };
      const rect = panel.getBoundingClientRect();
      if (panel.contains(event.target as Node) || summary.contains(event.target as Node)) { clear(); departure = null; return; }
      const edge = departure.x < rect.left ? rect.left : rect.right;
      const movingToward = !previous || Math.abs(edge - point.x) <= Math.abs(edge - previous.x);
      if (movingToward && insideMenuCorridor(point, departure, rect)) schedule(450);
      else if (pendingDelay !== 120) schedule(120);
      previous = point;
    };
    const panelEnter = () => { clear(); departure = null; };
    const click = (event: MouseEvent) => {
      if (!details.open) { event.preventDefault(); open(); hoverOnly = false; return; }
      // A click on a hover-open trigger pins it instead of immediately closing it.
      if (hoverOnly && details.open) event.preventDefault();
      hoverOnly = false; clear();
    };
    const toggle = () => { if (details.open) position(); else { clear(); hoverOnly = false; departure = null; } };
    const focus = () => { hoverOnly = false; clear(); };
    summary.addEventListener('pointerenter', enter);
    summary.addEventListener('pointerleave', leave);
    summary.addEventListener('click', click);
    panel.addEventListener('pointerenter', panelEnter);
    panel.addEventListener('pointerleave', leave);
    panel.addEventListener('focusin', focus);
    summary.addEventListener('keydown', focus);
    details.addEventListener('toggle', toggle);
    window.addEventListener('pointermove', move);
    window.addEventListener('resize', position);
    return () => {
      clear();
      summary.removeEventListener('pointerenter', enter);
      summary.removeEventListener('pointerleave', leave);
      summary.removeEventListener('click', click);
      panel.removeEventListener('pointerenter', panelEnter);
      panel.removeEventListener('pointerleave', leave);
      panel.removeEventListener('focusin', focus);
      summary.removeEventListener('keydown', focus);
      details.removeEventListener('toggle', toggle);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('resize', position);
    };
  }, [ref, customizing]);
}
