import { meta, default as parse } from './moneyParsers/vanguard-activity-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const vanguardActivityParser = createMoneyParserAdapter({
  meta,
  name: 'Vanguard Activity',
  parseMoneyFile: parse,
});
