import { meta, default as parse } from './moneyParsers/sequoia-fund-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const sequoiaFundStatementParser = createMoneyParserAdapter({
  meta,
  name: 'Sequoia Fund Statement',
  parseMoneyFile: parse,
});
