import { meta, default as parse } from '../../../money/parsers/morgan-stanley-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const morganStanleyStatementParser = createMoneyParserAdapter({
  meta,
  name: 'Morgan Stanley Statement',
  parseMoneyFile: parse,
});
