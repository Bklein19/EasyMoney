import { meta, default as parse } from '../../../money/parsers/fidelity-401k-html.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const fidelity401kParser = createMoneyParserAdapter({
  meta,
  name: 'Fidelity 401(k)',
  parseMoneyFile: parse,
});
