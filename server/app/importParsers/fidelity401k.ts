import { meta, default as parse } from './moneyParsers/fidelity-401k-html.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';

export const fidelity401kParser = createMoneyParserAdapter({
  meta,
  name: 'Fidelity 401(k)',
  parseMoneyFile: parse,
});
