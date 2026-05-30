import Dexie from 'dexie';

const MIGRATION_FLAG = 'vaultview_sqlite_migration_attempted';
const TABLES = ['accounts', 'transactions', 'categories', 'budgets', 'balanceSnapshots', 'categorizationRules'];

export async function migrateDexieToSqlite() {
  if (localStorage.getItem(MIGRATION_FLAG)) return;

  const oldDb = new Dexie('VaultViewDB');
  oldDb.version(1).stores({
    accounts: '++id, name, type, institution',
    transactions: '++id, accountId, categoryId, date, amount, importBatchId, [accountId+date]',
    categories: '++id, name, parentId, type',
    budgets: '++id, categoryId, month, [categoryId+month]',
    balanceSnapshots: '++id, accountId, month, [accountId+month]',
    categorizationRules: '++id, categoryId, pattern, priority',
  });

  try {
    const payload = {};
    for (const table of TABLES) {
      payload[table] = await oldDb.table(table).toArray();
    }

    const hasData = TABLES.some(table => payload[table]?.length);
    if (!hasData) {
      localStorage.setItem(MIGRATION_FLAG, 'empty');
      return;
    }

    const response = await fetch('/api/migrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error(`Migration failed: ${response.status}`);
    localStorage.setItem(MIGRATION_FLAG, new Date().toISOString());
  } catch (error) {
    console.error('SQLite migration from IndexedDB failed', error);
  } finally {
    oldDb.close();
  }
}
