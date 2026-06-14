import { useState } from 'react';
import { useCSVImport } from '../../hooks/useCSVImport';
import { SUPPORTED_BANK_NAMES } from '../../import/parsers';
import { buildCustomProfile, mappingFromProfile } from '../../utils/bankProfiles';
import { useImportProfiles } from '../../hooks/useImportProfiles';
import { getHeaderSignature } from '../../utils/importIdentity';
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
    setStage('success');
  };

  const resetImport = () => {
    setStage('upload');
    setCurrentFile(null);
    setImportResult(null);
    setImportedCount(0);
    setSkippedDuplicateCount(0);
  };

  return (
    <div className="import-page">
      <header className="page-header">
        <h1 className="page-title">Import Transactions</h1>
        <p className="page-subtitle">Upload a CSV file from your bank to add transactions</p>
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
          
          <div className="supported-formats glass-card">
            <h3>Supported Banks</h3>
            <p>We automatically detect formats from {SUPPORTED_BANK_NAMES.join(', ')}. For other banks, you can easily map the columns yourself.</p>
          </div>
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
              savedImportProfile: importResult.savedImportProfile
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
