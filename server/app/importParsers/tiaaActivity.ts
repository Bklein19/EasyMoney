import { meta, default as parse } from './moneyParsers/tiaa-activity-csv.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const tiaaActivityParser = createMoneyParserAdapter({
  meta,
  name: 'TIAA Activity',
  parseMoneyFile: parse,
});
