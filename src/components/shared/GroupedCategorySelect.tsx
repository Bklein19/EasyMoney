import type { CSSProperties, SelectHTMLAttributes } from 'react';
import { Sparkles } from 'lucide-react';
import { CATEGORY_GROUPS } from '../../utils/categoryGroups';

interface Category {
  id: number | string;
  name: string;
  categoryGroup?: string | null;
  color?: string | null;
}

interface CategoryOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface GroupedCategorySelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> {
  value: number | string | null | undefined;
  categories: Category[];
  onChange: (value: string) => void;
  leadingOptions?: CategoryOption[];
  trailingOptions?: CategoryOption[];
  suggestedCategoryId?: number | string | null;
  showSuggestionIcon?: boolean;
  excludeCategoryIds?: Array<number | string | null | undefined>;
  controlClassName?: string;
}

function normalizedId(value: number | string | null | undefined) {
  return value === null || value === undefined ? '' : String(value);
}

function isUncategorized(category: Category) {
  return category.name.toLowerCase() === 'uncategorized';
}

export default function GroupedCategorySelect({
  value,
  categories,
  onChange,
  leadingOptions = [],
  trailingOptions = [],
  suggestedCategoryId,
  showSuggestionIcon = false,
  excludeCategoryIds = [],
  controlClassName = '',
  className = 'filter-input',
  style,
  ...selectProps
}: GroupedCategorySelectProps) {
  const selectedValue = normalizedId(value);
  const suggestedValue = normalizedId(suggestedCategoryId);
  const selectedCategory = categories.find(category => normalizedId(category.id) === selectedValue) ?? null;
  const suggestedCategory = categories.find(category => normalizedId(category.id) === suggestedValue) ?? null;
  const excludedIds = new Set(excludeCategoryIds.map(normalizedId).filter(Boolean));
  if (suggestedValue) excludedIds.add(suggestedValue);

  const availableCategories = categories.filter(category => !excludedIds.has(normalizedId(category.id)));
  const knownGroupKeys = new Set<string>(CATEGORY_GROUPS.map(group => group.key).filter(key => key !== 'other'));
  const groupedCategories = CATEGORY_GROUPS
    .map(group => ({
      ...group,
      categories: group.key === 'other'
        ? availableCategories.filter(category => !knownGroupKeys.has(category.categoryGroup ?? ''))
        : availableCategories.filter(category => category.categoryGroup === group.key),
    }))
    .filter(group => group.categories.length > 0);
  const controlClasses = [
    'grouped-category-select-control',
    selectedCategory ? 'has-category' : '',
    showSuggestionIcon ? 'has-suggestion' : '',
    controlClassName,
  ].filter(Boolean).join(' ');

  return (
    <div
      className={controlClasses}
      style={{
        '--grouped-category-color': selectedCategory?.color || 'transparent',
        ...style,
      } as CSSProperties}
    >
      {showSuggestionIcon && (
        <span className="grouped-category-select-control__icon" title="AI suggestion">
          <Sparkles size={13} />
        </span>
      )}
      <select
        {...selectProps}
        className={className}
        value={selectedValue}
        onChange={(event) => onChange(event.target.value)}
      >
        {leadingOptions.map(option => (
          <option key={`leading-${option.value}`} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
        {suggestedCategory && (
          <optgroup label="Suggested">
            <option value={suggestedValue}>{suggestedCategory.name}</option>
          </optgroup>
        )}
        {groupedCategories.map(group => (
          <optgroup key={group.key} label={group.label}>
            {group.categories.map(category => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </optgroup>
        ))}
        {trailingOptions.map(option => (
          <option key={`trailing-${option.value}`} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export { isUncategorized };
