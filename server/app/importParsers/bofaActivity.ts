import { meta, default as parse } from './moneyParsers/bofa-activity-csv.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const bofaActivityParser = createMoneyParserAdapter({
  meta,
  name: 'Bank of America Activity',
  parseMoneyFile: parse,
});
