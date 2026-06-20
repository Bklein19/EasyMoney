import { meta, default as parse } from './moneyParsers/vanguard-statement-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const vanguardStatementParser = createMoneyParserAdapter({
  meta,
  name: 'Vanguard Statement',
  parseMoneyFile: parse,
});
