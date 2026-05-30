import { useMemo } from 'react';
import { RotateCcw } from 'lucide-react';
import { isExpense } from '../../utils/transactionSemantics';
import { applyManualStacks, groupMerchantTransactions } from '../../utils/merchantNormalizer';
import { usePersistentStackMap } from '../../hooks/usePersistentStackMap';

export default function TopMerchants({ transactions, accountMap = {}, categoryMap = {}, onSelectMerchant }) {
  const { stackMap, stackGroup, undoStack } = usePersistentStackMap('vaultview:merchantStacks');
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

  return (
    <div className="merchant-list">
      {data.merchants.map((merchant, index) => {
        // Scale percentage relative to the top merchant for better visual distribution
        const topAmount = data.merchants[0].amount;
        const relativePercentage = (merchant.amount / topAmount) * 100;

        return (
          <button
            key={index}
            type="button"
            className={`merchant-item ${merchant.manuallyStackedKeys.length > 0 ? 'merchant-item--stacked' : ''}`}
            title={merchant.aliases.join('\n')}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('text/plain', merchant.normalized);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(event) => {
              event.preventDefault();
              stackGroup(event.dataTransfer.getData('text/plain'), merchant.normalized);
            }}
            onClick={() => onSelectMerchant?.(merchant)}
          >
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
          </button>
        );
      })}
    </div>
  );
}
