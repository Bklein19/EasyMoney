import { meta, default as parse } from './moneyParsers/fidelity-portfolio-statement-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';
import { withFidelityRemoteAccountIds } from './fidelityAccountIdentity.ts';

const parser = createMoneyParserAdapter({
  meta,
  name: 'Fidelity Portfolio Statement',
  parseMoneyFile: parse,
});

export const fidelityPortfolioStatementParser = {
  ...parser,
  async parse(input: Parameters<typeof parser.parse>[0]) {
    return withFidelityRemoteAccountIds(await parser.parse(input));
  },
};
