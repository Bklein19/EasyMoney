import { meta, default as parse } from './moneyParsers/merrill-activity-csv.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const merrillActivityParser = createMoneyParserAdapter({
  meta,
  name: 'Merrill Activity',
  parseMoneyFile: parse,
});
