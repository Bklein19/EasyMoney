import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Tag } from 'lucide-react';

const POPOVER_WIDTH = 260;
const POPOVER_GAP = 4;
const POPOVER_MARGIN = 12;

export default function CategoryPicker({ categoryId, onChange, disabled, categories = [], addCategory }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [popoverPosition, setPopoverPosition] = useState(null);
  const wrapperRef = useRef(null);
  const buttonRef = useRef(null);
  const popoverRef = useRef(null);

  const selectedCat = categories.find(c => c.id === categoryId);
  const label = selectedCat ? selectedCat.name : 'Uncategorized';

  const updatePopoverPosition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;

    const buttonRect = button.getBoundingClientRect();
    const popoverHeight = popoverRef.current?.offsetHeight || 250;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const availableBelow = viewportHeight - buttonRect.bottom - POPOVER_GAP - POPOVER_MARGIN;
    const availableAbove = buttonRect.top - POPOVER_GAP - POPOVER_MARGIN;
    const openAbove = availableBelow < Math.min(popoverHeight, 180) && availableAbove > availableBelow;
    const maxHeight = Math.max(140, Math.min(250, openAbove ? availableAbove : availableBelow));
    const left = Math.min(
      Math.max(POPOVER_MARGIN, buttonRect.left),
      Math.max(POPOVER_MARGIN, viewportWidth - POPOVER_WIDTH - POPOVER_MARGIN)
    );
    const top = openAbove
      ? Math.max(POPOVER_MARGIN, buttonRect.top - Math.min(popoverHeight, maxHeight) - POPOVER_GAP)
      : Math.min(viewportHeight - POPOVER_MARGIN - maxHeight, buttonRect.bottom + POPOVER_GAP);

    setPopoverPosition({ top, left, maxHeight });
  }, []);

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
      const target = event.target;
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(target) &&
        popoverRef.current &&
        !popoverRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    }
    function handleKeyDown(event) {
      if (event.key === 'Escape') setIsOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setPopoverPosition(null);
      return undefined;
    }

    updatePopoverPosition();
    window.addEventListener('scroll', updatePopoverPosition, true);
    window.addEventListener('resize', updatePopoverPosition);
    return () => {
      window.removeEventListener('scroll', updatePopoverPosition, true);
      window.removeEventListener('resize', updatePopoverPosition);
    };
  }, [isOpen, updatePopoverPosition]);

  useLayoutEffect(() => {
    if (isOpen) updatePopoverPosition();
  }, [isOpen, isCreating, categories.length, updatePopoverPosition]);

  const popover = isOpen && popoverPosition ? createPortal(
    <div
      className="category-picker-popover"
      ref={popoverRef}
      style={{
        top: popoverPosition.top,
        left: popoverPosition.left,
        maxHeight: popoverPosition.maxHeight,
      }}
    >
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
    </div>,
    document.body
  ) : null;

  return (
    <div className="category-picker-wrapper" ref={wrapperRef}>
      <button 
        className="category-picker-btn" 
        ref={buttonRef}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        type="button"
      >
        <Tag size={12} />
        {label}
      </button>
      {popover}
    </div>
  );
}
