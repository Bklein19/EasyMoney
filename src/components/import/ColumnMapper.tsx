import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { ArrowRight, Settings } from 'lucide-react';
import './ColumnMapper.css';

export interface CsvColumnMapping {
  statementType: 'bank' | 'credit_card';
  dateColumn: string;
  descriptionColumn: string;
  merchantColumn: string;
  categoryColumn: string;
  splitAmount: boolean;
  amountColumn: string;
  debitColumn: string;
  creditColumn: string;
  negativeIsDebit: boolean;
  positiveIsCharge: boolean;
}

interface ColumnMapperProps {
  headers: string[];
  initialMapping?: Partial<CsvColumnMapping>;
  onComplete: (mapping: CsvColumnMapping) => void;
  onCancel: () => void;
}

const DEFAULT_MAPPING: CsvColumnMapping = {
  statementType: 'bank',
  dateColumn: '',
  descriptionColumn: '',
  merchantColumn: '',
  categoryColumn: '',
  splitAmount: false,
  amountColumn: '',
  debitColumn: '',
  creditColumn: '',
  negativeIsDebit: true,
  positiveIsCharge: true
};

export default function ColumnMapper({ headers, initialMapping = {}, onComplete, onCancel }: ColumnMapperProps) {
  const [mapping, setMapping] = useState({
    ...DEFAULT_MAPPING,
    ...initialMapping
  });

  const handleChange = (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    const nextValue = type === 'checkbox' && e.target instanceof HTMLInputElement
      ? e.target.checked
      : value;
    setMapping(prev => ({
      ...prev,
      [name]: nextValue
    }));
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!mapping.dateColumn || !mapping.descriptionColumn) {
      alert("Date and Description columns are required.");
      return;
    }
    if (mapping.splitAmount) {
      if (!mapping.debitColumn && !mapping.creditColumn) {
        alert(mapping.statementType === 'credit_card'
          ? "Select at least one column for Charges or Payments."
          : "Select at least one column for Debit or Credit.");
        return;
      }
    } else {
      if (!mapping.amountColumn) {
        alert("Amount column is required.");
        return;
      }
    }
    onComplete(mapping);
  };

  return (
    <div className="column-mapper glass-card">
      <div className="mapper-header">
        <Settings className="mapper-icon" size={24} />
        <h2>Map Your Columns</h2>
        <p>Match the columns in your CSV to the fields EasyMoney needs.</p>
      </div>

      <form onSubmit={handleSubmit} className="mapper-form">
        <div className="form-group">
          <label>Statement Type</label>
          <select name="statementType" value={mapping.statementType} onChange={handleChange} className="form-input">
            <option value="bank">Bank account statement</option>
            <option value="credit_card">Credit card statement</option>
          </select>
          <p className="form-hint">Credit card imports treat card charges as spending and card payments as transfers, not income.</p>
        </div>

        <div className="form-group">
          <label>Date Column *</label>
          <select name="dateColumn" value={mapping.dateColumn} onChange={handleChange} required className="form-input">
            <option value="">-- Select Column --</option>
            {headers.map(h => <option key={h} value={h}>{h}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label>Description / Details Column *</label>
          <select name="descriptionColumn" value={mapping.descriptionColumn} onChange={handleChange} required className="form-input">
            <option value="">-- Select Column --</option>
            {headers.map(h => <option key={h} value={h}>{h}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label>Merchant / Payee Column (Optional)</label>
          <select name="merchantColumn" value={mapping.merchantColumn} onChange={handleChange} className="form-input">
            <option value="">Use description column</option>
            {headers.map(h => <option key={h} value={h}>{h}</option>)}
          </select>
          <p className="form-hint">Use this when your CSV has a cleaner merchant name separate from the bank's full transaction memo.</p>
        </div>

        <div className="form-group">
          <label className="checkbox-label">
            <input 
              type="checkbox" 
              name="splitAmount" 
              checked={mapping.splitAmount} 
              onChange={handleChange} 
            />
                {mapping.statementType === 'credit_card'
                  ? 'My amounts are split into two columns (Charges / Payments)'
                  : 'My amounts are split into two columns (Debits / Credits)'}
              </label>
        </div>

        {mapping.splitAmount ? (
          <div className="form-row">
            <div className="form-group flex-1">
              <label>{mapping.statementType === 'credit_card' ? 'Charge Column' : 'Debit (Expense) Column'}</label>
              <select name="debitColumn" value={mapping.debitColumn} onChange={handleChange} className="form-input">
                <option value="">-- Select Column --</option>
                {headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div className="form-group flex-1">
              <label>{mapping.statementType === 'credit_card' ? 'Payment / Credit Column' : 'Credit (Income) Column'}</label>
              <select name="creditColumn" value={mapping.creditColumn} onChange={handleChange} className="form-input">
                <option value="">-- Select Column --</option>
                {headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          </div>
        ) : (
          <>
            <div className="form-group">
              <label>Amount Column *</label>
              <select name="amountColumn" value={mapping.amountColumn} onChange={handleChange} required={!mapping.splitAmount} className="form-input">
                <option value="">-- Select Column --</option>
                {headers.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="checkbox-label">
                <input 
                  type="checkbox" 
                  name={mapping.statementType === 'credit_card' ? 'positiveIsCharge' : 'negativeIsDebit'}
                  checked={mapping.statementType === 'credit_card' ? mapping.positiveIsCharge : mapping.negativeIsDebit}
                  onChange={handleChange} 
                />
                {mapping.statementType === 'credit_card'
                  ? 'Positive numbers mean card charges'
                  : 'Negative numbers mean expenses (debits)'}
              </label>
            </div>
          </>
        )}

        <div className="form-group">
          <label>Category Column (Optional)</label>
          <select name="categoryColumn" value={mapping.categoryColumn} onChange={handleChange} className="form-input">
            <option value="">-- Select Column --</option>
            {headers.map(h => <option key={h} value={h}>{h}</option>)}
          </select>
        </div>

        <div className="mapper-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary">
            Continue <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
