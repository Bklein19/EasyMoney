import { expect, test } from 'bun:test';
import {
  syncArtifactSourceLabel,
  syncArtifactSubtitle,
  syncArtifactTitle,
} from './syncArtifactLabels.ts';

test('summarizes activity by year while exact dates remain in the coverage column', () => {
  const artifact = {
    coveredFrom: '2026-01-01',
    coveredTo: '2026-08-24',
    institution: 'Vanguard',
    parserLabel: 'Vanguard Activity CSV',
    sourceType: 'activity-export',
  };

  expect(syncArtifactTitle(artifact)).toBe('2026 activity');
  expect(syncArtifactSubtitle(artifact)).toBe('Vanguard Activity CSV');
});

test('summarizes quarterly and monthly statements from parsed fact coverage', () => {
  expect(syncArtifactTitle({
    coveredFrom: '2026-04-02',
    coveredTo: '2026-06-30',
    institution: 'TIAA',
    parserLabel: 'TIAA Statement',
    sourceType: 'statement',
  })).toBe('Q2 2026 statement');
  expect(syncArtifactTitle({
    coveredFrom: '2026-07-01',
    coveredTo: '2026-07-31',
    institution: 'Vanguard',
    parserLabel: 'Vanguard Statement',
    sourceType: 'statement',
  })).toBe('July 2026 statement');
});

test('falls back to the human parser label when parsed facts have no dates', () => {
  const undated = {
    coveredFrom: null,
    coveredTo: null,
    institution: 'Example Bank',
    parserLabel: 'Example Bank Statement',
    sourceType: 'statement',
  };
  expect(syncArtifactTitle(undated)).toBe('Example Bank Statement');
  expect(syncArtifactSubtitle(undated)).toBeNull();
  expect(syncArtifactTitle({
    coveredFrom: null,
    coveredTo: null,
    institution: null,
    parserLabel: '  ',
    sourceType: 'balance-snapshot',
  })).toBe('balance snapshot');
  expect(syncArtifactSourceLabel(null)).toBe('Unknown artifact type');
});
