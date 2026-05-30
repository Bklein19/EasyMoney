import { useMemo, useState } from 'react';
import { GripVertical, HelpCircle, RotateCcw } from 'lucide-react';
import { isIncome } from '../../utils/transactionSemantics';
import { applyManualStacks, groupMerchantTransactions } from '../../utils/merchantNormalizer';
import { usePersistentStackMap } from '../../hooks/usePersistentStackMap';
import Tooltip from '../shared/Tooltip';

export default function IncomeStreams({ transactions, accountMap = {}, categoryMap = {}, onSelectStream }) {
  const { stackMap, stackGroup, undoStack } = usePersistentStackMap('vaultview:incomeStacks');
  const [draggingKey, setDraggingKey] = useState(null);
  const [dropTargetKey, setDropTargetKey] = useState(null);
  const data = useMemo(() => {
    const incomeTransactions = transactions.filter(t => isIncome(t, accountMap, categoryMap));
    const totalIncome = incomeTransactions.reduce((sum, t) => sum + Math.abs(t.amount), 0);

    const grouped = groupMerchantTransactions(
      incomeTransactions,
      transaction => transaction.merchant || transaction.description || 'Unknown'
    );

    const streams = applyManualStacks(grouped, stackMap)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10);

    return { streams, totalIncome };
  }, [transactions, accountMap, categoryMap, stackMap]);

  if (data.streams.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon">$</div>
        <p className="empty-state__description">No income streams found for this period.</p>
      </div>
    );
  }

  const formatCurrency = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
  const isDragging = Boolean(draggingKey);

  return (
    <div className={`merchant-list merchant-list--stackable ${isDragging ? 'merchant-list--dragging' : ''}`}>
      <div className="merchant-list__hint">
        <span>Drag one income stream onto another to combine matching labels.</span>
        <Tooltip
          text="Combines are saved on this device and stay grouped when you return. Use Undo on a combined stream to separate it again."
          position="left"
        >
          <span className="merchant-list__help" aria-label="Income stream stacking help" tabIndex={0}>
            <HelpCircle size={15} />
          </span>
        </Tooltip>
      </div>
      {data.streams.map((stream, index) => {
        const topAmount = data.streams[0].amount;
        const relativePercentage = (stream.amount / topAmount) * 100;
        const isSource = draggingKey === stream.normalized;
        const isDropTarget = dropTargetKey === stream.normalized && draggingKey !== stream.normalized;

        return (
          <button
            key={stream.normalized}
            type="button"
            className={[
              'merchant-item',
              'merchant-item--income',
              stream.manuallyStackedKeys.length > 0 ? 'merchant-item--stacked' : '',
              isSource ? 'merchant-item--drag-source' : '',
              isDropTarget ? 'merchant-item--drop-target' : ''
            ].filter(Boolean).join(' ')}
            title={stream.aliases.join('\n')}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('text/plain', stream.normalized);
              event.dataTransfer.effectAllowed = 'move';
              setDraggingKey(stream.normalized);
            }}
            onDragEnd={() => {
              setDraggingKey(null);
              setDropTargetKey(null);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDropTargetKey(stream.normalized);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setDropTargetKey(null);
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const sourceKey = event.dataTransfer.getData('text/plain');
              stackGroup(sourceKey, stream.normalized);
              setDraggingKey(null);
              setDropTargetKey(null);
            }}
            onClick={() => onSelectStream?.(stream)}
          >
            <div className="merchant-item__drag-handle" aria-hidden="true">
              <GripVertical size={16} />
            </div>
            <div
              className="merchant-item__bar merchant-item__bar--income"
              style={{ width: `${relativePercentage}%` }}
            />
            <div className="merchant-item__rank">#{index + 1}</div>
            <div className="merchant-item__info">
              <div className="merchant-item__name" title={stream.name}>{stream.name}</div>
              <div className="merchant-item__count">
                {stream.count} transaction{stream.count !== 1 ? 's' : ''}
                {stream.aliases.length > 1 ? ` across ${stream.aliases.length} labels` : ''}
              </div>
            </div>
            <div className="merchant-item__amount amount amount--positive">
              {formatCurrency(stream.amount)}
            </div>
            {stream.manuallyStackedKeys.length > 0 && (
              <span
                role="button"
                tabIndex={0}
                className="merchant-item__undo"
                title="Undo stacked labels"
                onClick={(event) => {
                  event.stopPropagation();
                  undoStack(stream.normalized);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    undoStack(stream.normalized);
                  }
                }}
              >
                <RotateCcw size={14} />
                Undo
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
