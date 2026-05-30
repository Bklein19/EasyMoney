import { Search } from 'lucide-react';

const EmptyState = ({ 
  icon: Icon = Search, 
  title = 'No results found', 
  description = 'Try adjusting your search or filters.', 
  action 
}) => {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">
        <Icon size={32} />
      </div>
      <h3 className="empty-state__title">{title}</h3>
      <p className="empty-state__description">{description}</p>
      {action && <div className="empty-state__action">{action}</div>}
    </div>
  );
};

export default EmptyState;
