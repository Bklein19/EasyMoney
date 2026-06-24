import { Fragment, useMemo, useState, type FormEvent } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { useCategories } from '../../hooks/useCategories';
import './CategoriesPage.css';

interface Category {
  id: number;
  name: string;
  type: string | null;
  categoryGroup: string | null;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
}

const CATEGORY_GROUP_LABELS: Record<string, string> = {
  income: 'Income',
  transfer: 'Transfers',
  fixed: 'Fixed / Recurring',
  variable: 'Variable / Necessary',
  discretionary: 'Discretionary',
  savings_investment: 'Savings / Investment',
  other: 'Other',
};

function labelFor(value: string | null | undefined, labels: Record<string, string> = {}) {
  if (!value) return 'None';
  return labels[value] ?? value.replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function CategoryDetails({
  category,
  isSaving,
  error,
  onSave,
}: {
  category: Category;
  isSaving: boolean;
  error?: string;
  onSave: (changes: { description: string | null }) => void;
}) {
  const [description, setDescription] = useState(category.description || '');
  const currentDescription = category.description || '';
  const isDirty = description.trim() !== currentDescription;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ description: description.trim() || null });
  };

  return (
    <div className="category-details-panel" onClick={(event) => event.stopPropagation()}>
      <form className="category-meta-form" onSubmit={submit}>
        <div className="category-field category-field--wide">
          <label htmlFor={`category-description-${category.id}`}>Description</label>
          <textarea
            id={`category-description-${category.id}`}
            value={description}
            rows={4}
            placeholder="Describe what belongs in this category."
            disabled={isSaving}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="category-details-actions">
          <button
            className="btn btn--primary btn--sm"
            type="submit"
            disabled={isSaving || !isDirty}
          >
            <Check size={14} />
            Save
          </button>
        </div>
        {error && <div className="category-details-error">{error}</div>}
      </form>
    </div>
  );
}

export default function CategoriesPage() {
  const { categories, updateCategory, isLoading } = useCategories();
  const [expandedCategoryId, setExpandedCategoryId] = useState<number | null>(null);
  const [savingCategoryId, setSavingCategoryId] = useState<number | null>(null);
  const [errorByCategoryId, setErrorByCategoryId] = useState<Record<number, string>>({});

  const sortedCategories = useMemo(
    () => [...categories].sort((a: Category, b: Category) =>
      labelFor(a.categoryGroup, CATEGORY_GROUP_LABELS).localeCompare(labelFor(b.categoryGroup, CATEGORY_GROUP_LABELS)) ||
      a.name.localeCompare(b.name)
    ),
    [categories]
  );

  const saveCategory = async (category: Category, changes: { description: string | null }) => {
    setSavingCategoryId(category.id);
    setErrorByCategoryId(current => ({ ...current, [category.id]: '' }));
    try {
      await updateCategory(category.id, changes);
    } catch (saveError) {
      setErrorByCategoryId(current => ({
        ...current,
        [category.id]: saveError instanceof Error ? saveError.message : 'Could not update category.',
      }));
    } finally {
      setSavingCategoryId(null);
    }
  };

  return (
    <div className="page categories-page">
      <header className="page__header categories-page__header">
        <div>
          <h1 className="page__title">
            Categories <span className="categories-page__count">{categories.length}</span>
          </h1>
          <p className="page__subtitle">Edit category guidance used during AI review.</p>
        </div>
      </header>

      <div className="categories-table-wrap">
        {isLoading ? (
          <div className="empty-state-simple">Loading categories...</div>
        ) : sortedCategories.length === 0 ? (
          <div className="empty-state-simple">No categories yet.</div>
        ) : (
          <table className="categories-table">
            <colgroup>
              <col className="categories-table__category" />
              <col className="categories-table__type" />
              <col className="categories-table__group" />
              <col className="categories-table__description" />
              <col className="categories-table__action" />
            </colgroup>
            <thead>
              <tr>
                <th>Category</th>
                <th>Type</th>
                <th>Group</th>
                <th>Description</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {sortedCategories.map((category: Category) => {
                const isExpanded = expandedCategoryId === category.id;
                const isSaving = savingCategoryId === category.id;
                return (
                  <Fragment key={category.id}>
                    <tr
                      className={`category-row ${isExpanded ? 'is-expanded' : ''}`}
                      onClick={() => setExpandedCategoryId(isExpanded ? null : category.id)}
                    >
                      <td>
                        <div className="category-row__name">
                          <span
                            className="category-swatch"
                            style={{ backgroundColor: category.color || 'var(--text-muted)' }}
                            aria-hidden="true"
                          />
                          <span>{category.name}</span>
                        </div>
                      </td>
                      <td><span className="category-chip">{labelFor(category.type)}</span></td>
                      <td><span className="category-chip">{labelFor(category.categoryGroup, CATEGORY_GROUP_LABELS)}</span></td>
                      <td className="category-row__description">
                        {category.description || 'No description'}
                      </td>
                      <td className="category-row__disclosure">
                        <button
                          className="icon-btn category-expand-btn"
                          type="button"
                          aria-label={isExpanded ? 'Close category details' : 'Open category details'}
                          aria-expanded={isExpanded}
                          onClick={(event) => {
                            event.stopPropagation();
                            setExpandedCategoryId(isExpanded ? null : category.id);
                          }}
                        >
                          <ChevronRight size={15} />
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="category-details-row">
                        <td colSpan={5}>
                          <CategoryDetails
                            key={`${category.id}-${category.description || ''}`}
                            category={category}
                            isSaving={isSaving}
                            error={errorByCategoryId[category.id]}
                            onSave={(changes) => saveCategory(category, changes)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
