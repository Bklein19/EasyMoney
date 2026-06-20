import { meta, default as parse } from './moneyParsers/wells-fargo-activity-csv.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const wellsFargoActivityParser = createMoneyParserAdapter({
  meta,
  name: 'Wells Fargo Activity',
  parseMoneyFile: parse,
});
