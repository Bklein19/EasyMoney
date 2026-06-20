import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, RotateCcw, Search, Trash2 } from 'lucide-react';
import { useCSVImport } from '../../hooks/useCSVImport';
import { buildCustomProfile, mappingFromProfile } from '../../utils/csvMapping';
import { useImportProfiles } from '../../hooks/useImportProfiles';
import { getHeaderSignature } from '../../utils/importIdentity';
import { apiAction, appRequest } from '../../db/api';
import FileDropZone from './FileDropZone';
import ColumnMapper from './ColumnMapper';
import ImportPreview from './ImportPreview';
import BankDetector from './BankDetector';
import './ImportPage.css';

export default function ImportPage() {
  const { processImport, isParsing, error } = useCSVImport();
  const { importProfiles } = useImportProfiles();
  const batchCancelRef = useRef(false);
  
  const [stage, setStage] = useState('upload'); // upload, mapping, preview, batch, success
  const [currentFile, setCurrentFile] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [importedCount, setImportedCount] = useState(0);
  const [skippedDuplicateCount, setSkippedDuplicateCount] = useState(0);
  const [importQueue, setImportQueue] = useState([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [queueImportedCount, setQueueImportedCount] = useState(0);
  const [queueSkippedDuplicateCount, setQueueSkippedDuplicateCount] = useState(0);
  const [autoImportAll, setAutoImportAll] = useState(false);
  const [queueMessage, setQueueMessage] = useState('');
  const [batchState, setBatchState] = useState(null);
  const [importHistory, setImportHistory] = useState([]);
  const [historyError, setHistoryError] = useState('');
  const [unimportingId, setUnimportingId] = useState(null);
  const [reimportingId, setReimportingId] = useState(null);
  const [historyBulkAction, setHistoryBulkAction] = useState(null);

  const loadImportHistory = useCallback(async () => {
    setHistoryError('');
    try {
      const result = await appRequest('/imports');
      setImportHistory(result.imports || []);
    } catch (loadError) {
      setHistoryError(loadError?.message || 'Could not load import history.');
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadImportHistory();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadImportHistory]);

  const queueTotal = importQueue.length;
  const isBatchImport = queueTotal > 1;

  const getFileLabel = (file) => file?.webkitRelativePath || file?.name || 'selected file';

  const applySavedProfile = async (file, initialResult, options = {}) => {
    let result = initialResult;
    if (!result) return null;

    const headerSignature = getHeaderSignature(result.headers);
    const savedProfile = importProfiles.find(profile => profile.headerSignature === headerSignature);
    if (savedProfile?.profileJson) {
      const profile = JSON.parse(savedProfile.profileJson);
      const remapped = await processImport(file, profile, options);
      if (remapped && !remapped.requiresMapping) {
        result = { ...remapped, savedImportProfile: savedProfile };
      }
    }
    return result;
  };

  const previewFile = async (file, options = {}) => {
    const result = await processImport(file, null, options);
    return applySavedProfile(file, result, options);
  };

  const canCommitAutomatically = (result) => {
    const accountMappings = result?.accountMappings || [];
    const hasImportableFacts = (result?.transactions?.length || 0) > 0 || (result?.balanceRowIds?.length || 0) > 0;
    return Boolean(
      result &&
      !result.requiresMapping &&
      hasImportableFacts &&
      accountMappings.length > 0 &&
      accountMappings.every(mapping =>
        mapping.resolvedAccountId &&
        mapping.resolvedAccountStatus !== 'archived' &&
        mapping.resolution !== 'archived-match'
      )
    );
  };

  const buildAutoAccountMappings = (result) => (result.accountMappings || []).map(mapping => ({
    sourceAccountId: mapping.sourceAccountId,
    mode: 'auto',
  }));

  const commitPreviewResult = async (result) => {
    const accountMappings = buildAutoAccountMappings(result);
    return apiAction('/app/imports/commit', {
      method: 'POST',
      body: JSON.stringify({
        accountId: null,
        importFileId: result.importFileId,
        importRowIds: (result.transactions || []).map(transaction => transaction.importRowId),
        forceImportRowIds: [],
        balanceRowIds: result.balanceRowIds || [],
        accountMappings,
        importMeta: {
          importFileId: result.importFileId,
          headers: result.headers,
          profile: result.profile,
          mapping: result.mapping || mappingFromProfile(result.profile, result.headers),
          profileName: result.profileUsed || result.profile?.name || 'Custom',
          savedImportProfile: result.savedImportProfile,
          accountMappings,
          balanceRowIds: result.balanceRowIds || [],
        },
      }),
    });
  };

  const processSelectedFile = async (file, index = 0) => {
    setCurrentFile(file);
    setQueueIndex(index);
    setQueueMessage('');
    let result = await previewFile(file);
    
    if (result) {
      setImportResult(result);
      if (result.requiresMapping) {
        setStage('mapping');
      } else {
        setStage('preview');
      }
    }
  };

  const handleFilesSelected = async (files) => {
    const sortedFiles = [...files].sort((a, b) => {
      const aPath = a.webkitRelativePath || a.name;
      const bPath = b.webkitRelativePath || b.name;
      return aPath.localeCompare(bPath, undefined, { numeric: true, sensitivity: 'base' });
    });
    setImportQueue(sortedFiles);
    setQueueIndex(0);
    setQueueImportedCount(0);
    setQueueSkippedDuplicateCount(0);
    setAutoImportAll(false);
    setQueueMessage('');
    setBatchState(null);
    setImportedCount(0);
    setSkippedDuplicateCount(0);
    setImportResult(null);
    if (sortedFiles.length > 0) {
      await processSelectedFile(sortedFiles[0], 0);
    }
  };

  const handleFileSelected = async (file) => {
    await handleFilesSelected([file]);
  };

  const handleMappingComplete = async (mapping) => {
    const customProfile = buildCustomProfile(mapping);
    const result = await processImport(currentFile, customProfile);
    
    if (result && !result.requiresMapping) {
      setImportResult({ ...result, mapping });
      setStage('preview');
    }
  };

  const handleReviewMapping = () => {
    if (importResult?.headers) {
      setStage('mapping');
    }
  };

  const handleImportComplete = async (count, skipped = 0) => {
    const nextImportedCount = queueImportedCount + count;
    const nextSkippedCount = queueSkippedDuplicateCount + skipped;
    setQueueImportedCount(nextImportedCount);
    setQueueSkippedDuplicateCount(nextSkippedCount);
    setImportedCount(nextImportedCount);
    setSkippedDuplicateCount(nextSkippedCount);
    setQueueMessage('');
    await loadImportHistory();

    const nextIndex = queueIndex + 1;
    if (nextIndex < importQueue.length) {
      if (autoImportAll) {
        await runBatchImport(importQueue, nextIndex);
        return;
      }
      await processSelectedFile(importQueue[nextIndex], nextIndex);
      return;
    }

    setStage('success');
  };

  const resetImport = () => {
    setStage('upload');
    setCurrentFile(null);
    setImportResult(null);
    setImportedCount(0);
    setSkippedDuplicateCount(0);
    setImportQueue([]);
    setQueueIndex(0);
    setQueueImportedCount(0);
    setQueueSkippedDuplicateCount(0);
    setAutoImportAll(false);
    setQueueMessage('');
    setBatchState(null);
  };

  const runBatchImport = async (files, startIndex = 0, initialResult = null) => {
    batchCancelRef.current = false;
    setAutoImportAll(true);
    setQueueMessage('');
    setImportResult(null);
    setStage('batch');

    let nextImportedCount = queueImportedCount;
    let nextSkippedCount = queueSkippedDuplicateCount;

    setBatchState({
      status: 'running',
      total: files.length,
      index: startIndex,
      currentFile: files[startIndex],
      importedCount: nextImportedCount,
      skippedDuplicateCount: nextSkippedCount,
      completedFiles: startIndex,
      error: '',
    });

    for (let index = startIndex; index < files.length; index += 1) {
      if (batchCancelRef.current) {
        setAutoImportAll(false);
        setBatchState(previous => previous ? { ...previous, status: 'cancelled' } : previous);
        return;
      }

      const file = files[index];
      setCurrentFile(file);
      setQueueIndex(index);
      setBatchState(previous => ({
        ...(previous || {}),
        status: 'running',
        total: files.length,
        index,
        currentFile: file,
        completedFiles: index,
        error: '',
      }));

      try {
        const result = index === startIndex && initialResult
          ? initialResult
          : await previewFile(file, { throwOnError: true });

        if (!canCommitAutomatically(result)) {
          setImportResult(result);
          setQueueMessage('Batch paused. Choose an account for this file, then continue.');
          setStage(result?.requiresMapping ? 'mapping' : 'preview');
          return;
        }

        const commitResult = await commitPreviewResult(result);
        nextImportedCount += commitResult.importedCount || 0;
        nextSkippedCount += commitResult.skippedDuplicateCount || 0;
        setQueueImportedCount(nextImportedCount);
        setQueueSkippedDuplicateCount(nextSkippedCount);
        setImportedCount(nextImportedCount);
        setSkippedDuplicateCount(nextSkippedCount);
        setBatchState(previous => ({
          ...(previous || {}),
          importedCount: nextImportedCount,
          skippedDuplicateCount: nextSkippedCount,
          completedFiles: index + 1,
        }));
      } catch (batchError) {
        const message = batchError?.message || `${getFileLabel(file)}: Import failed`;
        setQueueMessage(message);
        setBatchState(previous => ({
          ...(previous || {}),
          status: 'error',
          total: files.length,
          index,
          currentFile: file,
          completedFiles: index,
          error: message,
        }));
        setAutoImportAll(false);
        await loadImportHistory();
        return;
      }
    }

    await loadImportHistory();
    setAutoImportAll(false);
    setStage('success');
  };

  const handleStartAutoImportAll = () => {
    void runBatchImport(importQueue, queueIndex, importResult);
  };

  const handleAutoImportBlocked = (message) => {
    setQueueMessage(message || 'This file needs your guidance before the batch can continue.');
  };

  const handleCancelBatch = () => {
    batchCancelRef.current = true;
    setQueueMessage('Stopping after the current file...');
  };

  const handleUnimport = async (item) => {
    const confirmed = window.confirm(`Unimport ${item.fileName}? This removes transactions and balances created by that import.`);
    if (!confirmed) return;

    setUnimportingId(item.id);
    setHistoryError('');
    try {
      await apiAction(`/app/imports/${item.id}`, { method: 'DELETE' });
      await loadImportHistory();
    } catch (unimportError) {
      setHistoryError(unimportError?.message || 'Could not unimport file.');
    } finally {
      setUnimportingId(null);
    }
  };

  const handleReimport = async (item) => {
    const confirmed = window.confirm(`Reimport ${item.fileName}? This restores saved source facts from this file.`);
    if (!confirmed) return;

    setReimportingId(item.id);
    setHistoryError('');
    try {
      await apiAction(`/app/imports/${item.id}/reimport`, { method: 'POST' });
      await loadImportHistory();
    } catch (reimportError) {
      setHistoryError(reimportError?.message || 'Could not reimport file.');
    } finally {
      setReimportingId(null);
    }
  };

  const handleBulkUnimport = async (items) => {
    if (items.length === 0) return;
    const confirmed = window.confirm(`Unimport ${items.length} import${items.length === 1 ? '' : 's'}? This removes their transactions and balances from the ledger.`);
    if (!confirmed) return;

    setHistoryBulkAction('unimport');
    setHistoryError('');
    try {
      await apiAction('/app/imports/bulk-unimport', {
        method: 'POST',
        body: JSON.stringify({ importFileIds: items.map(item => item.id) }),
      });
      await loadImportHistory();
    } catch (bulkError) {
      setHistoryError(bulkError?.message || 'Could not unimport selected files.');
    } finally {
      setHistoryBulkAction(null);
    }
  };

  const handleBulkReimport = async (items) => {
    if (items.length === 0) return;
    const confirmed = window.confirm(`Reimport ${items.length} import${items.length === 1 ? '' : 's'}? This restores saved source facts and rebuilds the ledger.`);
    if (!confirmed) return;

    setHistoryBulkAction('reimport');
    setHistoryError('');
    try {
      await apiAction('/app/imports/bulk-reimport', {
        method: 'POST',
        body: JSON.stringify({ importFileIds: items.map(item => item.id) }),
      });
      await loadImportHistory();
    } catch (bulkError) {
      setHistoryError(bulkError?.message || 'Could not reimport selected files.');
    } finally {
      setHistoryBulkAction(null);
    }
  };

  return (
    <div className="page import-page">
      <header className="page__header import-page__header">
        <div>
          <h1 className="page__title">Import Data</h1>
          <p className="page__subtitle">Upload exports or statements to import transactions, balances, and accounts.</p>
        </div>
        {stage === 'upload' && (
          <FileDropZone
            onFileSelected={handleFileSelected}
            onFilesSelected={handleFilesSelected}
            isParsing={isParsing}
          />
        )}
      </header>

      {error && (
        <div className="error-banner">
          <strong>Error:</strong> {error}
        </div>
      )}

      {stage === 'upload' && (
        <div className="upload-container">
          <ImportHistory
            imports={importHistory}
            error={historyError}
            unimportingId={unimportingId}
            reimportingId={reimportingId}
            bulkAction={historyBulkAction}
            onUnimport={handleUnimport}
            onReimport={handleReimport}
            onBulkUnimport={handleBulkUnimport}
            onBulkReimport={handleBulkReimport}
          />
        </div>
      )}

      {stage === 'mapping' && importResult && (
        <div className="mapping-container">
          <ImportQueueStatus
            files={importQueue}
            currentIndex={queueIndex}
            isBatchImport={isBatchImport}
            currentFile={currentFile}
            message={queueMessage}
            autoImportAll={autoImportAll}
          />
          <BankDetector requiresMapping={true} profileUsed={importResult.profileUsed} />
          <ColumnMapper 
            headers={importResult.headers} 
            initialMapping={mappingFromProfile(importResult.profile, importResult.headers)}
            onComplete={handleMappingComplete}
            onCancel={resetImport}
          />
        </div>
      )}

      {stage === 'preview' && importResult && (
        <div className="preview-container">
          <ImportQueueStatus
            files={importQueue}
            currentIndex={queueIndex}
            isBatchImport={isBatchImport}
            currentFile={currentFile}
            message={queueMessage}
            autoImportAll={autoImportAll}
          />
          {!importResult.requiresMapping && importResult.headers && (
            <BankDetector
              profileUsed={importResult.profileUsed || 'Custom'}
              requiresMapping={false}
              onReviewMapping={handleReviewMapping}
            />
          )}
          <ImportPreview 
            transactions={importResult.transactions}
            importMeta={{
              importFileId: importResult.importFileId,
              headers: importResult.headers,
              profile: importResult.profile,
              mapping: importResult.mapping || mappingFromProfile(importResult.profile, importResult.headers),
              profileName: importResult.profileUsed || importResult.profile?.name || 'Custom',
              savedImportProfile: importResult.savedImportProfile,
              accountMappings: importResult.accountMappings || [],
              balanceRowIds: importResult.balanceRowIds || [],
            }}
            onComplete={handleImportComplete}
            onCancel={resetImport}
            isBatchImport={isBatchImport}
            autoImportAll={autoImportAll}
            onStartAutoImportAll={handleStartAutoImportAll}
            onAutoImportBlocked={handleAutoImportBlocked}
          />
        </div>
      )}

      {stage === 'batch' && batchState && (
        <BatchImportProgress
          state={batchState}
          message={queueMessage}
          onCancel={handleCancelBatch}
          onReset={resetImport}
        />
      )}

      {stage === 'success' && (
        <div className="success-container glass-card">
          <div className="success-icon-wrapper">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2>Import Successful!</h2>
          <p>Successfully imported {importedCount} transactions.</p>
          {isBatchImport && <p>Processed {queueTotal} files.</p>}
          {skippedDuplicateCount > 0 && (
            <p>Skipped {skippedDuplicateCount} duplicate transaction{skippedDuplicateCount === 1 ? '' : 's'}.</p>
          )}
          <div className="success-actions">
            <button className="btn btn-primary" onClick={resetImport}>
              Import Another File
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ImportQueueStatus({ files, currentIndex, isBatchImport, currentFile, message, autoImportAll }) {
  if (!isBatchImport || !currentFile) return null;

  const currentLabel = currentFile.webkitRelativePath || currentFile.name;
  const nextFiles = files.slice(currentIndex + 1, currentIndex + 4);

  return (
    <div className="import-queue glass-card">
      <div className="import-queue__summary">
        <strong>File {currentIndex + 1} of {files.length}</strong>
        <span>{currentLabel}</span>
        {message && <em>{message}</em>}
      </div>
      {nextFiles.length > 0 && (
        <div className="import-queue__next">
          <span>{autoImportAll ? 'Auto importing' : 'Next up'}</span>
          {nextFiles.map(file => (
            <small key={file.webkitRelativePath || file.name}>
              {file.webkitRelativePath || file.name}
            </small>
          ))}
        </div>
      )}
    </div>
  );
}

function BatchImportProgress({ state, message, onCancel, onReset }) {
  const total = state.total || 0;
  const completed = Math.min(state.completedFiles || 0, total);
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const currentLabel = state.currentFile?.webkitRelativePath || state.currentFile?.name || 'Preparing import';
  const hasError = state.status === 'error';
  const cancelled = state.status === 'cancelled';

  return (
    <div className="batch-import glass-card">
      <div className="batch-import__header">
        <div>
          <h2>{hasError ? 'Batch Import Paused' : cancelled ? 'Batch Import Stopped' : 'Importing Files'}</h2>
          <p>{hasError ? state.error : message || currentLabel}</p>
        </div>
        <strong>{completed} / {total}</strong>
      </div>

      <div className="batch-import__bar" aria-label="Import progress">
        <div className="batch-import__bar-fill" style={{ width: `${percent}%` }} />
      </div>

      <div className="batch-import__meta">
        <span>Current file: {currentLabel}</span>
        <span>{state.importedCount || 0} transactions imported</span>
        {(state.skippedDuplicateCount || 0) > 0 && (
          <span>{state.skippedDuplicateCount} duplicates skipped</span>
        )}
      </div>

      {hasError && (
        <div className="batch-import__error">
          <AlertTriangle size={18} />
          <span>{state.error}</span>
        </div>
      )}

      <div className="batch-import__actions">
        {hasError || cancelled ? (
          <button type="button" className="btn btn-primary" onClick={onReset}>
            Back to Upload
          </button>
        ) : (
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel Batch
          </button>
        )}
      </div>
    </div>
  );
}

function ImportHistory({
  imports,
  error,
  unimportingId,
  reimportingId,
  bulkAction,
  onUnimport,
  onReimport,
  onBulkUnimport,
  onBulkReimport,
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const filteredImports = useMemo(() => {
    if (!normalizedSearch) return imports;
    return imports.filter(item => [
      item.fileName,
      item.institution,
      item.parserName,
      item.sourceType,
      item.status,
      item.createdAt,
      item.committedAt,
    ].filter(Boolean).join(' ').toLowerCase().includes(normalizedSearch));
  }, [imports, normalizedSearch]);
  const committedImports = filteredImports.filter(item => item.status === 'committed');
  const reimportableImports = filteredImports.filter(item =>
    item.status === 'unimported' && item.unresolvedSourceAccountCount === 0
  );
  const hasSearch = normalizedSearch.length > 0;

  return (
    <section className="import-history">
      <div className="import-history__header">
        <div>
          <h3>Import History</h3>
          <p>Remove a prior import if you need to test the file again.</p>
        </div>
      </div>

      <div className="import-history__toolbar">
        <label className="import-history__search">
          <Search size={16} />
          <input
            type="search"
            value={searchTerm}
            onChange={event => setSearchTerm(event.target.value)}
            placeholder="Search imports"
          />
        </label>
        <div className="import-history__bulk-actions">
          <button
            type="button"
            className="btn btn-secondary import-history__bulk-btn"
            onClick={() => onBulkUnimport(committedImports)}
            disabled={bulkAction !== null || committedImports.length === 0}
          >
            <Trash2 size={16} />
            {bulkAction === 'unimport' ? 'Unimporting...' : `Unimport All${committedImports.length ? ` (${committedImports.length})` : ''}`}
          </button>
          <button
            type="button"
            className="btn btn-secondary import-history__bulk-btn"
            onClick={() => onBulkReimport(reimportableImports)}
            disabled={bulkAction !== null || reimportableImports.length === 0}
          >
            <RotateCcw size={16} />
            {bulkAction === 'reimport' ? 'Reimporting...' : `Reimport All${reimportableImports.length ? ` (${reimportableImports.length})` : ''}`}
          </button>
        </div>
      </div>

      {error && <div className="import-history__error">{error}</div>}

      {imports.length === 0 ? (
        <div className="import-history__empty">No imports yet.</div>
      ) : filteredImports.length === 0 ? (
        <div className="import-history__empty">No imports match {searchTerm}.</div>
      ) : (
        <div className="import-history__table-wrap">
          {hasSearch && (
            <div className="import-history__result-count">
              Showing {filteredImports.length} of {imports.length} imports
            </div>
          )}
          <table className="import-history__table">
            <thead>
              <tr>
                <th>File</th>
                <th>Source</th>
                <th>Status</th>
                <th className="num">Transactions</th>
                <th className="num">Balances</th>
                <th>Imported</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filteredImports.map(item => {
                const committed = item.status === 'committed';
                const unimported = item.status === 'unimported';
                const date = item.committedAt || item.createdAt;
                return (
                  <tr className="import-history__row" key={item.id}>
                    <td className="import-history__file">
                      <strong title={item.fileName}>{item.fileName}</strong>
                    </td>
                    <td className="import-history__source">
                      <span>{item.institution || item.parserName || 'Unknown format'}</span>
                      {item.sourceType && <small>{item.sourceType}</small>}
                    </td>
                    <td>
                      <span className={`import-history__status ${committed ? 'committed' : ''}`}>
                        {item.status || 'previewed'}
                      </span>
                    </td>
                    <td className="num">{item.transactionCount || 0}</td>
                    <td className="num">{item.balanceCount || 0}</td>
                    <td className="import-history__date">{date ? new Date(date).toLocaleString() : '—'}</td>
                    <td className="import-history__actions">
                      {committed && (
                        <button
                          type="button"
                          className="icon-btn delete-btn"
                          title="Unimport file"
                          onClick={() => onUnimport(item)}
                          disabled={bulkAction !== null || unimportingId === item.id}
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                      {unimported && (
                        <button
                          type="button"
                          className="icon-btn"
                          title={item.unresolvedSourceAccountCount > 0 ? 'Resolve source accounts before reimporting' : 'Reimport file'}
                          onClick={() => onReimport(item)}
                          disabled={bulkAction !== null || reimportingId === item.id || item.unresolvedSourceAccountCount > 0}
                        >
                          <RotateCcw size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
