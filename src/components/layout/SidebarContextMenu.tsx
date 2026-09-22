import { Settings2 } from 'lucide-react';
import { ContextMenu } from '../shared/ContextMenu';

export function SidebarContextMenu({ x, y, onCustomize, onClose }: {
  x: number; y: number; onCustomize: () => void; onClose: () => void;
}) {
  return <ContextMenu x={x} y={y} label="Sidebar" onClose={onClose}>
    <button type="button" role="menuitem" onClick={onCustomize}><Settings2 size={18} />Customize sidebar…</button>
  </ContextMenu>;
}
