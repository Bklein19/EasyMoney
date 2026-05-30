import { formatCurrency, formatPercent } from '../../utils/formatters';

export default function KPICard({ title, amount, trend, icon: Icon, trendLabel }) {
  const isPositive = trend >= 0;
  
  return (
    <div className="glass-card kpi-card">
      <div className="kpi-card__header">
        <h3 className="kpi-card__title">{title}</h3>
        {Icon && (
          <div className="kpi-card__icon-wrapper">
            <Icon size={20} className="kpi-card__icon" />
          </div>
        )}
      </div>
      <div className="kpi-card__content">
        <div className="kpi-card__amount number-pop">{formatCurrency(amount)}</div>
        {trend !== undefined && (
          <div className={`kpi-card__trend ${isPositive ? 'trend-up' : 'trend-down'}`}>
            <span className="trend-value">{formatPercent(trend)}</span>
            <span className="trend-label">{trendLabel || 'vs last month'}</span>
          </div>
        )}
      </div>
    </div>
  );
}
