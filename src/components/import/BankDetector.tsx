import { CheckCircle2, AlertCircle, Settings } from 'lucide-react';
import './BankDetector.css';

interface BankDetectorProps {
  profileUsed?: string | null;
  requiresMapping?: boolean;
  onReviewMapping?: () => void;
}

export default function BankDetector({ profileUsed, requiresMapping, onReviewMapping }: BankDetectorProps) {
  if (requiresMapping) {
    return (
      <div className="bank-detector warning glass-card">
        <AlertCircle size={20} className="icon warning-icon" />
        <div className="content">
          <h4>{profileUsed ? 'Review Column Mapping' : 'Unrecognized CSV Format'}</h4>
          <p>
            {profileUsed
              ? 'Adjust the detected columns or switch the statement type before previewing the import.'
              : "We couldn't automatically detect the bank format. Please map the columns manually."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bank-detector success glass-card">
      <CheckCircle2 size={20} className="icon success-icon" />
      <div className="content">
        <h4>Format Detected: {profileUsed}</h4>
        <p>We automatically mapped your columns based on this profile.</p>
      </div>
      {onReviewMapping && (
        <button type="button" className="btn btn-secondary btn--sm detector-action" onClick={onReviewMapping}>
          <Settings size={16} />
          Review Mapping
        </button>
      )}
    </div>
  );
}
