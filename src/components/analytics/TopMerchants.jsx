import { useMemo, useState } from 'react';
import { GripVertical, HelpCircle, RotateCcw } from 'lucide-react';
import { isExpense } from '../../utils/transactionSemantics';
import { applyManualStacks, groupMerchantTransactions } from '../../utils/merchantNormalizer';
import { usePersistentStackMap } from '../../hooks/usePersistentStackMap';
import Tooltip from '../shared/Tooltip';

export default function TopMerchants({ transactions, accountMap = {}, categoryMap = {}, onSelectMerchant }) {
  const { stackMap, stackGroup, undoStack } = usePersistentStackMap('vaultview:merchantStacks');
  const [draggingKey, setDraggingKey] = useState(null);
  const [dropTargetKey, setDropTargetKey] = useState(null);
  const data = useMemo(() => {
    const expenseTransactions = transactions.filter(t => isExpense(t, accountMap, categoryMap));
    const totalExpenses = expenseTransactions.reduce((sum, t) => sum + Math.abs(t.amount), 0);

    const grouped = groupMerchantTransactions(
      expenseTransactions,
      transaction => transaction.merchant || transaction.description || 'Unknown'
    );

    const sorted = applyManualStacks(grouped, stackMap)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10);

    return { merchants: sorted, totalExpenses };
  }, [transactions, accountMap, categoryMap, stackMap]);

  if (data.merchants.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon">🏪</div>
        <p className="empty-state__description">No merchants found for this period.</p>
      </div>
    );
  }

  const formatCurrency = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
  const isDragging = Boolean(draggingKey);

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
            draggable
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
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
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
              <div className="merchant-item__name" title={merchant.name}>{merchant.name}</div>
              <div className="merchant-item__count">
                {merchant.count} transaction{merchant.count !== 1 ? 's' : ''}
                {merchant.aliases.length > 1 ? ` across ${merchant.aliases.length} labels` : ''}
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
                onKeyDown={(event) => {
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
