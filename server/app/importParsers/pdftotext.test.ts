import { expect, test } from 'bun:test';
import { extractPdfText, pdftotextCandidates } from './pdftotext.ts';

test('desktop macOS lookup includes both Homebrew prefixes without shell PATH', () => {
  expect(pdftotextCandidates('darwin', '')).toEqual(['pdftotext', '/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext']);
  expect(pdftotextCandidates('linux', '')).toEqual(['pdftotext']);
});

test('explicit executable overrides are authoritative', () => {
  expect(pdftotextCandidates('darwin', '/custom tools/pdftotext')).toEqual(['/custom tools/pdftotext']);
});

test('missing tool gives actionable error instead of falling back to lossy text', () => {
  for (const layout of [true, false]) {
    expect(() => extractPdfText('/not-read.pdf', layout, ['/nonexistent-easymoney-pdftotext']))
      .toThrow('PDF import requires Poppler pdftotext');
  }
});

test('extraction failures are not disguised as dependency failures', () => {
  expect(() => extractPdfText('/not-read.pdf', true, [process.execPath]))
    .not.toThrow('PDF import requires Poppler pdftotext');
});
