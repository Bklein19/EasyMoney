import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronRight, FileText, Folder, LoaderCircle, RotateCcw, Search, Trash2 } from 'lucide-react';
import { useCSVImport, type ImportPreviewResult } from '../../hooks/useCSVImport';
import { buildCustomProfile, mappingFromProfile } from '../../utils/csvMapping';
import { useImportProfiles } from '../../hooks/useImportProfiles';
import { getHeaderSignature } from '../../utils/importIdentity';
import { queryClient, trpc, trpcClient } from '../../api/trpc';
import FileDropZone from './FileDropZone';
import ColumnMapper, { type CsvColumnMapping } from './ColumnMapper';
import ImportPreview from './ImportPreview';
import BankDetector from './BankDetector';
import DataFreshnessPanel from './DataFreshnessPanel';
import {
  filterImportHistory,
  groupImportHistory,
  type ImportHistoryItem,
  type ImportHistorySummary,
} from './importHistoryTree';
import './ImportPage.css';

type ImportStage = 'upload' | 'mapping' | 'preview' | 'batch' | 'success';
type BulkAction = 'unimport' | 'reimport' | null;

interface BatchState {
  status: 'running' | 'cancelled' | 'error';
  total: number;
  index: number;
  currentFile?: File;
  importedCount: number;
  skippedDuplicateCount: number;
  completedFiles: number;
  error: string;
}

interface ImportProfileSummary {
  headerSignature: string;
  profileJson?: string | null;
}

interface ImportOptions {
  throwOnError?: boolean;
}

interface CommitImportResult {
  importedCount?: number | null;
  skippedDuplicateCount?: number | null;
}

interface ImportQueueStatusProps {
  files: File[];
  currentIndex: number;
  isBatchImport: boolean;
  currentFile: File | null;
  message: string;
  autoImportAll: boolean;
}

interface BatchImportProgressProps {
  state: BatchState;
  message: string;
  onCancel: () => void;
  onReset: () => void;
}

interface ImportHistoryProps {
  imports: ImportHistoryItem[];
  error: string;
  loading: boolean;
  unimportingId: number | null;
  reimportingId: number | null;
  bulkAction: BulkAction;
  onUnimport: (item: ImportHistoryItem) => void;
  onReimport: (item: ImportHistoryItem) => void;
  onBulkUnimport: (items: ImportHistoryItem[]) => void;
  onBulkReimport: (items: ImportHistoryItem[]) => void;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function asCsvColumnMapping(profile: ImportPreviewResult['profile'], headers: string[]): Partial<CsvColumnMapping> {
  return mappingFromProfile(profile, headers) as Partial<CsvColumnMapping>;
}

function getBatchStateFallback(
  files: File[],
  index: number,
  importedCount: number,
  skippedDuplicateCount: number,
): BatchState {
  return {
    status: 'running',
    total: files.length,
    index,
    currentFile: files[index],
    importedCount,
    skippedDuplicateCount,
    completedFiles: index,
    error: '',
  };
}

export default function ImportPage() {
  const { processImport, isParsing, error } = useCSVImport();
  const { importProfiles } = useImportProfiles();
  const typedImportProfiles = importProfiles as ImportProfileSummary[];
  const batchCancelRef = useRef(false);
  
  const [stage, setStage] = useState<ImportStage>('upload');
  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const [importResult, setImportResult] = useState<ImportPreviewResult | null>(null);
  const [importedCount, setImportedCount] = useState(0);
  const [skippedDuplicateCount, setSkippedDuplicateCount] = useState(0);
  const [importQueue, setImportQueue] = useState<File[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [queueImportedCount, setQueueImportedCount] = useState(0);
  const [queueSkippedDuplicateCount, setQueueSkippedDuplicateCount] = useState(0);
  const [autoImportAll, setAutoImportAll] = useState(false);
  const [queueMessage, setQueueMessage] = useState('');
  const [batchState, setBatchState] = useState<BatchState | null>(null);
  const [importHistory, setImportHistory] = useState<ImportHistoryItem[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(true);
  const [unimportingId, setUnimportingId] = useState<number | null>(null);
  const [reimportingId, setReimportingId] = useState<number | null>(null);
  const [historyBulkAction, setHistoryBulkAction] = useState<BulkAction>(null);

  const invalidateImportDependents = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.imports.history.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.dataFreshness.report.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.accounts.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.transactions.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: ['app', 'transactions', 'infinite'] }),
      queryClient.invalidateQueries({ queryKey: trpc.netWorth.report.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.reports.netWorth.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.reports.savingsRate.queryKey() }),
    ]);
  }, []);

  const loadImportHistory = useCallback(async () => {
    setHistoryError('');
    setHistoryLoading(true);
    try {
      const result = await trpcClient.imports.history.query();
      setImportHistory(result.imports || []);
    } catch (loadError) {
      setHistoryError(errorMessage(loadError, 'Could not load import history.'));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const refreshAfterCatchUpImport = useCallback(async () => {
    await invalidateImportDependents();
    await loadImportHistory();
  }, [invalidateImportDependents, loadImportHistory]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadImportHistory();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadImportHistory]);

  const queueTotal = importQueue.length;
  const isBatchImport = queueTotal > 1;

  const getFileLabel = (file?: File | null) => file?.webkitRelativePath || file?.name || 'selected file';

  const applySavedProfile = async (
    file: File,
    initialResult: ImportPreviewResult | null,
    options: ImportOptions = {},
  ): Promise<ImportPreviewResult | null> => {
    let result = initialResult;
    if (!result) return null;

    const headerSignature = getHeaderSignature(result.headers);
    const savedProfile = typedImportProfiles.find(profile => profile.headerSignature === headerSignature);
    if (savedProfile?.profileJson) {
      const profile = JSON.parse(savedProfile.profileJson);
      const remapped = await processImport(file, profile, options);
      if (remapped && !remapped.requiresMapping) {
        result = { ...remapped, savedImportProfile: savedProfile };
      }
    }
    return result;
  };

  const previewFile = async (file: File, options: ImportOptions = {}) => {
    const result = await processImport(file, null, options);
    return applySavedProfile(file, result, options);
  };

  const canCommitAutomatically = (result: ImportPreviewResult | null) => {
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

  const buildAutoAccountMappings = (result: ImportPreviewResult) => (result.accountMappings || []).map(mapping => ({
    sourceAccountId: mapping.sourceAccountId,
    mode: 'auto' as const,
  }));

  const commitPreviewResult = async (result: ImportPreviewResult): Promise<CommitImportResult> => {
    const accountMappings = buildAutoAccountMappings(result);
    return trpcClient.imports.commit.mutate({
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
    });
  };

  const processSelectedFile = async (file: File, index = 0) => {
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

  const handleFilesSelected = async (files: File[]) => {
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

  const handleFileSelected = async (file: File) => {
    await handleFilesSelected([file]);
  };

  const handleMappingComplete = async (mapping: CsvColumnMapping) => {
    if (!currentFile) return;
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

  const handleImportComplete = async (count: number, skipped = 0) => {
    const nextImportedCount = queueImportedCount + count;
    const nextSkippedCount = queueSkippedDuplicateCount + skipped;
    setQueueImportedCount(nextImportedCount);
    setQueueSkippedDuplicateCount(nextSkippedCount);
    setImportedCount(nextImportedCount);
    setSkippedDuplicateCount(nextSkippedCount);
    setQueueMessage('');
    await invalidateImportDependents();
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

  const runBatchImport = async (
    files: File[],
    startIndex = 0,
    initialResult: ImportPreviewResult | null = null,
  ) => {
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
        ...(previous ?? getBatchStateFallback(files, index, nextImportedCount, nextSkippedCount)),
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

        if (!result || !canCommitAutomatically(result)) {
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
          ...(previous ?? getBatchStateFallback(files, index, nextImportedCount, nextSkippedCount)),
          importedCount: nextImportedCount,
          skippedDuplicateCount: nextSkippedCount,
          completedFiles: index + 1,
        }));
      } catch (batchError) {
        const message = errorMessage(batchError, `${getFileLabel(file)}: Import failed`);
        setQueueMessage(message);
        setBatchState(previous => ({
          ...(previous ?? getBatchStateFallback(files, index, nextImportedCount, nextSkippedCount)),
          status: 'error',
          total: files.length,
          index,
          currentFile: file,
          completedFiles: index,
          error: message,
        }));
        setAutoImportAll(false);
        await invalidateImportDependents();
        await loadImportHistory();
        return;
      }
    }

    await invalidateImportDependents();
    await loadImportHistory();
    setAutoImportAll(false);
    setStage('success');
  };

  const handleStartAutoImportAll = () => {
    void runBatchImport(importQueue, queueIndex, importResult);
  };

  const handleAutoImportBlocked = (message?: string) => {
    setQueueMessage(message || 'This file needs your guidance before the batch can continue.');
  };

  const handleCancelBatch = () => {
    batchCancelRef.current = true;
    setQueueMessage('Stopping after the current file...');
  };

  const handleUnimport = async (item: ImportHistoryItem) => {
    const confirmed = window.confirm(`Unimport ${item.fileName}? This removes transactions and balances created by that import.`);
    if (!confirmed) return;

    setUnimportingId(item.id);
    setHistoryError('');
    try {
      await trpcClient.imports.unimport.mutate({ importFileId: item.id });
      await invalidateImportDependents();
      await loadImportHistory();
    } catch (unimportError) {
      setHistoryError(errorMessage(unimportError, 'Could not unimport file.'));
    } finally {
      setUnimportingId(null);
    }
  };

  const handleReimport = async (item: ImportHistoryItem) => {
    const confirmed = window.confirm(`Reimport ${item.fileName}? This restores saved source facts from this file.`);
    if (!confirmed) return;

    setReimportingId(item.id);
    setHistoryError('');
    try {
      await trpcClient.imports.reimport.mutate({ importFileId: item.id });
      await invalidateImportDependents();
      await loadImportHistory();
    } catch (reimportError) {
      setHistoryError(errorMessage(reimportError, 'Could not reimport file.'));
    } finally {
      setReimportingId(null);
    }
  };

  const handleBulkUnimport = async (items: ImportHistoryItem[]) => {
    if (items.length === 0) return;
    const confirmed = window.confirm(`Unimport ${items.length} import${items.length === 1 ? '' : 's'}? This removes their transactions and balances from the ledger.`);
    if (!confirmed) return;

    setHistoryBulkAction('unimport');
    setHistoryError('');
    try {
      await trpcClient.imports.bulkUnimport.mutate({ importFileIds: items.map(item => item.id) });
      await invalidateImportDependents();
      await loadImportHistory();
    } catch (bulkError) {
      setHistoryError(errorMessage(bulkError, 'Could not unimport selected files.'));
    } finally {
      setHistoryBulkAction(null);
    }
  };

  const handleBulkReimport = async (items: ImportHistoryItem[]) => {
    if (items.length === 0) return;
    const confirmed = window.confirm(`Reimport ${items.length} import${items.length === 1 ? '' : 's'}? This restores saved source facts and rebuilds the ledger.`);
    if (!confirmed) return;

    setHistoryBulkAction('reimport');
    setHistoryError('');
    try {
      await trpcClient.imports.bulkReimport.mutate({ importFileIds: items.map(item => item.id) });
      await invalidateImportDependents();
      await loadImportHistory();
    } catch (bulkError) {
      setHistoryError(errorMessage(bulkError, 'Could not reimport selected files.'));
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
          <DataFreshnessPanel onImportComplete={refreshAfterCatchUpImport} />
          <ImportHistory
            imports={importHistory}
            error={historyError}
            loading={historyLoading}
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
            initialMapping={asCsvColumnMapping(importResult.profile, importResult.headers)}
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

function ImportQueueStatus({ files, currentIndex, isBatchImport, currentFile, message, autoImportAll }: ImportQueueStatusProps) {
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

function BatchImportProgress({ state, message, onCancel, onReset }: BatchImportProgressProps) {
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

interface ImportHistoryFolderProps {
  id: string;
  label: string;
  summary: ImportHistorySummary;
  depth: 0 | 1 | 2;
  forceOpen: boolean;
  renderChildren: () => ReactNode;
}

function formatFileCount(count: number) {
  return `${count.toLocaleString()} ${count === 1 ? 'file' : 'files'}`;
}

function formatImportDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : '—';
}

function formatGroupStatus(summary: ImportHistorySummary) {
  if (summary.importedCount === summary.fileCount) return 'Imported';
  if (summary.unimportedCount === summary.fileCount) return 'Unimported';
  return `${summary.importedCount.toLocaleString()} imported`;
}

function formatImportStatus(status: string | null) {
  if (status === 'committed') return 'Imported';
  if (status === 'unimported') return 'Unimported';
  return status || 'Previewed';
}

function ImportHistoryFolder({
  id,
  label,
  summary,
  depth,
  forceOpen,
  renderChildren,
}: ImportHistoryFolderProps) {
  const [expanded, setExpanded] = useState(false);
  const open = forceOpen || expanded;

  return (
    <details
      className={`import-history__folder import-history__depth-${depth}`}
      open={open}
      onToggle={event => {
        if (!forceOpen) setExpanded(event.currentTarget.open);
      }}
      data-folder-id={id}
    >
      <summary className="import-history__tree-row import-history__folder-row">
        <span className="import-history__tree-name">
          <ChevronRight className="import-history__chevron" size={16} aria-hidden="true" />
          <Folder className="import-history__folder-icon" size={16} aria-hidden="true" />
          <strong>{label}</strong>
          <small>{formatFileCount(summary.fileCount)}</small>
        </span>
        <span className="import-history__group-status">{formatGroupStatus(summary)}</span>
        <span className="num">{summary.transactionCount.toLocaleString()}</span>
        <span className="num">{summary.balanceCount.toLocaleString()}</span>
        <span className="import-history__date">{formatImportDate(summary.latestAt)}</span>
        <span aria-hidden="true" />
      </summary>
      {open && <div className="import-history__folder-children">{renderChildren()}</div>}
    </details>
  );
}

function ImportHistory({
  imports,
  error,
  loading,
  unimportingId,
  reimportingId,
  bulkAction,
  onUnimport,
  onReimport,
  onBulkUnimport,
  onBulkReimport,
}: ImportHistoryProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const normalizedSearch = searchTerm.trim();
  const filteredImports = useMemo(
    () => filterImportHistory(imports, normalizedSearch),
    [imports, normalizedSearch],
  );
  const groups = useMemo(() => groupImportHistory(filteredImports), [filteredImports]);
  const committedImports = filteredImports.filter(item => item.status === 'committed');
  const reimportableImports = filteredImports.filter(item =>
    item.status === 'unimported' && item.unresolvedSourceAccountCount === 0
  );
  const hasSearch = normalizedSearch.length > 0;

  return (
    <section className="import-history" aria-busy={loading}>
      <div className="import-history__header">
        <h3>Import History</h3>
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

      {loading && imports.length === 0 ? (
        <div className="import-history__empty import-history__loading">
          <LoaderCircle size={16} aria-hidden="true" />
          Loading import history...
        </div>
      ) : imports.length === 0 ? (
        <div className="import-history__empty">No imports yet.</div>
      ) : filteredImports.length === 0 ? (
        <div className="import-history__empty">No imports match "{searchTerm}".</div>
      ) : (
        <div className="import-history__tree-wrap">
          {hasSearch && (
            <div className="import-history__result-count">
              Showing {filteredImports.length.toLocaleString()} of {imports.length.toLocaleString()} files
            </div>
          )}
          <div className="import-history__tree">
            <div className="import-history__tree-row import-history__tree-header" aria-hidden="true">
              <span>Owner / account / file</span>
              <span>Status</span>
              <span className="num">Transactions</span>
              <span className="num">Balances</span>
              <span>Imported</span>
              <span />
            </div>
            {groups.map(holder => (
              <ImportHistoryFolder
                key={holder.id}
                id={holder.id}
                label={holder.label}
                summary={holder.summary}
                depth={0}
                forceOpen={hasSearch}
                renderChildren={() => holder.accounts.map(account => (
                  <ImportHistoryFolder
                    key={account.id}
                    id={account.id}
                    label={account.label}
                    summary={account.summary}
                    depth={1}
                    forceOpen={hasSearch}
                    renderChildren={() => account.sources.map(source => (
                      <ImportHistoryFolder
                        key={source.id}
                        id={source.id}
                        label={source.label}
                        summary={source.summary}
                        depth={2}
                        forceOpen={hasSearch}
                        renderChildren={() => source.imports.map(item => {
                          const committed = item.status === 'committed';
                          const unimported = item.status === 'unimported';
                          const date = item.committedAt || item.createdAt;
                          return (
                            <div className="import-history__tree-row import-history__file-row" key={item.id}>
                              <span className="import-history__tree-name import-history__file">
                                <FileText size={15} aria-hidden="true" />
                                <span>
                                  <strong title={item.fileName}>{item.fileName}</strong>
                                  <small>{item.institution || 'Unknown source'}</small>
                                </span>
                              </span>
                              <span>
                                <span className={`import-history__status ${committed ? 'committed' : ''}`}>
                                  {formatImportStatus(item.status)}
                                </span>
                              </span>
                              <span className="num">{(item.transactionCount || 0).toLocaleString()}</span>
                              <span className="num">{(item.balanceCount || 0).toLocaleString()}</span>
                              <span className="import-history__date">{formatImportDate(date)}</span>
                              <span className="import-history__actions">
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
                              </span>
                            </div>
                          );
                        })}
                      />
                    ))}
                  />
                ))}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
