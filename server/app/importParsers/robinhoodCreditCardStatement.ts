import { meta, default as parse } from './moneyParsers/robinhood-credit-card-statement-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const robinhoodCreditCardStatementParser = createMoneyParserAdapter({
  meta,
  name: 'Robinhood Credit Card Statement',
  parseMoneyFile: parse,
});
