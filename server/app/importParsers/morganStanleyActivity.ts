import { meta, default as parse } from '../../../money/parsers/morgan-stanley-activity-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const morganStanleyActivityParser = createMoneyParserAdapter({
  meta,
  name: 'Morgan Stanley Activity',
  parseMoneyFile: parse,
});
