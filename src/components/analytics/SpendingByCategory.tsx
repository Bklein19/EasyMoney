// @ts-nocheck
import { X } from 'lucide-react';

// A palette of nice colors from index.css for categories if they don't have a specific color
const COLORS = [
  '#f97316', '#22c55e', '#6366f1', '#3b82f6', '#ec4899', 
  '#ef4444', '#a855f7', '#eab308', '#14b8a6', '#06b6d4'
];

const formatCurrency = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);

export default function SpendingByCategory({
  rows = [],
  onSelectCategory,
  onExcludeCategory
}) {
  const data = rows;

  if (data.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon">📊</div>
        <p className="empty-state__description">No spending data to display for this period.</p>
      </div>
    );
  }

  const maxAmount = Math.max(...data.map((entry) => entry.amount), 1);

  return (
    <div className="category-bar-list" role="list" aria-label="Spending by category">
      {data.map((entry, index) => {
        const width = `${Math.max(4, (entry.amount / maxAmount) * 100)}%`;
        const color = COLORS[index % COLORS.length];

        return (
          <div className="category-bar-row" role="listitem" key={entry.id}>
            <button
              className="category-bar-button"
              type="button"
              onClick={() => onSelectCategory?.(entry)}
              aria-label={`Include ${entry.name} in analytics filters`}
            >
              <span className="category-bar-label">{entry.name}</span>
              <span className="category-bar-track" aria-hidden="true">
                <span
                  className="category-bar-fill"
                  style={{ width, backgroundColor: color }}
                />
              </span>
              <span className="category-bar-value amount amount--negative">
                {formatCurrency(entry.amount)}
              </span>
            </button>
            <button
              className="category-bar-exclude"
              type="button"
              onClick={() => onExcludeCategory?.(entry)}
              aria-label={`Exclude ${entry.name} from analytics filters`}
              title={`Exclude ${entry.name}`}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
