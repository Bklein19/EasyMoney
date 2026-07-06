import { useCallback, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { UploadCloud } from 'lucide-react';
import './FileDropZone.css';

interface FileDropZoneProps {
  onFileSelected?: (file: File) => void;
  onFilesSelected?: (files: File[]) => void;
  isParsing?: boolean;
}

export default function FileDropZone({ onFileSelected, onFilesSelected, isParsing }: FileDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const isSupportedFile = (file: File) => /\.(csv|txt|pdf|html?)$/i.test(file.name);

  const submitFiles = useCallback((files: File[]) => {
    const supportedFiles = Array.from(files).filter(isSupportedFile);
    if (supportedFiles.length === 0) {
      alert('Please upload CSV, PDF, or HTML import files.');
      return;
    }
    if (supportedFiles.length !== files.length) {
      alert(`Skipped ${files.length - supportedFiles.length} unsupported file${files.length - supportedFiles.length === 1 ? '' : 's'}.`);
    }
    if (supportedFiles.length === 1 && onFileSelected) {
      onFileSelected(supportedFiles[0]);
      return;
    }
    if (onFilesSelected) {
      onFilesSelected(supportedFiles);
      return;
    }
    onFileSelected?.(supportedFiles[0]);
  }, [onFileSelected, onFilesSelected]);

  const handleDrag = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragIn = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }, []);

  const handleDragOut = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
    if (files.length > 0) {
      submitFiles(files);
    }
  }, [submitFiles]);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      submitFiles(Array.from(e.target.files));
      e.target.value = '';
    }
  };

  return (
    <div
      className={`file-drop-zone ${isDragging ? 'dragging' : ''} ${isParsing ? 'parsing' : ''}`}
      onDragEnter={handleDragIn}
      onDragLeave={handleDragOut}
      onDragOver={handleDrag}
      onDrop={handleDrop}
    >
      <input
        type="file"
        id="fileInput"
        accept=".csv,.txt,.pdf,.html,.htm,text/csv,text/html,application/pdf"
        multiple
        className="file-input-hidden"
        onChange={handleFileChange}
        disabled={isParsing}
      />
      <label htmlFor="fileInput" className="drop-zone-content">
        <UploadCloud size={16} className="drop-icon" />
        <span>{isParsing ? 'Parsing files...' : 'Drop files or browse'}</span>
      </label>
    </div>
  );
}
