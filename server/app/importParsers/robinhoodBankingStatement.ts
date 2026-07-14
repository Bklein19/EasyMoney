import { meta, default as parse } from './moneyParsers/robinhood-banking-statement-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const robinhoodBankingStatementParser = createMoneyParserAdapter({
  meta,
  name: 'Robinhood Banking Statement',
  parseMoneyFile: parse,
});
