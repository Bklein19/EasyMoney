import { meta, default as parse } from '../../../money/parsers/merrill-cma-statement-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const merrillStatementParser = createMoneyParserAdapter({
  meta,
  name: 'Merrill Statement',
  parseMoneyFile: parse,
});
