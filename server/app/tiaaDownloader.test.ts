import { describe, expect, test } from 'bun:test';

import {
  activityPeriodLabel,
  quarterEnds,
  statementDocumentLabel,
} from '../../.codex/skills/update-finance-data/scripts/tiaa.ts';

describe('TIAA downloader', () => {
  test('builds completed quarter targets inside the requested range', () => {
    expect(quarterEnds('2026-01-01', '2026-08-16')).toEqual([
      { date: '2026-03-31', quarter: 1, year: 2026 },
      { date: '2026-06-30', quarter: 2, year: 2026 },
    ]);
  });

  test('maps activity requests to TIAA Quick Download periods', () => {
    expect(activityPeriodLabel('2026-01-01', '2026-08-16', 2026)).toBe('Current year');
    expect(activityPeriodLabel('2025-01-01', '2025-12-31', 2026)).toBe('2025');
    expect(() => activityPeriodLabel('2025-01-01', '2026-08-16', 2026)).toThrow('one calendar year');
    expect(() => activityPeriodLabel('2023-01-01', '2023-12-31', 2026)).toThrow('does not offer activity');
  });

  test('maps statement filenames to current TIAA document labels', () => {
    expect(statementDocumentLabel({
      fileName: 'tiaa-2026-06-30-retirement-q2-2026-0000.pdf',
      kind: 'pdf',
      path: '/tmp/statement.pdf',
    })).toBe('RETIREMENT Q2/2026');
  });
});
