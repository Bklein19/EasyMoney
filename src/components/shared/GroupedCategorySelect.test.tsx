import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GroupedCategorySelect from './GroupedCategorySelect';

const categories = [
  { id: 1, name: 'Income', categoryGroup: 'income', parentId: null },
  { id: 2, name: 'Payroll', categoryGroup: 'income', parentId: 1 },
  { id: 3, name: 'Gifts Received', categoryGroup: 'income', parentId: 1 },
];

test('manual category picker exposes the same income hierarchy as the category editor', () => {
  const html = renderToStaticMarkup(
    createElement(GroupedCategorySelect, { categories, value: 2, onChange: () => {} }),
  );
  expect(html).toContain('<optgroup label="Income">');
  expect(html).toContain('<option value="2" selected="">Income › Payroll</option>');
  expect(html).toContain('Income › Gifts Received');
  expect(html.indexOf('value="1"')).toBeLessThan(html.indexOf('value="3"'));
  expect(html.indexOf('value="3"')).toBeLessThan(html.indexOf('value="2"'));
});

test('suggested categories retain their hierarchy and are not listed twice', () => {
  const html = renderToStaticMarkup(
    createElement(GroupedCategorySelect, {
      categories,
      value: 2,
      suggestedCategoryId: 2,
      onChange: () => {},
    }),
  );
  expect(html).toContain(
    '<optgroup label="Suggested"><option value="2" selected="">Income › Payroll</option>',
  );
  expect(html.match(/value="2"/g)).toHaveLength(1);
});
