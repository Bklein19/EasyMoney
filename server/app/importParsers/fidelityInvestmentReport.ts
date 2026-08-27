import { meta, default as parse } from './moneyParsers/fidelity-investment-report-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';
import { withFidelityRemoteAccountIds } from './fidelityAccountIdentity.ts';

const parser = createMoneyParserAdapter({
  meta,
  name: 'Fidelity Investment Report',
  parseMoneyFile: parse,
});

export const fidelityInvestmentReportParser = {
  ...parser,
  async parse(input: Parameters<typeof parser.parse>[0]) {
    return withFidelityRemoteAccountIds(await parser.parse(input));
  },
};
