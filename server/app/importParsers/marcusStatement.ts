import { meta, default as parse } from '../../../money/parsers/marcus-statement-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const marcusStatementParser = createMoneyParserAdapter({
  meta,
  name: 'Marcus Statement',
  parseMoneyFile: parse,
});
