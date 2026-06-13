import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  Area,
  AreaChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { Activity, CircleDollarSign, Landmark, LineChart, RefreshCw, ShieldCheck } from 'lucide-react';
import { formatCurrency, formatCurrencyCompact, formatPercent } from '../../utils/formatters';
import './InvestmentsPage.css';

const ASSET_COLORS = {
  Options: '#8b5cf6',
  Equities: '#06b6d4',
  Cash: '#10b981',
  Crypto: '#f59e0b',
  Futures: '#ec4899',
  'Mutual funds': '#3b82f6',
  'Fixed income': '#14b8a6'
};

const EMPTY_ACCOUNTS = [];

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatSnapshotTime(value) {
  if (!value) return 'Not captured yet';
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function buildAllocation(portfolio) {
  return [
    ['Options', portfolio.optionsValue],
    ['Equities', portfolio.equityValue],
    ['Cash', portfolio.cash],
    ['Crypto', portfolio.cryptoValue],
    ['Futures', portfolio.futuresValue],
    ['Mutual funds', portfolio.mutualFundsValue],
    ['Fixed income', portfolio.fixedIncomeValue]
  ]
    .map(([name, value]) => ({ name, value: numberValue(value), color: ASSET_COLORS[name] }))
    .filter(item => item.value > 0);
}

function aggregatePortfolio(accounts) {
  return accounts.reduce((total, account) => {
    Object.entries(account.portfolio || {}).forEach(([key, value]) => {
      total[key] = numberValue(total[key]) + numberValue(value);
    });
    return total;
  }, {});
}

function aggregatePositions(accounts) {
  return accounts.flatMap(account =>
    (account.positions || []).map(position => ({
      ...position,
      accountLabel: account.label,
      accountId: account.id
    }))
  );
}

function aggregateOptionPositions(accounts) {
  return accounts.flatMap(account =>
    (account.optionPositions || []).map(position => ({
      ...position,
      accountLabel: account.label,
      accountId: account.id
    }))
  );
}

function getHistoryRows(history, selectedAccountId) {
  if (!Array.isArray(history)) return [];

  return history.map(point => {
    const value = selectedAccountId === 'all'
      ? numberValue(point.totalValue)
      : numberValue(point.accountValues?.[selectedAccountId]);

    return {
      date: formatSnapshotTime(point.fetchedAt),
      value
    };
  }).filter(point => point.value > 0);
}

function getOptionContractLabel(position) {
  const side = position.optionType ? position.optionType.toUpperCase() : 'OPTION';
  const strike = position.strikePrice !== undefined ? formatCurrency(position.strikePrice) : 'strike n/a';
  return `${position.underlyingSymbol || position.symbol || 'Contract'} ${position.expirationDate || 'expiration n/a'} ${strike} ${side}`;
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;

  return (
    <div className="custom-tooltip">
      {label && <div className="custom-tooltip__label">{label}</div>}
      {payload.map(item => (
        <div key={item.name} className="custom-tooltip__item">
          <span className="custom-tooltip__dot" style={{ background: item.color || item.payload?.color }} />
          <span>{item.name}: {formatCurrency(item.value)}</span>
        </div>
      ))}
    </div>
  );
}

function MetricCard({ title, value, detail, icon: Icon }) {
  return (
    <div className="glass-card robinhood-metric">
      <div className="robinhood-metric__header">
        <span>{title}</span>
        <div className="robinhood-metric__icon">
          <Icon size={18} />
        </div>
      </div>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

export default function InvestmentsPage() {
  const [snapshot, setSnapshot] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState('all');

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
        setStatus('ready');
      })
      .catch(nextError => {
        if (cancelled) return;
        setError(nextError.message);
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const loadSnapshot = async () => {
    setStatus('loading');
    setError('');
    try {
      const response = await fetch('/api/robinhood/snapshot');
      if (!response.ok) throw new Error(`Snapshot request failed: ${response.status}`);
      const data = await response.json();
      setSnapshot(data);
      setStatus('ready');
    } catch (nextError) {
      setError(nextError.message);
      setStatus('error');
    }
  };

  const accounts = snapshot?.accounts || EMPTY_ACCOUNTS;
  const selectedAccount = accounts.find(account => account.id === selectedAccountId);
  const portfolio = useMemo(
    () => selectedAccountId === 'all' ? aggregatePortfolio(accounts) : selectedAccount?.portfolio || {},
    [accounts, selectedAccount, selectedAccountId]
  );

  const allocationData = useMemo(() => buildAllocation(portfolio), [portfolio]);
  const exposureRows = useMemo(() => allocationData.map(item => ({
    ...item,
    shortName: item.name,
    total: item.value
  })), [allocationData]);

  const positions = useMemo(
    () => selectedAccountId === 'all' ? aggregatePositions(accounts) : selectedAccount?.positions || [],
    [accounts, selectedAccount, selectedAccountId]
  );
  const optionPositions = useMemo(
    () => selectedAccountId === 'all' ? aggregateOptionPositions(accounts) : selectedAccount?.optionPositions || [],
    [accounts, selectedAccount, selectedAccountId]
  );
  const historyRows = useMemo(
    () => getHistoryRows(snapshot?.history, selectedAccountId),
    [snapshot?.history, selectedAccountId]
  );
  const totalValue = numberValue(portfolio.totalValue);
  const buyingPower = numberValue(portfolio.buyingPower);
  const cash = numberValue(portfolio.cash);
  const optionsValue = numberValue(portfolio.optionsValue);
  const equityValue = numberValue(portfolio.equityValue);
  const buyingPowerPercent = totalValue > 0 ? (buyingPower / totalValue) * 100 : 0;

  if (status === 'loading' && !snapshot) {
    return (
      <div className="page robinhood-page">
        <div className="page__header">
          <div>
            <h1 className="page__title">Investments</h1>
            <p className="page__subtitle">Loading Robinhood snapshot...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page robinhood-page stagger-in">
      <div className="page__header robinhood-page__header">
        <div>
          <h1 className="page__title">Investments</h1>
          <p className="page__subtitle">
            Robinhood portfolio snapshot from {formatSnapshotTime(snapshot?.fetchedAt)}
          </p>
        </div>
        <button className="btn btn--secondary" type="button" onClick={loadSnapshot} disabled={status === 'loading'}>
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="robinhood-banner robinhood-banner--error">
          <strong>Robinhood snapshot unavailable.</strong>
          <span>{error}</span>
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="glass-card robinhood-empty">
          <ShieldCheck size={36} />
          <h2>No Robinhood snapshot yet</h2>
          <p>Capture a local snapshot through the Robinhood MCP, then this page will render allocation and holdings.</p>
        </div>
      ) : (
        <>
          <div className="robinhood-account-strip glass-card">
            <div>
              <span className="badge badge--info">Robinhood MCP</span>
              <h2>{selectedAccountId === 'all' ? 'All Robinhood accounts' : selectedAccount.label}</h2>
              <p>
                {selectedAccountId === 'all'
                  ? `${accounts.length} brokerage accounts · combined view`
                  : `${selectedAccount.accountNumberMasked} · ${selectedAccount.type}${selectedAccount.isDefault ? ' · default' : ''}`}
              </p>
            </div>
            <div className="robinhood-account-strip__status">
              <ShieldCheck size={18} />
              <span>{selectedAccount?.agenticAllowed ? 'Agentic trading enabled' : 'Read-only snapshot'}</span>
            </div>
          </div>

          <div className="robinhood-account-tabs" aria-label="Robinhood account selector">
            <button
              className={selectedAccountId === 'all' ? 'active' : ''}
              type="button"
              onClick={() => setSelectedAccountId('all')}
            >
              All accounts
              <span>{formatCurrency(aggregatePortfolio(accounts).totalValue)}</span>
            </button>
            {accounts.map(account => (
              <button
                key={account.id}
                className={selectedAccountId === account.id ? 'active' : ''}
                type="button"
                onClick={() => setSelectedAccountId(account.id)}
              >
                {account.label}
                <span>{formatCurrency(account.portfolio.totalValue)}</span>
              </button>
            ))}
          </div>

          <div className="robinhood-metrics">
            <MetricCard
              title="Portfolio value"
              value={formatCurrency(totalValue)}
              detail={`${formatCurrencyCompact(optionsValue + equityValue)} invested`}
              icon={LineChart}
            />
            <MetricCard
              title="Options"
              value={formatCurrency(optionsValue)}
              detail={`${optionPositions.length} contract${optionPositions.length === 1 ? '' : 's'} - ${formatPercent(totalValue ? (optionsValue / totalValue) * 100 : 0)} of account`}
              icon={Activity}
            />
            <MetricCard
              title="Equities"
              value={formatCurrency(equityValue)}
              detail={`${positions.length} open position${positions.length === 1 ? '' : 's'}`}
              icon={Landmark}
            />
            <MetricCard
              title="Buying power"
              value={formatCurrency(buyingPower)}
              detail={`${formatCurrency(cash)} cash`}
              icon={CircleDollarSign}
            />
          </div>

          <div className="robinhood-grid">
            <section className="glass-card robinhood-panel robinhood-panel--history">
              <div className="robinhood-panel__header">
                <div>
                  <h3>Value Over Time</h3>
                  <p>Recorded local Robinhood snapshots.</p>
                </div>
              </div>
              <div className="robinhood-history-chart">
                {historyRows.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={historyRows} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                      <XAxis dataKey="date" tickLine={false} axisLine={false} />
                      <YAxis
                        tickFormatter={formatCurrencyCompact}
                        tickLine={false}
                        axisLine={false}
                        width={68}
                      />
                      <Tooltip content={<CustomTooltip />} />
                      <Area
                        dataKey="value"
                        name="Value"
                        type="monotone"
                        stroke="#10b981"
                        fill="rgba(16, 185, 129, 0.18)"
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="empty-state-simple">No history recorded yet.</div>
                )}
              </div>
            </section>

            <section className="glass-card robinhood-panel robinhood-panel--allocation">
              <div className="robinhood-panel__header">
                <div>
                  <h3>Asset Allocation</h3>
                  <p>Current value by Robinhood asset class.</p>
                </div>
              </div>

              <div className="robinhood-allocation">
                <div className="robinhood-chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={allocationData}
                        dataKey="value"
                        nameKey="name"
                        innerRadius="62%"
                        outerRadius="86%"
                        paddingAngle={2}
                      >
                        {allocationData.map(item => (
                          <Cell key={item.name} fill={item.color} />
                        ))}
                      </Pie>
                      <Tooltip content={<CustomTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="robinhood-chart__center">
                    <span>Total</span>
                    <strong>{formatCurrencyCompact(totalValue)}</strong>
                  </div>
                </div>

                <div className="robinhood-legend">
                  {allocationData.map(item => (
                    <div key={item.name} className="robinhood-legend__row">
                      <span className="robinhood-legend__dot" style={{ background: item.color }} />
                      <span>{item.name}</span>
                      <strong>{formatCurrency(item.value)}</strong>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="glass-card robinhood-panel">
              <div className="robinhood-panel__header">
                <div>
                  <h3>Exposure</h3>
                  <p>Relative scale of non-zero balances.</p>
                </div>
              </div>
              <div className="robinhood-bar-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={exposureRows} layout="vertical" margin={{ top: 8, right: 12, bottom: 8, left: 8 }}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="shortName" width={86} tickLine={false} axisLine={false} />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="total" name="Value" radius={[0, 6, 6, 0]}>
                      {exposureRows.map(item => (
                        <Cell key={item.name} fill={item.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="robinhood-liquidity">
                <div className="robinhood-liquidity__row">
                  <span>Buying power</span>
                  <strong>{formatPercent(buyingPowerPercent)}</strong>
                </div>
                <div className="robinhood-liquidity__track">
                  <span style={{ width: `${Math.min(100, buyingPowerPercent)}%` }} />
                </div>
              </div>
            </section>
          </div>

          <section className="glass-card robinhood-panel robinhood-panel--table">
            <div className="robinhood-panel__header">
              <div>
                <h3>Options Holdings</h3>
                <p>Contract-level positions with strike, expiration, cost, and market value when available.</p>
              </div>
              {optionsValue > 0 && optionPositions.length === 0 && (
                <span className="badge badge--warning">Aggregate only</span>
              )}
            </div>
            {optionPositions.length > 0 ? (
              <div className="table-wrapper">
                <table className="table robinhood-table robinhood-options-table">
                  <thead>
                    <tr>
                      {selectedAccountId === 'all' && <th>Account</th>}
                      <th>Contract</th>
                      <th>Side</th>
                      <th>Quantity</th>
                      <th>Avg cost</th>
                      <th>Mark</th>
                      <th>Market value</th>
                      <th>Unrealized</th>
                    </tr>
                  </thead>
                  <tbody>
                    {optionPositions.map(position => (
                      <tr key={position.id || `${position.accountId || selectedAccountId}-${getOptionContractLabel(position)}`}>
                        {selectedAccountId === 'all' && <td>{position.accountLabel}</td>}
                        <td>
                          <strong>{getOptionContractLabel(position)}</strong>
                          <span>{position.contractSymbol || position.instrumentId || 'contract id unavailable'}</span>
                        </td>
                        <td>{position.positionType || 'long'}</td>
                        <td>{numberValue(position.quantity).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                        <td>{formatCurrency(numberValue(position.averageCost))}</td>
                        <td>{formatCurrency(numberValue(position.markPrice))}</td>
                        <td>{formatCurrency(numberValue(position.marketValue))}</td>
                        <td className={numberValue(position.unrealizedGain) >= 0 ? 'amount--positive' : 'amount--negative'}>
                          {formatCurrency(numberValue(position.unrealizedGain), true)}
                          <span>{formatPercent(numberValue(position.unrealizedGainPercent))}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="robinhood-options-empty">
                <strong>{formatCurrency(optionsValue)} in options value is present in this view.</strong>
                <span>
                  The current Robinhood MCP surface available to VaultView exposes aggregate options value, but not
                  option-position contracts, strikes, expirations, average cost, or mark price.
                </span>
              </div>
            )}
          </section>

          <section className="glass-card robinhood-panel robinhood-panel--table">
            <div className="robinhood-panel__header">
              <div>
                <h3>Equity Holdings</h3>
                <p>Equity positions with quote-backed market value.</p>
              </div>
            </div>
            <div className="table-wrapper">
              <table className="table robinhood-table">
                <thead>
                  <tr>
                    {selectedAccountId === 'all' && <th>Account</th>}
                    <th>Symbol</th>
                    <th>Quantity</th>
                    <th>Avg cost</th>
                    <th>Last price</th>
                    <th>Market value</th>
                    <th>Unrealized</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map(position => (
                    <tr key={`${position.accountId || selectedAccountId}-${position.symbol}`}>
                      {selectedAccountId === 'all' && <td>{position.accountLabel}</td>}
                      <td>
                        <strong>{position.symbol}</strong>
                        <span>{position.type}</span>
                      </td>
                      <td>{position.quantity.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                      <td>{formatCurrency(position.averageBuyPrice)}</td>
                      <td>
                        {formatCurrency(position.lastPrice)}
                        <span>as of {formatSnapshotTime(position.lastPriceAsOf)}</span>
                      </td>
                      <td>{formatCurrency(position.marketValue)}</td>
                      <td className={position.unrealizedGain >= 0 ? 'amount--positive' : 'amount--negative'}>
                        {formatCurrency(position.unrealizedGain, true)}
                        <span>{formatPercent(position.unrealizedGainPercent)}</span>
                      </td>
                    </tr>
                  ))}
                  {positions.length === 0 && (
                    <tr>
                      <td colSpan={selectedAccountId === 'all' ? '7' : '6'} className="text-center text-muted">
                        No equity positions in this snapshot.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
