import { describe, expect, test } from 'bun:test';

import { hashImportContent } from './imports.ts';

describe('import content hashing', () => {
  test('hashes binary artifacts from their bytes rather than empty extracted text', () => {
    const firstPdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    const secondPdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x32]);

    expect(hashImportContent('', firstPdf)).not.toBe(hashImportContent('', secondPdf));
    expect(hashImportContent('', firstPdf)).not.toBe(hashImportContent(''));
  });

  test('uses bytes consistently for text artifacts when provided', () => {
    const text = 'Date,Amount\n2026-08-17,10.00';
    expect(hashImportContent(text, new TextEncoder().encode(text))).toBe(hashImportContent(text));
  });
});
