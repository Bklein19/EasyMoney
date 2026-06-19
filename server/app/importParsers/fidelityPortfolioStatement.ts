import { meta, default as parse } from '../../../money/parsers/fidelity-portfolio-statement-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const fidelityPortfolioStatementParser = createMoneyParserAdapter({
  meta,
  name: 'Fidelity Portfolio Statement',
  parseMoneyFile: parse,
});
