import { meta, default as parse } from './moneyParsers/fidelity-netbenefits-statement-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';
import { withFidelityRemoteAccountIds } from './fidelityAccountIdentity.ts';

const parser = createMoneyParserAdapter({
  meta,
  name: 'Fidelity NetBenefits Statement',
  parseMoneyFile: parse,
});

export const fidelityNetBenefitsStatementParser = {
  ...parser,
  async parse(input: Parameters<typeof parser.parse>[0]) {
    return withFidelityRemoteAccountIds(await parser.parse(input));
  },
};
