import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import Button from './Button';
import './Modal.css';

const Modal = ({ isOpen, onClose, title, children, footer, maxWidth = '520px', className = '' }) => {
  const modalRef = useRef(null);

  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEsc);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEsc);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={handleOverlayClick} aria-modal="true" role="dialog">
      <div 
        className={`modal-container ${className}`}
        ref={modalRef}
        style={{ maxWidth }}
      >
        {title && (
          <div className="modal-header">
            <h2 className="modal-title">{title}</h2>
            <Button variant="ghost" iconOnly onClick={onClose} aria-label="Close modal">
              <X size={20} />
            </Button>
          </div>
        )}
        <div className="modal-body">
          {children}
        </div>
        {footer && (
          <div className="modal-footer">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

export default Modal;
