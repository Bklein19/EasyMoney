import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountPicker } from './AccountPicker';

test('grouped picker has static section labels, selection state and no folder controls', () => {
  const html = renderToStaticMarkup(<AccountPicker variant="owner-groups" accounts={[
    { id: 1, name: 'Brokerage', institution: 'Vanguard', type: 'investment', account_holder: 'Michael' },
    { id: 2, name: 'Checking', institution: 'Bank', type: 'checking', account_holder: 'Annie' },
  ]} selectedIds={new Set([1])} onChange={() => {}} />);
  expect(html).toContain('<section class="account-owner-group" aria-label="Annie">');
  expect(html).toContain('<h3 class="account-owner-group__header">');
  expect(html).not.toContain('<details');
  expect(html).not.toContain('account-owner-chevron');
  expect(html).not.toContain('lucide-folder');
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('aria-pressed="false"');
  expect(html).toContain('account-row-picker__meta">Vanguard</span>');
  expect(html).not.toContain('>investment<');
  expect(html).not.toContain('account-picker-selection-shortcuts');
  expect(html).not.toContain('Selection shortcuts');
});
