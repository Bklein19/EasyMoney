import type { AppImportParseInput, AppImportParseResult, AppImportParser, ParsedImportTransaction } from '../importTypes.ts';
import { parseAmount, parseDate } from './csvMapping.ts';

export const wellsFargoGenericActivityParser: AppImportParser = {
  id: 'wells-fargo-generic-activity-csv',
  name: 'Wells Fargo Activity CSV',
  institution: 'Wells Fargo',
  sourceType: 'activity-export',
  priority: 90,
  matches: ({ fileName, headers, sample }) => (
    !hasNormalizedAccountFilename(fileName) &&
    (hasWellsFargoActivityHeaders(headers) || hasWellsFargoActivityHeaderInSample(sample))
  ),
  parse,
};

function normalizeHeader(value = '') {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function hasNormalizedAccountFilename(fileName: string) {
  return /^wells-fargo-(checking|autograph-visa|platinum-card)-\d{4}-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/i.test(fileName);
}

function hasWellsFargoActivityHeaders(headers: string[]) {
  const normalized = headers.map(normalizeHeader);
  return (
    normalized[0] === 'date' &&
    normalized[1] === 'description' &&
    normalized[2] === 'amount' &&
    (normalized[3] === 'check' || normalized[3] === 'checknumber') &&
    normalized[4] === 'status'
  );
}

function parseCsvLine(line: string) {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }

  fields.push(field);
  return fields;
}

function hasWellsFargoActivityHeaderInSample(sample: string) {
  return sample
    .split(/\r?\n/)
    .slice(0, 3)
    .some(line => hasWellsFargoActivityHeaders(parseCsvLine(line)));
}

function getRowValue(row: Record<string, string>, headers: string[], normalizedName: string) {
  const header = headers.find(candidate => normalizeHeader(candidate) === normalizedName);
  return header ? row[header] : '';
}

function parseRow(row: Record<string, string>, headers: string[], sourceRowIndex: number): ParsedImportTransaction | null {
  const dateRaw = getRowValue(row, headers, 'date')?.trim();
  const description = getRowValue(row, headers, 'description')?.replace(/\s+/g, ' ').trim();
  const amountRaw = getRowValue(row, headers, 'amount')?.trim();
  const status = getRowValue(row, headers, 'status')?.trim();
  const checkNumber = getRowValue(row, headers, normalizeHeader('CHECK #'))?.trim() ||
    getRowValue(row, headers, 'checknumber')?.trim();

  if (!dateRaw || !description || !amountRaw) return null;
  if (status && status.toLowerCase() !== 'posted') return null;

  const date = parseDate(dateRaw, ['MM/dd/yyyy', 'M/d/yyyy']);
  const amount = parseAmount(amountRaw);
  if (!date || amount === null) return null;

  return {
    sourceRowIndex,
    date: date.toISOString(),
    amountCents: Math.round(amount * 100),
    description,
    institution: 'Wells Fargo',
    account: null,
    sourceRole: 'activity',
    raw: {
      source: 'wells-fargo-generic-csv',
      checkNumber: checkNumber || undefined,
      status: status || undefined,
    },
  };
}

function parse(input: AppImportParseInput): AppImportParseResult {
  return {
    transactions: input.rows.map((row, index) => parseRow(row, input.headers, index)),
    balances: [],
  };
}
