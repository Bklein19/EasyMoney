import { meta, default as parse } from './moneyParsers/fidelity-portfolio-statement-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const fidelityPortfolioStatementParser = createMoneyParserAdapter({
  meta,
  name: 'Fidelity Portfolio Statement',
  parseMoneyFile: parse,
});
