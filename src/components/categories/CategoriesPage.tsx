import { Fragment, useMemo, useState, type FormEvent } from 'react';
import { Check, ChevronRight, Trash2 } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { useCategories } from '../../hooks/useCategories';
import { CATEGORY_GROUP_LABELS, CATEGORY_GROUPS, categoryGroupKey } from '../../utils/categoryGroups';
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

interface CategoryChanges {
  name: string;
  type: string | null;
  categoryGroup: string | null;
  description: string | null;
}

const CATEGORY_TYPES = ['expense', 'income', 'transfer', 'internal_transfer', 'investment'] as const;

function labelFor(value: string | null | undefined, labels: Record<string, string> = {}) {
  if (!value) return 'None';
  return labels[value] ?? value.replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function CategoryDetails({
  category,
  isSaving,
  isDeleting,
  isConfirmingDelete,
  error,
  onSave,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  isNew = false,
}: {
  category: Category;
  isSaving: boolean;
  isDeleting: boolean;
  isConfirmingDelete: boolean;
  error?: string;
  onSave: (changes: CategoryChanges) => void;
  isNew?: boolean;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const [description, setDescription] = useState(category.description || '');
  const [name, setName] = useState(category.name);
  const [type, setType] = useState(category.type || '');
  const [group, setGroup] = useState(category.categoryGroup || '');
  const currentDescription = category.description || '';
  const isDirty = isNew || description.trim() !== currentDescription || name.trim() !== category.name || type !== (category.type || '') || group !== (category.categoryGroup || '');
  const isProtected = category.name === 'Uncategorized';
  const canDelete = !isNew && !isProtected;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ name: name.trim(), type: type || null, categoryGroup: group || null, description: description.trim() || null });
  };

  return (
    <div className="category-details-panel" onClick={(event) => event.stopPropagation()}>
      <form className="category-meta-form" onSubmit={submit}>
        <div className="category-field">
          <label htmlFor={`category-name-${category.id}`}>Name</label>
          <input id={`category-name-${category.id}`} required value={name} disabled={isSaving || isProtected} onChange={event => setName(event.target.value)} placeholder="e.g. Gifts received" />
        </div>
        <div className="category-field">
          <label htmlFor={`category-type-${category.id}`}>Type</label>
          <select id={`category-type-${category.id}`} value={type} disabled={isSaving || isProtected} onChange={event => setType(event.target.value)}>
            <option value="">None</option>
            {type && !CATEGORY_TYPES.some(value => value === type) && <option value={type}>{labelFor(type)}</option>}
            {CATEGORY_TYPES.map(value => <option key={value} value={value}>{labelFor(value)}</option>)}
          </select>
        </div>
        <div className="category-field">
          <label htmlFor={`category-group-${category.id}`}>Group</label>
          <select id={`category-group-${category.id}`} value={group} disabled={isSaving} onChange={event => setGroup(event.target.value)}>
            <option value="">None</option>
            {group && !CATEGORY_GROUPS.some(value => value.key === group) && <option value={group}>{labelFor(group)}</option>}
            {CATEGORY_GROUPS.map(value => <option key={value.key} value={value.key}>{value.label}</option>)}
          </select>
        </div>
        <p className="category-form-help">For payroll or gifts received, choose Income as the type and group. Changing a type affects reporting for transactions already in this category.</p>
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
            disabled={isSaving || !isDirty || !name.trim()}
          >
            <Check size={14} />
            {isSaving ? 'Saving...' : isNew ? 'Create category' : 'Save'}
          </button>
          {isNew && <button className="btn btn--ghost btn--sm" type="button" disabled={isSaving} onClick={onCancelDelete}>Cancel</button>}
          {canDelete && (
            isConfirmingDelete ? (
              <div className="category-delete-confirm" role="group" aria-label={`Confirm deleting ${category.name}`}>
                <span>Move annotations to Uncategorized and delete?</span>
                <button
                  className="btn btn--danger btn--sm"
                  type="button"
                  disabled={isSaving || isDeleting}
                  onClick={onConfirmDelete}
                >
                  {isDeleting ? 'Deleting...' : 'Delete'}
                </button>
                <button
                  className="btn btn--ghost btn--sm"
                  type="button"
                  disabled={isDeleting}
                  onClick={onCancelDelete}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="btn btn--ghost btn--sm category-delete-button"
                type="button"
                disabled={isSaving || isDeleting}
                onClick={onRequestDelete}
              >
                <Trash2 size={14} />
                Delete
              </button>
            )
          )}
        </div>
        {error && <div className="category-details-error">{error}</div>}
      </form>
    </div>
  );
}

export default function CategoriesPage() {
  const { categories, addCategory, updateCategory, deleteCategory, isLoading } = useCategories();
  const [isCreating, setIsCreating] = useState(false);
  const [searchParams] = useSearchParams();
  const [expandedCategoryId, setExpandedCategoryId] = useState<number | null>(null);
  const [savingCategoryId, setSavingCategoryId] = useState<number | null>(null);
  const [deletingCategoryId, setDeletingCategoryId] = useState<number | null>(null);
  const [confirmingDeleteCategoryId, setConfirmingDeleteCategoryId] = useState<number | null>(null);
  const [errorByCategoryId, setErrorByCategoryId] = useState<Record<number, string>>({});

  const selectedGroup = searchParams.get('group') || '';
  const selectedGroupLabel = CATEGORY_GROUPS.find(group => group.key === selectedGroup)?.label ?? '';
  const sortedCategories = useMemo(
    () => [...categories]
      .filter((category: Category) => !selectedGroup || categoryGroupKey(category.categoryGroup) === selectedGroup)
      .sort((a: Category, b: Category) =>
        labelFor(a.categoryGroup, CATEGORY_GROUP_LABELS).localeCompare(labelFor(b.categoryGroup, CATEGORY_GROUP_LABELS)) ||
        a.name.localeCompare(b.name)
      ),
    [categories, selectedGroup]
  );

  const saveCategory = async (category: Category, changes: CategoryChanges) => {
    setSavingCategoryId(category.id);
    setErrorByCategoryId(current => ({ ...current, [category.id]: '' }));
    try {
      if (category.id === 0) {
        await addCategory({ ...changes });
        setIsCreating(false);
      } else {
        await updateCategory(category.id, { ...changes });
      }
    } catch (saveError) {
      setErrorByCategoryId(current => ({
        ...current,
        [category.id]: saveError instanceof Error ? saveError.message : 'Could not update category.',
      }));
    } finally {
      setSavingCategoryId(null);
    }
  };

  const removeCategory = async (category: Category) => {
    setDeletingCategoryId(category.id);
    setErrorByCategoryId(current => ({ ...current, [category.id]: '' }));
    try {
      await deleteCategory(category.id);
      setExpandedCategoryId(current => current === category.id ? null : current);
      setConfirmingDeleteCategoryId(current => current === category.id ? null : current);
    } catch (deleteError) {
      setErrorByCategoryId(current => ({
        ...current,
        [category.id]: deleteError instanceof Error ? deleteError.message : 'Could not delete category.',
      }));
    } finally {
      setDeletingCategoryId(null);
    }
  };

  return (
    <div className="page categories-page">
      <header className="page__header categories-page__header">
        <div>
          <h1 className="page__title">
            Categories <span className="categories-page__count">{sortedCategories.length}</span>
          </h1>
          <p className="page__subtitle">
            {selectedGroupLabel ? `${selectedGroupLabel} categories.` : 'Organize income and spending. Descriptions also guide categorization.'}
          </p>
        </div>
        <button className="btn btn--primary" type="button" disabled={isCreating} onClick={() => { setErrorByCategoryId(current => ({ ...current, 0: '' })); setIsCreating(true); }}>New category</button>
      </header>

      {isCreating && <section aria-label="New category">
        <h2>New category</h2>
        <CategoryDetails category={{ id: 0, name: '', type: selectedGroup === 'income' ? 'income' : 'expense', categoryGroup: selectedGroup || null }} isNew isSaving={savingCategoryId === 0} isDeleting={false} isConfirmingDelete={false} error={errorByCategoryId[0]} onSave={changes => saveCategory({ id: 0, name: '', type: null, categoryGroup: null }, changes)} onCancelDelete={() => setIsCreating(false)} onRequestDelete={() => {}} onConfirmDelete={() => {}} />
      </section>}

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
                const isDeleting = deletingCategoryId === category.id;
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
                            key={JSON.stringify(category)}
                            category={category}
                            isSaving={isSaving}
                            isDeleting={isDeleting}
                            isConfirmingDelete={confirmingDeleteCategoryId === category.id}
                            error={errorByCategoryId[category.id]}
                            onSave={(changes) => saveCategory(category, changes)}
                            onRequestDelete={() => setConfirmingDeleteCategoryId(category.id)}
                            onCancelDelete={() => setConfirmingDeleteCategoryId(null)}
                            onConfirmDelete={() => removeCategory(category)}
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
