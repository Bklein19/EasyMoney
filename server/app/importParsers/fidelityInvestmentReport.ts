import { meta, default as parse } from '../../../money/parsers/fidelity-investment-report-pdf.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const fidelityInvestmentReportParser = createMoneyParserAdapter({
  meta,
  name: 'Fidelity Investment Report',
  parseMoneyFile: parse,
});
