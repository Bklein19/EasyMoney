import { useCallback, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import './FileDropZone.css';

export default function FileDropZone({ onFileSelected, isParsing }) {
  const [isDragging, setIsDragging] = useState(false);
  const isSupportedFile = (file) => /\.(csv|txt|pdf|html?)$/i.test(file.name);

  const handleDrag = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragIn = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }, []);

  const handleDragOut = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (isSupportedFile(file)) {
        onFileSelected(file);
      } else {
        alert('Please upload a CSV, PDF, or HTML import file.');
      }
      e.dataTransfer.clearData();
    }
  }, [onFileSelected]);

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      onFileSelected(e.target.files[0]);
    }
  };

  return (
    <div
      className={`file-drop-zone glass-card ${isDragging ? 'dragging' : ''} ${isParsing ? 'parsing' : ''}`}
      onDragEnter={handleDragIn}
      onDragLeave={handleDragOut}
      onDragOver={handleDrag}
      onDrop={handleDrop}
    >
      <input
        type="file"
        id="fileInput"
        accept=".csv,.txt,.pdf,.html,.htm,text/csv,text/html,application/pdf"
        className="file-input-hidden"
        onChange={handleFileChange}
        disabled={isParsing}
      />
      <label htmlFor="fileInput" className="drop-zone-content">
        <UploadCloud size={48} className="drop-icon" />
        {isParsing ? (
          <h3>Parsing file...</h3>
        ) : (
          <>
            <h3>Drag & Drop your import file here</h3>
            <p>or click to browse your files</p>
          </>
        )}
      </label>
    </div>
  );
}
