import { meta, default as parse } from './moneyParsers/tiaa-statement-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const tiaaStatementParser = createMoneyParserAdapter({
  meta,
  name: 'TIAA Statement',
  parseMoneyFile: parse,
});
