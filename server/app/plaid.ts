import fs from 'node:fs';
import path from 'node:path';
import {
  Configuration,
  CountryCode,
  type Holding,
  PlaidApi,
  PlaidEnvironments,
  Products,
  type AccountBase,
  type InvestmentTransaction,
  type Security,
  type Transaction,
} from 'plaid';

export type PlaidEnvironment = 'sandbox' | 'production';
export type PlaidConnectionKind = 'bank' | 'investment';

interface StoredPlaidItem {
  itemId: string;
  accessToken: string;
  environment: PlaidEnvironment;
  institutionId: string | null;
  institutionName: string;
  kind: PlaidConnectionKind;
  createdAt: string;
}

interface PlaidStore {
  userId: string;
  items: StoredPlaidItem[];
}

interface PlaidResponse<T> {
  data: T;
}

export interface PlaidClientLike {
  linkTokenCreate: (request: Record<string, unknown>) => Promise<PlaidResponse<any>>;
  itemPublicTokenExchange: (request: { public_token: string }) => Promise<PlaidResponse<any>>;
  accountsGet: (request: { access_token: string }) => Promise<PlaidResponse<any>>;
  transactionsSync: (request: Record<string, unknown>) => Promise<PlaidResponse<any>>;
  investmentsHoldingsGet: (request: { access_token: string }) => Promise<PlaidResponse<any>>;
  investmentsTransactionsGet: (request: Record<string, unknown>) => Promise<PlaidResponse<any>>;
  statementsList: (request: { access_token: string }) => Promise<PlaidResponse<any>>;
  statementsDownload: (request: Record<string, unknown>, options?: Record<string, unknown>) => Promise<PlaidResponse<any>>;
  itemRemove: (request: { access_token: string }) => Promise<PlaidResponse<any>>;
}

const EMPTY_STORE: PlaidStore = { userId: '', items: [] };

function storePath() {
  return process.env.PLAID_ITEMS_PATH
    ? path.resolve(process.env.PLAID_ITEMS_PATH)
    : path.resolve(import.meta.dir, '..', '..', 'data', 'plaid-items.json');
}

function readStore(): PlaidStore {
  const filePath = storePath();
  if (!fs.existsSync(filePath)) return { ...EMPTY_STORE, userId: crypto.randomUUID(), items: [] };
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<PlaidStore>;
  return {
    userId: parsed.userId || crypto.randomUUID(),
    items: Array.isArray(parsed.items) ? parsed.items : [],
  };
}

function writeStore(store: PlaidStore) {
  const filePath = storePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function environment(): PlaidEnvironment {
  return process.env.PLAID_ENV === 'production' ? 'production' : 'sandbox';
}

function secretForEnvironment(value: PlaidEnvironment) {
  return value === 'production'
    ? process.env.PLAID_PRODUCTION_SECRET || process.env.PLAID_SECRET || ''
    : process.env.PLAID_SANDBOX_SECRET || process.env.PLAID_SECRET || '';
}

export function getPlaidConfigurationStatus() {
  const currentEnvironment = environment();
  const missingVariables = [];
  if (!process.env.PLAID_CLIENT_ID) missingVariables.push('PLAID_CLIENT_ID');
  if (!secretForEnvironment(currentEnvironment)) {
    missingVariables.push(currentEnvironment === 'production' ? 'PLAID_PRODUCTION_SECRET' : 'PLAID_SANDBOX_SECRET');
  }
  return {
    configured: missingVariables.length === 0,
    environment: currentEnvironment,
    missingVariables,
    redirectUriConfigured: Boolean(process.env.PLAID_REDIRECT_URI),
  };
}

function createClient(): PlaidClientLike {
  const status = getPlaidConfigurationStatus();
  if (!status.configured) throw new Error(`Plaid is not configured. Missing ${status.missingVariables.join(', ')}.`);
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[status.environment],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': secretForEnvironment(status.environment),
      },
    },
  })) as unknown as PlaidClientLike;
}

function itemForCurrentEnvironment(itemId: string) {
  const item = readStore().items.find(candidate => candidate.itemId === itemId && candidate.environment === environment());
  if (!item) throw new Error('Plaid connection not found in the current environment.');
  return item;
}

function startDateYearsAgo(years: number) {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function plaidError(error: unknown) {
  if (error && typeof error === 'object') {
    const response = (error as { response?: { data?: { error_message?: string; error_code?: string } } }).response;
    if (response?.data?.error_message) {
      return response.data.error_code
        ? `${response.data.error_message} (${response.data.error_code})`
        : response.data.error_message;
    }
  }
  return error instanceof Error ? error.message : 'Plaid request failed';
}

async function optionalProduct<T>(load: () => Promise<T>) {
  try {
    return { status: 'available' as const, data: await load(), error: null };
  } catch (error) {
    return { status: 'unavailable' as const, data: null, error: plaidError(error) };
  }
}

async function requiredPlaidRequest<T>(load: () => Promise<T>) {
  try {
    return await load();
  } catch (error) {
    throw new Error(plaidError(error));
  }
}

function publicItem(item: StoredPlaidItem) {
  return {
    itemId: item.itemId,
    environment: item.environment,
    institutionId: item.institutionId,
    institutionName: item.institutionName,
    kind: item.kind,
    createdAt: item.createdAt,
  };
}

export function listPlaidConnections() {
  const currentEnvironment = environment();
  return readStore().items
    .filter(item => item.environment === currentEnvironment)
    .map(publicItem);
}

export async function createPlaidLinkToken(
  kind: PlaidConnectionKind,
  client: PlaidClientLike = createClient(),
) {
  const store = readStore();
  writeStore(store);
  const endDate = today();
  const request: Record<string, unknown> = {
    client_name: 'EasyMoney',
    country_codes: [CountryCode.Us],
    language: 'en',
    user: { client_user_id: store.userId },
    products: kind === 'investment' ? [Products.Investments] : [Products.Transactions],
  };

  if (kind === 'bank') {
    request.transactions = { days_requested: 730 };
    request.required_if_supported_products = [Products.Statements];
    request.statements = { start_date: startDateYearsAgo(2), end_date: endDate };
  }
  if (process.env.PLAID_REDIRECT_URI) request.redirect_uri = process.env.PLAID_REDIRECT_URI;

  const response = await requiredPlaidRequest(() => client.linkTokenCreate(request));
  return {
    linkToken: response.data.link_token as string,
    expiration: response.data.expiration as string,
    environment: environment(),
  };
}

export async function exchangePlaidPublicToken(
  input: {
    publicToken: string;
    kind: PlaidConnectionKind;
    institutionId?: string | null;
    institutionName?: string | null;
  },
  client: PlaidClientLike = createClient(),
) {
  const exchanged = await requiredPlaidRequest(() => client.itemPublicTokenExchange({ public_token: input.publicToken }));
  const itemId = String(exchanged.data.item_id);
  const accessToken = String(exchanged.data.access_token);
  const institutionId = input.institutionId || null;
  const store = readStore();
  const item: StoredPlaidItem = {
    itemId,
    accessToken,
    environment: environment(),
    institutionId,
    institutionName: input.institutionName || institutionId || 'Connected institution',
    kind: input.kind,
    createdAt: new Date().toISOString(),
  };
  store.items = [...store.items.filter(candidate => candidate.itemId !== itemId), item];
  writeStore(store);
  return publicItem(item);
}

function summarizeAccount(account: AccountBase) {
  return {
    accountId: account.account_id,
    name: account.name,
    officialName: account.official_name || null,
    mask: account.mask || null,
    type: account.type,
    subtype: account.subtype || null,
    balances: {
      available: account.balances.available ?? null,
      current: account.balances.current ?? null,
      limit: account.balances.limit ?? null,
      isoCurrencyCode: account.balances.iso_currency_code || null,
    },
  };
}

function summarizeTransaction(transaction: Transaction) {
  return {
    transactionId: transaction.transaction_id,
    accountId: transaction.account_id,
    date: transaction.date,
    name: transaction.name,
    merchantName: transaction.merchant_name || null,
    amount: transaction.amount,
    pending: transaction.pending,
    isoCurrencyCode: transaction.iso_currency_code || null,
  };
}

function summarizeInvestmentTransaction(transaction: InvestmentTransaction) {
  return {
    investmentTransactionId: transaction.investment_transaction_id,
    accountId: transaction.account_id,
    date: transaction.date,
    name: transaction.name,
    type: transaction.type,
    subtype: transaction.subtype,
    amount: transaction.amount,
    quantity: transaction.quantity,
    price: transaction.price,
    securityId: transaction.security_id || null,
    isoCurrencyCode: transaction.iso_currency_code || null,
  };
}

function summarizeSecurity(security: Security) {
  return {
    securityId: security.security_id,
    name: security.name || null,
    tickerSymbol: security.ticker_symbol || null,
    type: security.type || null,
    closePrice: security.close_price ?? null,
    closePriceAsOf: security.close_price_as_of || null,
  };
}

function summarizeHolding(holding: Holding) {
  return {
    accountId: holding.account_id,
    securityId: holding.security_id,
    quantity: holding.quantity,
    costBasis: holding.cost_basis ?? null,
    institutionValue: holding.institution_value,
    institutionPrice: holding.institution_price,
    institutionPriceAsOf: holding.institution_price_as_of || null,
    isoCurrencyCode: holding.iso_currency_code || null,
  };
}

export async function previewPlaidConnection(itemId: string, client: PlaidClientLike = createClient()) {
  const item = itemForCurrentEnvironment(itemId);
  const accessToken = item.accessToken;
  const accountsResponse = await requiredPlaidRequest(() => client.accountsGet({ access_token: accessToken }));

  const transactions = item.kind === 'bank'
    ? await optionalProduct(async () => {
      const response = await client.transactionsSync({ access_token: accessToken, count: 100 });
      return {
        added: (response.data.added as Transaction[]).map(summarizeTransaction),
        modifiedCount: response.data.modified?.length || 0,
        removedCount: response.data.removed?.length || 0,
        hasMore: Boolean(response.data.has_more),
        updateStatus: response.data.transactions_update_status
          ? String(response.data.transactions_update_status)
          : null,
      };
    })
    : { status: 'not-requested' as const, data: null, error: null };

  const investments = item.kind === 'investment'
    ? await optionalProduct(async () => {
      const [holdingsResponse, transactionsResponse] = await Promise.all([
        client.investmentsHoldingsGet({ access_token: accessToken }),
        client.investmentsTransactionsGet({
          access_token: accessToken,
          start_date: startDateYearsAgo(2),
          end_date: today(),
          options: { count: 100, offset: 0 },
        }),
      ]);
      return {
        holdings: (holdingsResponse.data.holdings as Holding[]).map(summarizeHolding),
        investmentTransactions: (transactionsResponse.data.investment_transactions as InvestmentTransaction[])
          .map(summarizeInvestmentTransaction),
        securities: (holdingsResponse.data.securities as Security[]).map(summarizeSecurity),
        totalInvestmentTransactions: Number(transactionsResponse.data.total_investment_transactions || 0),
      };
    })
    : { status: 'not-requested' as const, data: null, error: null };

  const statements = item.kind === 'bank'
    ? await optionalProduct(async () => {
      const response = await client.statementsList({ access_token: accessToken });
      const accounts = response.data.accounts as Array<{
        account_id: string;
        account_name: string;
        account_mask?: string | null;
        statements: Array<{
          statement_id: string;
          year: number;
          month: number;
          date_posted?: string | null;
        }>;
      }>;
      return accounts.map(account => ({
        accountId: String(account.account_id),
        accountName: String(account.account_name),
        accountMask: account.account_mask ? String(account.account_mask) : null,
        statements: account.statements.map(statement => ({
          statementId: String(statement.statement_id),
          year: Number(statement.year),
          month: Number(statement.month),
          datePosted: statement.date_posted ? String(statement.date_posted) : null,
        })),
      }));
    })
    : { status: 'not-requested' as const, data: null, error: null };

  return {
    connection: publicItem(item),
    accounts: (accountsResponse.data.accounts as AccountBase[]).map(summarizeAccount),
    transactions,
    investments,
    statements,
  };
}

export async function downloadPlaidStatement(
  itemId: string,
  statementId: string,
  client: PlaidClientLike = createClient(),
) {
  const item = itemForCurrentEnvironment(itemId);
  const response = await requiredPlaidRequest(() => client.statementsDownload(
    { access_token: item.accessToken, statement_id: statementId },
    { responseType: 'arraybuffer' },
  ));
  const bytes = Buffer.from(response.data);
  return {
    fileName: `${item.institutionName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}-statement.pdf`,
    mimeType: 'application/pdf',
    base64: bytes.toString('base64'),
  };
}

export async function disconnectPlaidItem(itemId: string, client: PlaidClientLike = createClient()) {
  const item = itemForCurrentEnvironment(itemId);
  await requiredPlaidRequest(() => client.itemRemove({ access_token: item.accessToken }));
  const store = readStore();
  store.items = store.items.filter(candidate => candidate.itemId !== itemId);
  writeStore(store);
  return { itemId, disconnected: true };
}

export const plaidTesting = {
  readStore,
  writeStore,
};
