import { meta, default as parse } from '../../../money/parsers/bofa-statement-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const bofaStatementParser = createMoneyParserAdapter({
  meta,
  name: 'Bank of America Statement',
  parseMoneyFile: parse,
});
