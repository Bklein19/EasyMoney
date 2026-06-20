import type { AppImportParseInput, AppImportParseResult, AppImportParser } from '../importTypes.ts';
import { meta, default as parse } from './moneyParsers/robinhood-statement-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

const adapted = createMoneyParserAdapter({
  meta,
  name: 'Robinhood Statement',
  parseMoneyFile: parse,
});

function isUuidPdf(fileName: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/i.test(fileName);
}

export const robinhoodStatementParser: AppImportParser = {
  ...adapted,
  matches: ({ fileName, sample }) => isUuidPdf(fileName) || meta.matches({ filename: fileName, sample }),
  parse(input: AppImportParseInput): Promise<AppImportParseResult> {
    return adapted.parse(input) as Promise<AppImportParseResult>;
  },
};
