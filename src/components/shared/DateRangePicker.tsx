import { Calendar } from 'lucide-react';

interface DateRangePickerProps {
  startDate?: string | null;
  endDate?: string | null;
  onStartDateChange: (value: string) => void;
  onEndDateChange: (value: string) => void;
  className?: string;
}

const DateRangePicker = ({ startDate, endDate, onStartDateChange, onEndDateChange, className = '' }: DateRangePickerProps) => {
  return (
    <div className={`date-range-picker flex items-center gap-2 ${className}`}>
      <div className="relative flex items-center">
        <Calendar size={16} className="absolute left-3 text-muted" />
        <input
          type="date"
          className="input pl-9"
          value={startDate || ''}
          onChange={(e) => onStartDateChange(e.target.value)}
          aria-label="Start Date"
        />
      </div>
      <span className="text-muted text-sm">to</span>
      <div className="relative flex items-center">
        <Calendar size={16} className="absolute left-3 text-muted" />
        <input
          type="date"
          className="input pl-9"
          value={endDate || ''}
          onChange={(e) => onEndDateChange(e.target.value)}
          aria-label="End Date"
        />
      </div>
    </div>
  );
};

export default DateRangePicker;
