#!/usr/bin/env bun

import { resolve } from 'node:path';

import { runConnectorDevelopment } from '../server/app/dataSync/developmentRunner.ts';
import { isSyncInstitutionId } from '../server/app/dataSync/registry.ts';

interface Options {
  institutionId: string;
  sourcePlanPath: string;
  overlapDays: number;
  root?: string;
  profileName?: string;
  runId?: string;
  today?: string;
}

function usage(): never {
  console.log([
    'Usage: bun scripts/develop-connector.ts --institution ID --source-plan PATH',
    '       [--goal current] [--overlap-days DAYS] [--root PATH]',
    '       [--profile NAME] [--run-id ID] [--today YYYY-MM-DD]',
  ].join('\n'));
  process.exit(0);
}

function parseArguments(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--help' || argument === '-h') usage();
    const value = argv[index + 1];
    if (!argument.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error('Connector development arguments are incomplete');
    }
    values.set(argument, value);
    index += 1;
  }
  const institutionId = values.get('--institution');
  const sourcePlanPath = values.get('--source-plan');
  if (!institutionId || !sourcePlanPath) {
    throw new Error('Connector development requires --institution and --source-plan');
  }
  if ((values.get('--goal') ?? 'current') !== 'current') {
    throw new Error('Connector development currently supports only the current goal');
  }
  const overlapDays = Number(values.get('--overlap-days') ?? '7');
  if (!Number.isInteger(overlapDays) || overlapDays < 0 || overlapDays > 365) {
    throw new Error('Connector development overlap days must be an integer from 0 through 365');
  }
  return {
    institutionId,
    sourcePlanPath: resolve(sourcePlanPath),
    overlapDays,
    ...(values.has('--root') ? { root: resolve(values.get('--root')!) } : {}),
    ...(values.has('--profile') ? { profileName: values.get('--profile')! } : {}),
    ...(values.has('--run-id') ? { runId: values.get('--run-id')! } : {}),
    ...(values.has('--today') ? { today: values.get('--today')! } : {}),
  };
}

async function main(): Promise<void> {
  const options = parseArguments(Bun.argv.slice(2));
  if (!isSyncInstitutionId(options.institutionId)) {
    throw new Error('Connector development names an unsupported institution');
  }
  const result = await runConnectorDevelopment({
    institutionId: options.institutionId,
    sourcePlanPath: options.sourcePlanPath,
    goal: { kind: 'current', overlapDays: options.overlapDays },
    ...(options.root ? { root: options.root } : {}),
    ...(options.profileName ? { profileName: options.profileName } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.today ? { today: options.today } : {}),
  }, {
    onRunCreated(run) {
      console.log(JSON.stringify({
        type: 'connector-development-run',
        status: 'started',
        institutionId: run.institutionId,
        runId: run.runId,
        resultPath: run.resultPath,
      }));
    },
  });
  console.log(JSON.stringify({
    type: 'connector-development-run',
    status: result.status,
    institutionId: result.institutionId,
    runId: result.runId,
    eventCount: result.eventCount,
    parserValidationCount: result.parserValidationCount,
    artifactCount: result.artifactCount,
    artifactTypes: result.artifactTypes,
    ...(result.failure ? { failure: result.failure } : {}),
  }));
  if (result.status !== 'complete') process.exitCode = 1;
}

main().catch(() => {
  console.error(JSON.stringify({
    type: 'connector-development-run',
    status: 'failed-to-start',
    failure: {
      code: 'runner-configuration-failed',
      summary: 'Connector development runner could not start',
    },
  }));
  process.exitCode = 1;
});
