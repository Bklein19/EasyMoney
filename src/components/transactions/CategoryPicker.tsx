import { useState, type FormEvent } from 'react';
import GroupedCategorySelect, { isUncategorized } from '../shared/GroupedCategorySelect';

const ADD_CUSTOM_CATEGORY = '__add_custom_category__';
const UNCATEGORIZED_CATEGORY = '__uncategorized_category__';

interface Category {
  id: number | string;
  name: string;
  categoryGroup?: string | null;
  color?: string | null;
}

interface CategoryPickerProps {
  categoryId: number | string | null | undefined;
  onChange: (categoryId: number | string | null) => void;
  disabled?: boolean;
  categories?: Category[];
  addCategory: (category: Record<string, unknown>) => Promise<number | string>;
}

export default function CategoryPicker({
  categoryId,
  onChange,
  disabled = false,
  categories = [],
  addCategory,
}: CategoryPickerProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');

  const resetCreateState = () => {
    setIsCreating(false);
    setNewCategoryName('');
  };

  const handleSelectChange = (value: string) => {
    if (value === ADD_CUSTOM_CATEGORY) {
      setIsCreating(true);
      return;
    }
    resetCreateState();
    onChange(value === UNCATEGORIZED_CATEGORY ? null : value);
  };

  const handleCreateCategory = async (event: FormEvent) => {
    event.preventDefault();

    const name = newCategoryName.trim();
    if (!name) return;

    const existing = categories.find(category => category.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      onChange(existing.id);
      resetCreateState();
      return;
    }

    const id = await addCategory({
      name,
      type: ['investment', 'investments'].includes(name.toLowerCase()) ? 'investment' : 'expense',
      color: '#94a3b8',
      icon: 'tag',
    });
    onChange(id);
    resetCreateState();
  };

  return (
    <div className="category-picker-wrapper">
      <GroupedCategorySelect
        className="filter-input category-picker-select"
        value={categoryId === null || categoryId === undefined ? UNCATEGORIZED_CATEGORY : String(categoryId)}
        disabled={disabled}
        aria-label="Transaction category"
        categories={categories.filter(category => !isUncategorized(category))}
        leadingOptions={[{ value: UNCATEGORIZED_CATEGORY, label: 'Uncategorized' }]}
        trailingOptions={[{ value: ADD_CUSTOM_CATEGORY, label: '+ Add custom category' }]}
        onChange={handleSelectChange}
      />
      {isCreating && (
        <form className="inline-create category-create-form" onSubmit={handleCreateCategory}>
          <input
            className="input input--sm inline-create__input"
            value={newCategoryName}
            disabled={disabled}
            placeholder="Category name"
            autoFocus
            onChange={(event) => setNewCategoryName(event.target.value)}
          />
          <div className="inline-create__actions">
            <button className="btn btn--primary btn--sm" type="submit" disabled={disabled || !newCategoryName.trim()}>
              Add
            </button>
            <button className="btn btn--ghost btn--sm" type="button" disabled={disabled} onClick={resetCreateState}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
