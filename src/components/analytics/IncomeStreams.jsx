import { useMemo } from 'react';
import { RotateCcw } from 'lucide-react';
import { isIncome } from '../../utils/transactionSemantics';
import { applyManualStacks, groupMerchantTransactions } from '../../utils/merchantNormalizer';
import { usePersistentStackMap } from '../../hooks/usePersistentStackMap';

export default function IncomeStreams({ transactions, accountMap = {}, categoryMap = {}, onSelectStream }) {
  const { stackMap, stackGroup, undoStack } = usePersistentStackMap('vaultview:incomeStacks');
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

  return (
    <div className="merchant-list">
      {data.streams.map((stream, index) => {
        const topAmount = data.streams[0].amount;
        const relativePercentage = (stream.amount / topAmount) * 100;

        return (
          <button
            key={stream.normalized}
            type="button"
            className={`merchant-item merchant-item--income ${stream.manuallyStackedKeys.length > 0 ? 'merchant-item--stacked' : ''}`}
            title={stream.aliases.join('\n')}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('text/plain', stream.normalized);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(event) => {
              event.preventDefault();
              stackGroup(event.dataTransfer.getData('text/plain'), stream.normalized);
            }}
            onClick={() => onSelectStream?.(stream)}
          >
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
