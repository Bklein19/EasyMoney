import { meta, default as parse } from './moneyParsers/fidelity-netbenefits-statement-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const fidelityNetBenefitsStatementParser = createMoneyParserAdapter({
  meta,
  name: 'Fidelity NetBenefits Statement',
  parseMoneyFile: parse,
});
