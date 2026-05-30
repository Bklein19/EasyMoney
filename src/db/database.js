import Dexie from 'dexie';

const db = new Dexie('VaultViewDB');

db.version(1).stores({
  accounts:            '++id, name, type, institution',
  transactions:        '++id, accountId, categoryId, date, amount, importBatchId, [accountId+date]',
  categories:          '++id, name, parentId, type',
  budgets:             '++id, categoryId, month, [categoryId+month]',
  balanceSnapshots:    '++id, accountId, month, [accountId+month]',
  categorizationRules: '++id, categoryId, pattern, priority',
});

export default db;
