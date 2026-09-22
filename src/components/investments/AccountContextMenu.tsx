import { Pencil } from 'lucide-react';
import { Link } from 'react-router';
import { ContextMenu } from '../shared/ContextMenu';

export function AccountContextMenu({ id, name, metadata, x, y, onClose }: {
  id: number; name: string; metadata: string; x: number; y: number; onClose: () => void;
}) {
  return <ContextMenu x={x} y={y} label={name} onClose={onClose}>
    <div className="web-context-menu__heading" role="presentation"><strong>{name}</strong>{metadata && <small>{metadata}</small>}</div>
    <Link role="menuitem" to={`/accounts?edit=${id}`} onClick={onClose}><Pencil size={18} />Edit…</Link>
  </ContextMenu>;
}
