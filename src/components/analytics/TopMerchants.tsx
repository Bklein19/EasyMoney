import { useMemo, useState } from 'react';
import type { DragEvent, FormEvent, KeyboardEvent, MouseEvent } from 'react';
import { Check, GripVertical, HelpCircle, Pencil, RotateCcw, X } from 'lucide-react';
import { applyManualStacks } from '../../utils/merchantNormalizer';
import type { MerchantGroup, StackedMerchantGroup } from '../../utils/merchantNormalizer';
import { usePersistentStackMap } from '../../hooks/usePersistentStackMap';
import Tooltip from '../shared/Tooltip';

interface TopMerchantsProps {
  rows?: Array<Omit<MerchantGroup, 'aliases'> & { aliases?: string[] }>;
  onSelectMerchant?: (merchant: StackedMerchantGroup) => void;
}

function containsRelatedTarget(currentTarget: EventTarget & Element, relatedTarget: EventTarget | null) {
  return relatedTarget instanceof Node && currentTarget.contains(relatedTarget);
}

export default function TopMerchants({ rows = [], onSelectMerchant }: TopMerchantsProps) {
  const { stackMap, labelMap, stackGroup, undoStack, renameStack } = usePersistentStackMap('vaultview:merchantStacks');
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const data = useMemo(() => {
    const sorted = applyManualStacks(rows.map(row => ({
      ...row,
      aliases: row.aliases ?? [row.name],
    })), stackMap, labelMap)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10);

    return { merchants: sorted };
  }, [rows, stackMap, labelMap]);

  if (data.merchants.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon">🏪</div>
        <p className="empty-state__description">No merchants found for this period.</p>
      </div>
    );
  }

  const formatCurrency = (val: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
  const isDragging = Boolean(draggingKey);

  const beginRename = (event: MouseEvent, merchant: StackedMerchantGroup) => {
    event.stopPropagation();
    setEditingKey(merchant.normalized);
    setEditingName(merchant.customName || merchant.name);
  };

  const cancelRename = (event: MouseEvent) => {
    event.stopPropagation();
    setEditingKey(null);
    setEditingName('');
  };

  const saveRename = (event: FormEvent, merchant: StackedMerchantGroup) => {
    event.preventDefault();
    event.stopPropagation();
    renameStack(merchant.normalized, editingName);
    setEditingKey(null);
    setEditingName('');
  };

  return (
    <div className={`merchant-list merchant-list--stackable merchant-list--expense ${isDragging ? 'merchant-list--dragging' : ''}`}>
      <div className="merchant-list__hint">
        <span>Drag one merchant onto another to combine matching labels.</span>
        <Tooltip
          text="Combines are saved on this device and stay grouped when you return. Use Undo on a combined merchant to separate it again."
          position="left"
        >
          <span className="merchant-list__help" aria-label="Merchant stacking help" tabIndex={0}>
            <HelpCircle size={15} />
          </span>
        </Tooltip>
      </div>
      {data.merchants.map((merchant, index) => {
        // Scale percentage relative to the top merchant for better visual distribution
        const topAmount = data.merchants[0].amount;
        const relativePercentage = (merchant.amount / topAmount) * 100;
        const isSource = draggingKey === merchant.normalized;
        const isDropTarget = dropTargetKey === merchant.normalized && draggingKey !== merchant.normalized;

        return (
          <div
            key={merchant.normalized}
            role="button"
            tabIndex={0}
            className={[
              'merchant-item',
              'merchant-item--expense',
              merchant.manuallyStackedKeys.length > 0 ? 'merchant-item--stacked' : '',
              isSource ? 'merchant-item--drag-source' : '',
              isDropTarget ? 'merchant-item--drop-target' : ''
            ].filter(Boolean).join(' ')}
            title={merchant.aliases.join('\n')}
            draggable={editingKey !== merchant.normalized}
            onDragStart={(event) => {
              event.dataTransfer.setData('text/plain', merchant.normalized);
              event.dataTransfer.effectAllowed = 'move';
              setDraggingKey(merchant.normalized);
            }}
            onDragEnd={() => {
              setDraggingKey(null);
              setDropTargetKey(null);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDropTargetKey(merchant.normalized);
            }}
            onDragLeave={(event: DragEvent<HTMLDivElement>) => {
              if (!containsRelatedTarget(event.currentTarget, event.relatedTarget)) {
                setDropTargetKey(null);
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const sourceKey = event.dataTransfer.getData('text/plain');
              stackGroup(sourceKey, merchant.normalized);
              setDraggingKey(null);
              setDropTargetKey(null);
            }}
            onClick={() => onSelectMerchant?.(merchant)}
            onKeyDown={(event) => {
              if (editingKey === merchant.normalized) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelectMerchant?.(merchant);
              }
            }}
          >
            <div className="merchant-item__drag-handle" aria-hidden="true">
              <GripVertical size={16} />
            </div>
            <div 
              className="merchant-item__bar" 
              style={{ width: `${relativePercentage}%` }}
            />
            <div className="merchant-item__rank">#{index + 1}</div>
            <div className="merchant-item__info">
              {editingKey === merchant.normalized ? (
                <form
                  className="merchant-item__rename"
                  onSubmit={(event) => saveRename(event, merchant)}
                  onClick={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onDragStart={(event) => event.stopPropagation()}
                >
                  <input
                    className="input input--sm merchant-item__rename-input"
                    value={editingName}
                    onChange={(event) => setEditingName(event.target.value)}
                    aria-label="Merchant group name"
                    autoFocus
                  />
                  <button className="btn btn--ghost btn--icon" type="submit" aria-label="Save name">
                    <Check size={14} />
                  </button>
                  <button className="btn btn--ghost btn--icon" type="button" onClick={cancelRename} aria-label="Cancel rename">
                    <X size={14} />
                  </button>
                </form>
              ) : (
                <div className="merchant-item__name-row">
                  <div className="merchant-item__name" title={merchant.name}>{merchant.name}</div>
                  {merchant.manuallyStackedKeys.length > 0 && (
                    <button
                      className="merchant-item__icon-action"
                      type="button"
                      aria-label={`Rename ${merchant.name}`}
                      title="Rename group"
                      onClick={(event) => beginRename(event, merchant)}
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                </div>
              )}
              <div className="merchant-item__count">
                {merchant.count} transaction{merchant.count !== 1 ? 's' : ''}
                {merchant.aliases.length > 1 ? ` across ${merchant.aliases.length} labels` : ''}
                {merchant.customName ? ' - renamed' : ''}
              </div>
            </div>
            <div className="merchant-item__amount amount amount--negative">
              {formatCurrency(merchant.amount)}
            </div>
            {merchant.manuallyStackedKeys.length > 0 && (
              <span
                role="button"
                tabIndex={0}
                className="merchant-item__undo"
                title="Undo stacked labels"
                onClick={(event) => {
                  event.stopPropagation();
                  undoStack(merchant.normalized);
                }}
                onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    undoStack(merchant.normalized);
                  }
                }}
              >
                <RotateCcw size={14} />
                Undo
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
