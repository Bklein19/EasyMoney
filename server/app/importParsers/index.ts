import type { AppImportParser } from '../importTypes.ts';
import { bofaActivityParser } from './bofaActivity.ts';
import { bofaStatementParser } from './bofaStatement.ts';
import { chaseCreditCardParser } from './chaseCreditCard.ts';
import { easyMoneyCsvProfileParsers } from './easyMoneyCsvProfiles.ts';
import { fidelity401kParser } from './fidelity401k.ts';
import { fidelityInvestmentReportParser } from './fidelityInvestmentReport.ts';
import { marcusStatementParser } from './marcusStatement.ts';
import { merrillActivityParser } from './merrillActivity.ts';
import { merrillStatementParser } from './merrillStatement.ts';
import { morganStanleyActivityParser } from './morganStanleyActivity.ts';
import { morganStanleyStatementParser } from './morganStanleyStatement.ts';
import { sequoiaFundStatementParser } from './sequoiaFundStatement.ts';
import { tiaaActivityParser } from './tiaaActivity.ts';
import { tiaaStatementParser } from './tiaaStatement.ts';
import { vanguardActivityParser } from './vanguardActivity.ts';
import { vanguardStatementParser } from './vanguardStatement.ts';
import { wellsFargoActivityParser } from './wellsFargoActivity.ts';
import { wellsFargoStatementParser } from './wellsFargoStatement.ts';

export const IMPORT_PARSERS: AppImportParser[] = [
  chaseCreditCardParser,
  bofaActivityParser,
  wellsFargoActivityParser,
  merrillActivityParser,
  tiaaActivityParser,
  vanguardActivityParser,
  morganStanleyActivityParser,
  bofaStatementParser,
  wellsFargoStatementParser,
  morganStanleyStatementParser,
  fidelity401kParser,
  fidelityInvestmentReportParser,
  marcusStatementParser,
  merrillStatementParser,
  sequoiaFundStatementParser,
  tiaaStatementParser,
  vanguardStatementParser,
  ...easyMoneyCsvProfileParsers,
];

function originalImportFileName(fileName: string) {
  return fileName.replace(/^[0-9a-f]{64}-/, '');
}

export function resolveImportParser(file: { fileName: string; headers: string[]; sample: string }) {
  const matchFile = {
    ...file,
    fileName: originalImportFileName(file.fileName),
  };
  const hits = IMPORT_PARSERS.filter(parser => parser.matches(matchFile));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new Error(`Multiple import parsers match ${file.fileName}: ${hits.map(hit => hit.id).join(', ')}`);
  }
  return null;
}
