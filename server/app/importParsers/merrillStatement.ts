import { meta, default as parse } from './moneyParsers/merrill-cma-statement-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const merrillStatementParser = createMoneyParserAdapter({
  meta,
  name: 'Merrill Statement',
  parseMoneyFile: parse,
});
