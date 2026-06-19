import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
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
  
  const [stage, setStage] = useState('upload'); // upload, mapping, preview, success
  const [currentFile, setCurrentFile] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [importedCount, setImportedCount] = useState(0);
  const [skippedDuplicateCount, setSkippedDuplicateCount] = useState(0);
  const [importHistory, setImportHistory] = useState([]);
  const [historyError, setHistoryError] = useState('');
  const [unimportingId, setUnimportingId] = useState(null);

  const loadImportHistory = async () => {
    setHistoryError('');
    try {
      const result = await appRequest('/imports');
      setImportHistory(result.imports || []);
    } catch (loadError) {
      setHistoryError(loadError?.message || 'Could not load import history.');
    }
  };

  useEffect(() => {
    loadImportHistory();
  }, []);

  const handleFileSelected = async (file) => {
    setCurrentFile(file);
    let result = await processImport(file);
    
    if (result) {
      const headerSignature = getHeaderSignature(result.headers);
      const savedProfile = importProfiles.find(profile => profile.headerSignature === headerSignature);
      if (savedProfile?.profileJson) {
        const profile = JSON.parse(savedProfile.profileJson);
        const remapped = await processImport(file, profile);
        if (remapped && !remapped.requiresMapping) {
          result = { ...remapped, savedImportProfile: savedProfile };
        }
      }

      setImportResult(result);
      if (result.requiresMapping) {
        setStage('mapping');
      } else {
        setStage('preview');
      }
    }
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

  const handleImportComplete = (count, skipped = 0) => {
    setImportedCount(count);
    setSkippedDuplicateCount(skipped);
    loadImportHistory();
    setStage('success');
  };

  const resetImport = () => {
    setStage('upload');
    setCurrentFile(null);
    setImportResult(null);
    setImportedCount(0);
    setSkippedDuplicateCount(0);
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

  return (
    <div className="import-page">
      <header className="page-header">
        <h1 className="page-title">Import Transactions</h1>
        <p className="page-subtitle">Upload a bank export or statement to add transactions and balances</p>
      </header>

      {error && (
        <div className="error-banner">
          <strong>Error:</strong> {error}
        </div>
      )}

      {stage === 'upload' && (
        <div className="upload-container">
          <FileDropZone 
            onFileSelected={handleFileSelected} 
            isParsing={isParsing} 
          />
          <ImportHistory
            imports={importHistory}
            error={historyError}
            unimportingId={unimportingId}
            onUnimport={handleUnimport}
          />
        </div>
      )}

      {stage === 'mapping' && importResult && (
        <div className="mapping-container">
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
            }}
            onComplete={handleImportComplete}
            onCancel={resetImport}
          />
        </div>
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

function ImportHistory({ imports, error, unimportingId, onUnimport }) {
  return (
    <div className="import-history glass-card">
      <div className="import-history__header">
        <div>
          <h3>Import History</h3>
          <p>Remove a prior import if you need to test the file again.</p>
        </div>
      </div>

      {error && <div className="import-history__error">{error}</div>}

      {imports.length === 0 ? (
        <div className="import-history__empty">No imports yet.</div>
      ) : (
        <div className="import-history__list">
          {imports.map(item => {
            const committed = item.status === 'committed';
            const date = item.committedAt || item.createdAt;
            return (
              <div className="import-history__row" key={item.id}>
                <div className="import-history__main">
                  <strong>{item.fileName}</strong>
                  <span>
                    {item.institution || item.parserName || 'Unknown format'}
                    {date && ` | ${new Date(date).toLocaleString()}`}
                  </span>
                </div>
                <div className="import-history__meta">
                  <span className={`import-history__status ${committed ? 'committed' : ''}`}>
                    {item.status || 'previewed'}
                  </span>
                  <span>{item.transactionCount || 0} tx</span>
                  {item.balanceCount > 0 && <span>{item.balanceCount} bal</span>}
                </div>
                <button
                  type="button"
                  className="icon-btn delete-btn"
                  title="Unimport file"
                  onClick={() => onUnimport(item)}
                  disabled={!committed || unimportingId === item.id}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
