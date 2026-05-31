import { useState, useRef, useEffect } from 'react';
import { Tag } from 'lucide-react';

export default function CategoryPicker({ categoryId, onChange, disabled, categories = [], addCategory }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const wrapperRef = useRef(null);

  const selectedCat = categories.find(c => c.id === categoryId);
  const label = selectedCat ? selectedCat.name : 'Uncategorized';

  const resetCreateState = () => {
    setIsCreating(false);
    setNewCategoryName('');
  };

  const handleCreateCategory = async (event) => {
    event.preventDefault();

    const name = newCategoryName.trim();
    if (!name) return;

    const existing = categories.find(category => category.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      onChange(existing.id);
      setIsOpen(false);
      resetCreateState();
      return;
    }

    const id = await addCategory({
      name,
      type: ['investment', 'investments'].includes(name.toLowerCase()) ? 'investment' : 'expense',
      color: '#94a3b8',
      icon: 'tag'
    });
    onChange(id);
    setIsOpen(false);
    resetCreateState();
  };

  useEffect(() => {
    if (!isOpen) return undefined;

    function handleClickOutside(event) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  return (
    <div className="category-picker-wrapper" ref={wrapperRef}>
      <button 
        className="category-picker-btn" 
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        type="button"
      >
        <Tag size={12} />
        {label}
      </button>

      {isOpen && (
        <div className="category-picker-popover">
          <button 
            className="category-option"
            onClick={() => { onChange(null); setIsOpen(false); }}
          >
            Uncategorized
          </button>
          {categories.map(cat => (
            <button
              key={cat.id}
              className="category-option"
              onClick={() => { onChange(cat.id); setIsOpen(false); }}
            >
              {cat.name}
            </button>
          ))}
          {isCreating ? (
            <form className="inline-create category-create-form" onSubmit={handleCreateCategory}>
              <input
                className="input input--sm inline-create__input"
                value={newCategoryName}
                onChange={(event) => setNewCategoryName(event.target.value)}
                placeholder="Category name"
                autoFocus
              />
              <div className="inline-create__actions">
                <button className="btn btn--primary btn--sm" type="submit" disabled={!newCategoryName.trim()}>
                  Add
                </button>
                <button className="btn btn--ghost btn--sm" type="button" onClick={resetCreateState}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              className="category-option category-option--create"
              onClick={() => setIsCreating(true)}
            >
              + Add custom category
            </button>
          )}
        </div>
      )}
    </div>
  );
}
