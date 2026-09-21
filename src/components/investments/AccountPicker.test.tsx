import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountPicker } from './AccountPicker';

test('grouped picker has collapsible folders, selection state and no shortcut controls', () => {
  const html = renderToStaticMarkup(<AccountPicker variant="owner-groups" accounts={[
    { id: 1, name: 'Brokerage', institution: 'Vanguard', type: 'investment', account_holder: 'Michael' },
    { id: 2, name: 'Checking', institution: 'Bank', type: 'checking', account_holder: 'Annie' },
  ]} selectedIds={new Set([1])} onChange={() => {}} />);
  expect(html).toContain('<details class="account-owner-group" open="">');
  expect(html).toContain('account-owner-chevron');
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('aria-pressed="false"');
  expect(html).toContain('investment');
  expect(html).not.toContain('account-picker-selection-shortcuts');
  expect(html).not.toContain('Selection shortcuts');
});
