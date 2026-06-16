import { meta, default as parse } from '../../../money/parsers/tiaa-statement-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const tiaaStatementParser = createMoneyParserAdapter({
  meta,
  name: 'TIAA Statement',
  parseMoneyFile: parse,
});
