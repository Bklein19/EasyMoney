import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Building2, Download, Landmark, Link2, RefreshCw, Trash2, WalletCards } from 'lucide-react';
import { usePlaidLink, type PlaidLinkOnExitMetadata, type PlaidLinkOnSuccessMetadata } from 'react-plaid-link';
import { queryClient, trpc, trpcClient } from '../../api/trpc';
import Button from '../shared/Button';
import './PlaidConnectionsPage.css';

type ConnectionKind = 'bank' | 'investment';

const OAUTH_LINK_TOKEN_KEY = 'easymoney:plaid-link-token';
const OAUTH_LINK_KIND_KEY = 'easymoney:plaid-link-kind';

function messageFor(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatMoney(value: number | null, currency = 'USD') {
  if (value === null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
}

function downloadBase64(base64: string, mimeType: string, fileName: string) {
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function PlaidConnectionsPage() {
  const returnedFromOauth = new URLSearchParams(window.location.search).has('oauth_state_id');
  const [linkToken, setLinkToken] = useState<string | null>(() => (
    returnedFromOauth ? window.localStorage.getItem(OAUTH_LINK_TOKEN_KEY) : null
  ));
  const [linkKind, setLinkKind] = useState<ConnectionKind>(() => (
    window.localStorage.getItem(OAUTH_LINK_KIND_KEY) === 'investment' ? 'investment' : 'bank'
  ));
  const [openWhenReady, setOpenWhenReady] = useState(returnedFromOauth);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const statusQuery = useQuery(trpc.plaid.status.queryOptions());
  const previewQuery = useQuery({
    ...trpc.plaid.preview.queryOptions({ itemId: selectedItemId || 'not-selected' }),
    enabled: Boolean(selectedItemId),
  });

  const refreshStatus = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.plaid.status.queryKey() });
  }, []);

  const handleSuccess = useCallback(async (publicToken: string, metadata: PlaidLinkOnSuccessMetadata) => {
    setBusyAction('exchange');
    setError('');
    try {
      const connection = await trpcClient.plaid.exchangePublicToken.mutate({
        publicToken,
        kind: linkKind,
        institutionId: metadata.institution?.institution_id || null,
        institutionName: metadata.institution?.name || null,
      });
      window.localStorage.removeItem(OAUTH_LINK_TOKEN_KEY);
      window.localStorage.removeItem(OAUTH_LINK_KIND_KEY);
      setLinkToken(null);
      setSelectedItemId(connection.itemId);
      setNotice(`${connection.institutionName} connected. Inspecting available data does not import it.`);
      await refreshStatus();
    } catch (nextError) {
      setError(messageFor(nextError, 'Could not finish the Plaid connection.'));
    } finally {
      setBusyAction('');
    }
  }, [linkKind, refreshStatus]);

  const handleExit = useCallback((exitError: null | { display_message?: string | null }, metadata: PlaidLinkOnExitMetadata) => {
    if (exitError) setError(exitError.display_message || 'Plaid Link closed with an error.');
    if (metadata.status !== 'requires_credentials') {
      window.localStorage.removeItem(OAUTH_LINK_TOKEN_KEY);
      window.localStorage.removeItem(OAUTH_LINK_KIND_KEY);
    }
  }, []);

  const plaidConfig = useMemo(() => ({
    token: linkToken,
    onSuccess: handleSuccess,
    onExit: handleExit,
    receivedRedirectUri: returnedFromOauth ? window.location.href : undefined,
  }), [handleExit, handleSuccess, linkToken, returnedFromOauth]);
  const { open, ready } = usePlaidLink(plaidConfig);

  useEffect(() => {
    if (!openWhenReady || !ready) return;
    setOpenWhenReady(false);
    open();
  }, [open, openWhenReady, ready]);

  useEffect(() => {
    const connections = statusQuery.data?.connections || [];
    if (!selectedItemId && connections.length > 0) setSelectedItemId(connections[0].itemId);
  }, [selectedItemId, statusQuery.data?.connections]);

  const connect = async (kind: ConnectionKind) => {
    setBusyAction(`connect-${kind}`);
    setError('');
    setNotice('');
    try {
      const result = await trpcClient.plaid.createLinkToken.mutate({ kind });
      window.localStorage.setItem(OAUTH_LINK_TOKEN_KEY, result.linkToken);
      window.localStorage.setItem(OAUTH_LINK_KIND_KEY, kind);
      setLinkKind(kind);
      setLinkToken(result.linkToken);
      setOpenWhenReady(true);
    } catch (nextError) {
      setError(messageFor(nextError, 'Could not start Plaid Link.'));
    } finally {
      setBusyAction('');
    }
  };

  const disconnect = async (itemId: string, institutionName: string) => {
    if (!window.confirm(`Disconnect ${institutionName} from Plaid? No EasyMoney imports will be deleted.`)) return;
    setBusyAction(`disconnect-${itemId}`);
    setError('');
    try {
      await trpcClient.plaid.disconnect.mutate({ itemId });
      if (selectedItemId === itemId) setSelectedItemId('');
      setNotice(`${institutionName} disconnected.`);
      await refreshStatus();
    } catch (nextError) {
      setError(messageFor(nextError, 'Could not disconnect the Plaid Item.'));
    } finally {
      setBusyAction('');
    }
  };

  const downloadStatement = async (statementId: string) => {
    setBusyAction(`statement-${statementId}`);
    setError('');
    try {
      const result = await trpcClient.plaid.downloadStatement.mutate({ itemId: selectedItemId, statementId });
      downloadBase64(result.base64, result.mimeType, result.fileName);
    } catch (nextError) {
      setError(messageFor(nextError, 'Could not download the statement.'));
    } finally {
      setBusyAction('');
    }
  };

  const status = statusQuery.data;
  const preview = previewQuery.data;

  return (
    <div className="plaid-page">
      <header className="plaid-page__header">
        <div>
          <h1>Connections</h1>
          <p>Inspect Plaid coverage before importing anything into EasyMoney.</p>
        </div>
        {status?.configured && (
          <div className="plaid-page__actions">
            <Button
              variant="secondary"
              onClick={() => connect('bank')}
              disabled={Boolean(busyAction)}
            >
              <WalletCards size={16} /> Connect bank or card
            </Button>
            <Button
              variant="secondary"
              onClick={() => connect('investment')}
              disabled={Boolean(busyAction)}
            >
              <Landmark size={16} /> Connect investment
            </Button>
          </div>
        )}
      </header>

      {statusQuery.isLoading && <p className="plaid-page__muted">Checking Plaid configuration…</p>}
      {status && !status.configured && (
        <section className="plaid-setup">
          <h2>Plaid needs credentials</h2>
          <p>Add the following to <code>.env</code>, then restart EasyMoney:</p>
          <pre>{`PLAID_ENV="sandbox"\nPLAID_CLIENT_ID="…"\n${status.environment === 'production' ? 'PLAID_PRODUCTION_SECRET' : 'PLAID_SANDBOX_SECRET'}="…"`}</pre>
        </section>
      )}

      {status?.configured && (
        <div className="plaid-environment-line">
          <span className="plaid-environment-line__badge">{status.environment}</span>
          <span>
            {status.environment === 'sandbox'
              ? 'Uses Plaid test institutions and mock financial data.'
              : 'Uses real institution connections and financial data.'}
          </span>
          {status.environment === 'production' && !status.redirectUriConfigured && (
            <span>OAuth institutions also require an HTTPS <code>PLAID_REDIRECT_URI</code>.</span>
          )}
        </div>
      )}

      {error && <div className="plaid-message plaid-message--error">{error}</div>}
      {notice && <div className="plaid-message">{notice}</div>}

      {status?.configured && status.connections.length === 0 && (
        <section className="plaid-empty">
          <Link2 size={22} />
          <h2>No Plaid connections</h2>
          <p>Start with a Sandbox connection to verify the flow, then switch environments for your real institutions.</p>
        </section>
      )}

      {status && status.connections.length > 0 && (
        <section className="plaid-connections">
          <h2>Connected institutions</h2>
          <div className="plaid-connections__table-wrap">
            <table className="plaid-connections__table">
              <thead>
                <tr>
                  <th>Institution</th>
                  <th>Connection</th>
                  <th>Connected</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {status.connections.map(connection => (
                  <tr
                    key={connection.itemId}
                    className={connection.itemId === selectedItemId ? 'is-selected' : ''}
                    onClick={() => setSelectedItemId(connection.itemId)}
                  >
                    <td><Building2 size={16} /> {connection.institutionName}</td>
                    <td>{connection.kind === 'bank' ? 'Bank / card' : 'Investment'}</td>
                    <td>{new Date(connection.createdAt).toLocaleDateString()}</td>
                    <td>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Disconnect ${connection.institutionName}`}
                        title="Disconnect"
                        disabled={busyAction === `disconnect-${connection.itemId}`}
                        onClick={event => {
                          event.stopPropagation();
                          void disconnect(connection.itemId, connection.institutionName);
                        }}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {selectedItemId && (
        <section className="plaid-preview">
          <div className="plaid-preview__heading">
            <div>
              <h2>Available data</h2>
              <p>This is a read-only sample. Nothing below has entered the EasyMoney ledger.</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => previewQuery.refetch()} disabled={previewQuery.isFetching}>
              <RefreshCw size={15} /> Refresh
            </Button>
          </div>

          {previewQuery.isFetching && !preview && <p className="plaid-page__muted">Asking Plaid what this connection exposes…</p>}
          {previewQuery.error && <div className="plaid-message plaid-message--error">{previewQuery.error.message}</div>}

          {preview && (
            <>
              <div className="plaid-preview__metrics">
                <span><strong>{preview.accounts.length}</strong> accounts</span>
                <span><strong>{preview.transactions.data?.added.length || 0}</strong> transaction samples</span>
                <span><strong>{preview.investments.data?.holdings.length || 0}</strong> holdings</span>
                <span>
                  <strong>{preview.statements.data?.reduce((sum, account) => sum + account.statements.length, 0) || 0}</strong> statements
                </span>
              </div>

              <DataSection title="Accounts" status="available">
                <table className="plaid-data-table">
                  <thead><tr><th>Name</th><th>Type</th><th>Mask</th><th>Current balance</th></tr></thead>
                  <tbody>
                    {preview.accounts.map(account => (
                      <tr key={account.accountId}>
                        <td>{account.name}<small>{account.officialName}</small></td>
                        <td>{account.subtype || account.type}</td>
                        <td>{account.mask || '—'}</td>
                        <td className="num">{formatMoney(account.balances.current, account.balances.isoCurrencyCode || 'USD')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataSection>

              <DataSection title="Transactions" status={preview.transactions.status} error={preview.transactions.error}>
                {preview.transactions.data && (
                  <>
                    <p className="plaid-section-note">
                      Showing {preview.transactions.data.added.length} records from the first sync page.
                      {preview.transactions.data.hasMore ? ' More pages are available.' : ''}
                    </p>
                    <table className="plaid-data-table">
                      <thead><tr><th>Date</th><th>Description</th><th>Merchant</th><th>Amount</th></tr></thead>
                      <tbody>
                        {preview.transactions.data.added.slice(0, 20).map(transaction => (
                          <tr key={transaction.transactionId}>
                            <td>{transaction.date}</td>
                            <td>{transaction.name}</td>
                            <td>{transaction.merchantName || '—'}</td>
                            <td className="num">{formatMoney(transaction.amount, transaction.isoCurrencyCode || 'USD')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </DataSection>

              <DataSection title="Investments" status={preview.investments.status} error={preview.investments.error}>
                {preview.investments.data && (
                  <>
                    <p className="plaid-section-note">
                      {preview.investments.data.holdings.length} holdings and {preview.investments.data.totalInvestmentTransactions} investment transactions available.
                    </p>
                    <table className="plaid-data-table">
                      <thead><tr><th>Security</th><th>Ticker</th><th>Quantity</th><th>Value</th></tr></thead>
                      <tbody>
                        {preview.investments.data.holdings.map(holding => {
                          const security = preview.investments.data?.securities.find(candidate => candidate.securityId === holding.securityId);
                          return (
                            <tr key={`${holding.accountId}-${holding.securityId}`}>
                              <td>{security?.name || 'Unknown security'}</td>
                              <td>{security?.tickerSymbol || '—'}</td>
                              <td className="num">{holding.quantity.toLocaleString()}</td>
                              <td className="num">{formatMoney(holding.institutionValue, holding.isoCurrencyCode || 'USD')}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </>
                )}
              </DataSection>

              <DataSection title="Statements" status={preview.statements.status} error={preview.statements.error}>
                {preview.statements.data && preview.statements.data.map(account => (
                  <div className="plaid-statements" key={account.accountId}>
                    <h3>{account.accountName}{account.accountMask ? ` · ${account.accountMask}` : ''}</h3>
                    {account.statements.length === 0 && <p className="plaid-page__muted">No statements returned.</p>}
                    {account.statements.map(statement => (
                      <div className="plaid-statement-row" key={statement.statementId}>
                        <span>{new Date(statement.year, statement.month - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => downloadStatement(statement.statementId)}
                          disabled={busyAction === `statement-${statement.statementId}`}
                        >
                          <Download size={15} /> PDF
                        </Button>
                      </div>
                    ))}
                  </div>
                ))}
              </DataSection>
            </>
          )}
        </section>
      )}
    </div>
  );
}

function DataSection({
  title,
  status,
  error,
  children,
}: {
  title: string;
  status: 'available' | 'unavailable' | 'not-requested';
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <section className="plaid-data-section">
      <div className="plaid-data-section__heading">
        <h3>{title}</h3>
        {status !== 'available' && <span>{status === 'not-requested' ? 'Not requested for this connection' : 'Unavailable'}</span>}
      </div>
      {status === 'unavailable' && <p className="plaid-section-note">{error}</p>}
      {status === 'available' && children}
    </section>
  );
}
