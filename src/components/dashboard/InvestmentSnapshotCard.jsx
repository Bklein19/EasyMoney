import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, BriefcaseBusiness } from 'lucide-react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RechartsTooltip } from 'recharts';
import { formatCurrency, formatCurrencyCompact, formatPercent } from '../../utils/formatters';

const COLORS = {
  Options: '#8b5cf6',
  Equities: '#06b6d4',
  Cash: '#10b981',
  Crypto: '#f59e0b',
  Futures: '#ec4899'
};

const EMPTY_ACCOUNTS = [];

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function aggregatePortfolio(accounts) {
  return accounts.reduce((total, account) => {
    Object.entries(account.portfolio || {}).forEach(([key, value]) => {
      total[key] = numberValue(total[key]) + numberValue(value);
    });
    return total;
  }, {});
}

function buildAllocation(portfolio) {
  return [
    ['Options', portfolio.optionsValue],
    ['Equities', portfolio.equityValue],
    ['Cash', portfolio.cash],
    ['Crypto', portfolio.cryptoValue],
    ['Futures', portfolio.futuresValue]
  ]
    .map(([name, value]) => ({ name, value: numberValue(value), color: COLORS[name] }))
    .filter(item => item.value > 0);
}

function formatSnapshotTime(value) {
  if (!value) return 'No snapshot yet';
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const item = payload[0];

  return (
    <div className="custom-tooltip">
      <div className="custom-tooltip__item">
        <span className="custom-tooltip__dot" style={{ background: item.payload.color }} />
        <span>{item.name}: {formatCurrency(item.value)}</span>
      </div>
    </div>
  );
}

export default function InvestmentSnapshotCard() {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    fetch('/api/robinhood/snapshot')
      .then(response => {
        if (!response.ok) throw new Error(`Snapshot request failed: ${response.status}`);
        return response.json();
      })
      .then(data => {
        if (cancelled) return;
        setSnapshot(data);
      })
      .catch(nextError => {
        if (cancelled) return;
        setError(nextError.message);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const accounts = snapshot?.accounts || EMPTY_ACCOUNTS;
  const portfolio = useMemo(() => aggregatePortfolio(accounts), [accounts]);
  const allocation = useMemo(() => buildAllocation(portfolio), [portfolio]);
  const totalValue = numberValue(portfolio.totalValue);
  const optionsValue = numberValue(portfolio.optionsValue);
  const equityValue = numberValue(portfolio.equityValue);
  const cashValue = numberValue(portfolio.cash);

  return (
    <section className="glass-card dashboard-investments">
      <div className="dashboard-investments__header">
        <div className="dashboard-investments__title">
          <div className="dashboard-investments__icon">
            <BriefcaseBusiness size={18} />
          </div>
          <div>
            <h3>Robinhood Snapshot</h3>
            <p>{error || `Updated ${formatSnapshotTime(snapshot?.fetchedAt)}`}</p>
          </div>
        </div>
        <Link className="btn btn--ghost btn--sm" to="/investments">
          Details
          <ArrowRight size={14} />
        </Link>
      </div>

      {accounts.length > 0 ? (
        <div className="dashboard-investments__content">
          <div className="dashboard-investments__summary">
            <span>Total portfolio</span>
            <strong>{formatCurrency(totalValue)}</strong>
            <div className="dashboard-investments__mix">
              <span>{formatCurrencyCompact(optionsValue)} options</span>
              <span>{formatCurrencyCompact(equityValue)} equities</span>
              <span>{formatCurrencyCompact(cashValue)} cash</span>
            </div>
          </div>

          <div className="dashboard-investments__chart">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={allocation}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="62%"
                  outerRadius="86%"
                  paddingAngle={3}
                  stroke="none"
                >
                  {allocation.map(item => (
                    <Cell key={item.name} fill={item.color} />
                  ))}
                </Pie>
                <RechartsTooltip content={<CustomTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div className="dashboard-investments__accounts">
            {accounts.map(account => {
              const accountTotal = numberValue(account.portfolio?.totalValue);
              const share = totalValue > 0 ? (accountTotal / totalValue) * 100 : 0;

              return (
                <div key={account.id} className="dashboard-investments__account">
                  <div>
                    <strong>{account.label}</strong>
                    <span>{formatPercent(share)} of Robinhood</span>
                  </div>
                  <span>{formatCurrency(accountTotal)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="empty-state-simple">No Robinhood snapshot available.</div>
      )}
    </section>
  );
}
