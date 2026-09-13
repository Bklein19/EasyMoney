/** Structured source evidence, retained in transaction rawJson across rebuilds. */
export interface SecurityTrade {
  tradeDate: string;
  settlementDate: string;
  symbol: string;
  quantity: string;
  action: 'buy' | 'sell';
}

function dateOnly(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

export function readSecurityTrade(value: unknown): SecurityTrade | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const tradeDate = dateOnly(row.tradeDate), settlementDate = dateOnly(row.settlementDate);
  const quantity = typeof row.quantity === 'string' ? row.quantity.replaceAll(',', '').replace(/^\+/, '') : '';
  if (!tradeDate || !settlementDate || settlementDate < tradeDate ||
      typeof row.symbol !== 'string' || !/^[A-Za-z0-9.-]+$/.test(row.symbol) ||
      !/^\d+(?:\.\d+)?$/.test(quantity) || !/[1-9]/.test(quantity) ||
      (row.action !== 'buy' && row.action !== 'sell')) return null;
  const [whole, fraction = ''] = quantity.split('.');
  const normalizedFraction = fraction.replace(/0+$/, '');
  return { tradeDate, settlementDate, symbol: row.symbol.toUpperCase(), action: row.action,
    quantity: `${whole!.replace(/^0+(?=\d)/, '')}${normalizedFraction ? `.${normalizedFraction}` : ''}` };
}

export function securityTradeKey(trade: SecurityTrade): string {
  return JSON.stringify([trade.action, trade.symbol, trade.quantity, trade.tradeDate, trade.settlementDate]);
}
