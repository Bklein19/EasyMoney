import { expect, test } from 'bun:test';
import { backupReason, backupSection } from './backupPresentation';
test('saved choice links land directly in their own section, including old links', () => {
  expect(backupSection('choices', null)).toBe('choices');
  expect(backupSection(null, 'open')).toBe('choices');
  expect(backupSection('updates', 'open')).toBe('updates');
  expect(backupSection('invalid', null)).toBe('backups');
});
test('backup reasons have readable labels without leaking filenames', () => {
  expect(backupReason('date-before-parser-refresh-uuid.sqlite')).toBe('Before an import update');
  expect(backupReason('date-before-migration-uuid.sqlite')).toBe('Before a database upgrade');
  expect(backupReason('date-manual-uuid.sqlite')).toBe('Manual backup');
  expect(backupReason('other.sqlite')).toBe('Automatic backup');
});
