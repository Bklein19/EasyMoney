import Papa from 'papaparse';

export function parseCsvRows(text: string): string[][] {
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), {
    header: false,
    skipEmptyLines: true,
  });
  const fatalError = result.errors.find(error => error.type !== 'FieldMismatch');
  if (fatalError) throw new Error(fatalError.message);
  return result.data;
}

export function normalizedHeader(value = '') {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function rowRecord(headers: string[], row: string[]) {
  return Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']));
}
