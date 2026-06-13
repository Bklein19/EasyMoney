import { getDb } from './database.js';

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function boolValue(value) {
  return value ? 1 : 0;
}

function withoutSnapshotFields(row) {
  const { snapshotId, accountKey, ...rest } = row;
  void snapshotId;
  void accountKey;
  return rest;
}

function aggregateSnapshotTotal(accounts = []) {
  return accounts.reduce((sum, account) => sum + numberValue(account.portfolio?.totalValue), 0);
}

function normalizePortfolio(portfolio = {}) {
  return {
    totalValue: numberValue(portfolio.totalValue),
    equityValue: numberValue(portfolio.equityValue),
    optionsValue: numberValue(portfolio.optionsValue),
    cash: numberValue(portfolio.cash),
    buyingPower: numberValue(portfolio.buyingPower),
    cryptoValue: numberValue(portfolio.cryptoValue),
    futuresValue: numberValue(portfolio.futuresValue),
    mutualFundsValue: numberValue(portfolio.mutualFundsValue),
    fixedIncomeValue: numberValue(portfolio.fixedIncomeValue)
  };
}

export function saveRobinhoodSnapshot(snapshot) {
  const db = getDb();
  const now = new Date().toISOString();
  const fetchedAt = snapshot.fetchedAt || now;
  const accounts = snapshot.accounts || [];
  const totalValue = numberValue(snapshot.totalValue) || aggregateSnapshotTotal(accounts);

  const save = db.transaction(() => {
    const existingSnapshot = db.prepare('SELECT id FROM robinhoodSnapshots WHERE fetchedAt = ?').get(fetchedAt);
    let snapshotId = existingSnapshot?.id;

    if (snapshotId) {
      db.prepare(`
        UPDATE robinhoodSnapshots
        SET source = @source, totalValue = @totalValue
        WHERE id = @id
      `).run({ id: snapshotId, source: snapshot.source || 'Robinhood MCP', totalValue });
      db.prepare('DELETE FROM robinhoodAccountSnapshots WHERE snapshotId = ?').run(snapshotId);
      db.prepare('DELETE FROM robinhoodEquityPositions WHERE snapshotId = ?').run(snapshotId);
      db.prepare('DELETE FROM robinhoodOptionPositions WHERE snapshotId = ?').run(snapshotId);
    } else {
      const result = db.prepare(`
        INSERT INTO robinhoodSnapshots (fetchedAt, source, totalValue, createdAt)
        VALUES (@fetchedAt, @source, @totalValue, @createdAt)
      `).run({ fetchedAt, source: snapshot.source || 'Robinhood MCP', totalValue, createdAt: now });
      snapshotId = result.lastInsertRowid;
    }

    const upsertAccount = db.prepare(`
      INSERT INTO robinhoodAccounts (
        accountKey, label, accountNumberMasked, type, brokerageAccountType,
        isDefault, agenticAllowed, createdAt, updatedAt
      )
      VALUES (
        @accountKey, @label, @accountNumberMasked, @type, @brokerageAccountType,
        @isDefault, @agenticAllowed, @createdAt, @updatedAt
      )
      ON CONFLICT(accountKey) DO UPDATE SET
        label = excluded.label,
        accountNumberMasked = excluded.accountNumberMasked,
        type = excluded.type,
        brokerageAccountType = excluded.brokerageAccountType,
        isDefault = excluded.isDefault,
        agenticAllowed = excluded.agenticAllowed,
        updatedAt = excluded.updatedAt
    `);

    const insertAccountSnapshot = db.prepare(`
      INSERT INTO robinhoodAccountSnapshots (
        snapshotId, accountKey, totalValue, equityValue, optionsValue, cash, buyingPower,
        cryptoValue, futuresValue, mutualFundsValue, fixedIncomeValue
      )
      VALUES (
        @snapshotId, @accountKey, @totalValue, @equityValue, @optionsValue, @cash, @buyingPower,
        @cryptoValue, @futuresValue, @mutualFundsValue, @fixedIncomeValue
      )
    `);

    const insertEquityPosition = db.prepare(`
      INSERT INTO robinhoodEquityPositions (
        snapshotId, accountKey, symbol, quantity, averageBuyPrice, lastPrice, lastPriceAsOf,
        previousClose, marketValue, unrealizedGain, unrealizedGainPercent, type
      )
      VALUES (
        @snapshotId, @accountKey, @symbol, @quantity, @averageBuyPrice, @lastPrice, @lastPriceAsOf,
        @previousClose, @marketValue, @unrealizedGain, @unrealizedGainPercent, @type
      )
    `);

    const insertOptionPosition = db.prepare(`
      INSERT INTO robinhoodOptionPositions (
        snapshotId, accountKey, underlyingSymbol, symbol, contractSymbol, instrumentId,
        expirationDate, strikePrice, optionType, positionType, quantity, averageCost,
        markPrice, marketValue, unrealizedGain, unrealizedGainPercent
      )
      VALUES (
        @snapshotId, @accountKey, @underlyingSymbol, @symbol, @contractSymbol, @instrumentId,
        @expirationDate, @strikePrice, @optionType, @positionType, @quantity, @averageCost,
        @markPrice, @marketValue, @unrealizedGain, @unrealizedGainPercent
      )
    `);

    for (const account of accounts) {
      const accountKey = account.id || account.accountKey;
      if (!accountKey) continue;

      upsertAccount.run({
        accountKey,
        label: account.label || accountKey,
        accountNumberMasked: account.accountNumberMasked || '',
        type: account.type || '',
        brokerageAccountType: account.brokerageAccountType || '',
        isDefault: boolValue(account.isDefault),
        agenticAllowed: boolValue(account.agenticAllowed),
        createdAt: now,
        updatedAt: now
      });

      insertAccountSnapshot.run({ snapshotId, accountKey, ...normalizePortfolio(account.portfolio) });

      for (const position of account.positions || []) {
        insertEquityPosition.run({
          snapshotId,
          accountKey,
          symbol: position.symbol,
          quantity: numberValue(position.quantity),
          averageBuyPrice: numberValue(position.averageBuyPrice),
          lastPrice: numberValue(position.lastPrice),
          lastPriceAsOf: position.lastPriceAsOf || '',
          previousClose: numberValue(position.previousClose),
          marketValue: numberValue(position.marketValue),
          unrealizedGain: numberValue(position.unrealizedGain),
          unrealizedGainPercent: numberValue(position.unrealizedGainPercent),
          type: position.type || ''
        });
      }

      for (const position of account.optionPositions || []) {
        insertOptionPosition.run({
          snapshotId,
          accountKey,
          underlyingSymbol: position.underlyingSymbol || '',
          symbol: position.symbol || '',
          contractSymbol: position.contractSymbol || '',
          instrumentId: position.instrumentId || '',
          expirationDate: position.expirationDate || '',
          strikePrice: numberValue(position.strikePrice),
          optionType: position.optionType || '',
          positionType: position.positionType || '',
          quantity: numberValue(position.quantity),
          averageCost: numberValue(position.averageCost),
          markPrice: numberValue(position.markPrice),
          marketValue: numberValue(position.marketValue),
          unrealizedGain: numberValue(position.unrealizedGain),
          unrealizedGainPercent: numberValue(position.unrealizedGainPercent)
        });
      }
    }

    return snapshotId;
  });

  return save();
}

export function getRobinhoodSnapshotHistory() {
  const db = getDb();
  const snapshots = db.prepare(`
    SELECT id, fetchedAt, totalValue
    FROM robinhoodSnapshots
    ORDER BY fetchedAt ASC, id ASC
  `).all();

  const accountSnapshots = db.prepare(`
    SELECT snapshotId, accountKey, totalValue
    FROM robinhoodAccountSnapshots
    ORDER BY id ASC
  `).all();

  const valuesBySnapshot = {};
  for (const row of accountSnapshots) {
    if (!valuesBySnapshot[row.snapshotId]) valuesBySnapshot[row.snapshotId] = {};
    valuesBySnapshot[row.snapshotId][row.accountKey] = row.totalValue;
  }

  return snapshots.map(snapshot => ({
    fetchedAt: snapshot.fetchedAt,
    totalValue: snapshot.totalValue,
    accountValues: valuesBySnapshot[snapshot.id] || {}
  }));
}

export function getLatestRobinhoodSnapshot() {
  const db = getDb();
  const snapshot = db.prepare(`
    SELECT *
    FROM robinhoodSnapshots
    ORDER BY fetchedAt DESC, id DESC
    LIMIT 1
  `).get();

  if (!snapshot) return null;

  const accounts = db.prepare(`
    SELECT a.*, s.*
    FROM robinhoodAccountSnapshots s
    JOIN robinhoodAccounts a ON a.accountKey = s.accountKey
    WHERE s.snapshotId = ?
    ORDER BY a.isDefault DESC, a.id ASC
  `).all(snapshot.id);

  const equityPositions = db.prepare(`
    SELECT *
    FROM robinhoodEquityPositions
    WHERE snapshotId = ?
    ORDER BY accountKey ASC, symbol ASC
  `).all(snapshot.id);

  const optionPositions = db.prepare(`
    SELECT *
    FROM robinhoodOptionPositions
    WHERE snapshotId = ?
    ORDER BY accountKey ASC, expirationDate ASC, underlyingSymbol ASC, strikePrice ASC
  `).all(snapshot.id);

  return {
    fetchedAt: snapshot.fetchedAt,
    source: snapshot.source,
    history: getRobinhoodSnapshotHistory(),
    accounts: accounts.map(account => {
      const accountKey = account.accountKey;
      return {
        id: accountKey,
        label: account.label,
        accountNumberMasked: account.accountNumberMasked,
        type: account.type,
        brokerageAccountType: account.brokerageAccountType,
        isDefault: Boolean(account.isDefault),
        agenticAllowed: Boolean(account.agenticAllowed),
        portfolio: {
          totalValue: account.totalValue,
          equityValue: account.equityValue,
          optionsValue: account.optionsValue,
          cash: account.cash,
          buyingPower: account.buyingPower,
          cryptoValue: account.cryptoValue,
          futuresValue: account.futuresValue,
          mutualFundsValue: account.mutualFundsValue,
          fixedIncomeValue: account.fixedIncomeValue
        },
        positions: equityPositions
          .filter(position => position.accountKey === accountKey)
          .map(withoutSnapshotFields),
        optionPositions: optionPositions
          .filter(position => position.accountKey === accountKey)
          .map(withoutSnapshotFields)
      };
    })
  };
}
