import { getDataFreshnessReport } from '../server/app/dataFreshness.ts';

const args = new Set(process.argv.slice(2));
const todayArg = process.argv.find(arg => arg.startsWith('--today='));
const today = todayArg?.slice('--today='.length);
const report = getDataFreshnessReport({ today });

if (args.has('--catch-up')) {
  console.log(JSON.stringify(report.catchUp, null, 2));
} else {
  console.log(JSON.stringify(report, null, 2));
}
