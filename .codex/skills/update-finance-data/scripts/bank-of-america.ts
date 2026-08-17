#!/usr/bin/env bun

import {
  parseBankOfAmericaArgs,
  runBankOfAmericaSync,
} from '../../../../server/app/dataSync/institutions/bankOfAmerica.ts';

const result = await runBankOfAmericaSync(parseBankOfAmericaArgs(Bun.argv.slice(2)));
console.log(JSON.stringify(result, null, 2));
