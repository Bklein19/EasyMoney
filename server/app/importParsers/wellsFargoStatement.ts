import { meta, default as parse } from '../../../money/parsers/wells-fargo-statement-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const wellsFargoStatementParser = createMoneyParserAdapter({
  meta,
  name: 'Wells Fargo Statement',
  parseMoneyFile: parse,
});
