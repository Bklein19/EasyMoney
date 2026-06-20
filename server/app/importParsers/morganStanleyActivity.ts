import { meta, default as parse } from './moneyParsers/morgan-stanley-activity-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const morganStanleyActivityParser = createMoneyParserAdapter({
  meta,
  name: 'Morgan Stanley Activity',
  parseMoneyFile: parse,
});
