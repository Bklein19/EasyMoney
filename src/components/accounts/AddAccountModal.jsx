import { useState } from 'react';
import { X } from 'lucide-react';
import { useAccounts } from '../../hooks/useAccounts';
import './AddAccountModal.css';

export default function AddAccountModal({ onClose }) {
  const { addAccount } = useAccounts();
  
  const [formData, setFormData] = useState({
    name: '',
    institution: '',
    type: 'checking',
    currency: 'USD'
  });

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    await addAccount(formData);
    onClose();
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content glass-card">
        <div className="modal-header">
          <h2>Add New Account</h2>
          <button className="icon-btn" onClick={onClose}><X size={20} /></button>
        </div>
        
        <form onSubmit={handleSubmit} className="modal-form">
          <div className="form-group">
            <label htmlFor="name">Account Name</label>
            <input
              type="text"
              id="name"
              name="name"
              required
              value={formData.name}
              onChange={handleChange}
              placeholder="e.g. Everyday Checking"
              className="form-input"
            />
          </div>

          <div className="form-group">
            <label htmlFor="institution">Institution</label>
            <input
              type="text"
              id="institution"
              name="institution"
              value={formData.institution}
              onChange={handleChange}
              placeholder="e.g. Chase"
              className="form-input"
            />
          </div>

          <div className="form-row">
            <div className="form-group flex-1">
              <label htmlFor="type">Account Type</label>
              <select 
                id="type" 
                name="type" 
                value={formData.type} 
                onChange={handleChange}
                className="form-input"
              >
                <option value="checking">Checking</option>
                <option value="savings">Savings</option>
                <option value="credit">Credit Card</option>
                <option value="investment">Investment</option>
                <option value="loan">Loan</option>
              </select>
            </div>

            <div className="form-group flex-1">
              <label htmlFor="currency">Currency</label>
              <select 
                id="currency" 
                name="currency" 
                value={formData.currency} 
                onChange={handleChange}
                className="form-input"
              >
                <option value="USD">USD ($)</option>
                <option value="EUR">EUR (€)</option>
                <option value="GBP">GBP (£)</option>
                <option value="CAD">CAD ($)</option>
              </select>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Add Account</button>
          </div>
        </form>
      </div>
    </div>
  );
}
