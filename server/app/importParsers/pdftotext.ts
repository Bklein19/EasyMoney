import { execFileSync } from 'node:child_process';

export function pdftotextCandidates(platform = process.platform, override = process.env.EASYMONEY_PDFTOTEXT): string[] {
  // An explicit override is authoritative: do not silently use another version.
  if (override) return [override];
  return platform === 'darwin'
    ? ['pdftotext', '/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext']
    : ['pdftotext'];
}

export function extractPdfText(path: string, layout: boolean, candidates = pdftotextCandidates()): string {
  for (const command of candidates) {
    try {
      return execFileSync(command, [...(layout ? ['-layout'] : []), path, '-'], {
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      });
    } catch (error) {
      // Invalid PDFs, permissions, and unsuccessful extraction are not missing dependencies.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('PDF import requires Poppler pdftotext. Install Poppler (macOS: brew install poppler; Ubuntu: sudo apt install poppler-utils), or set EASYMONEY_PDFTOTEXT to its executable path, then restart EasyMoney. No plain-text fallback is used because it loses statement columns.');
}
