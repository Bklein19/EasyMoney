import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { playwrightProfilePath } from './browserSession.ts';

const SAFE_LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ConnectorDevelopmentRun {
  institutionId: string;
  runId: string;
  outputDir: string;
  profileName: string;
  profilePath: string;
}

export interface ConnectorDevelopmentRunOptions {
  institutionId: string;
  profileName: string;
  runId?: string;
  root?: string;
  now?: Date;
  processId?: number;
}

function safeLabel(value: string, label: string): string {
  if (!SAFE_LABEL.test(value)) throw new Error(`${label} must be a kebab-case identifier`);
  return value;
}

export async function createConnectorDevelopmentRun(
  options: ConnectorDevelopmentRunOptions,
): Promise<ConnectorDevelopmentRun> {
  const institutionId = safeLabel(options.institutionId, 'Institution id');
  const profileName = safeLabel(options.profileName, 'Profile name');
  const now = options.now ?? new Date();
  const generatedRunId = [
    institutionId,
    now.toISOString().replace(/\D/g, '').slice(0, 14),
    String(options.processId ?? process.pid),
  ].join('-');
  const runId = safeLabel(options.runId ?? generatedRunId, 'Run id');
  const root = resolve(options.root ?? process.env.EASYMONEY_CONNECTOR_DEV_ROOT ?? join(tmpdir(), 'easymoney-connector-dev'));
  const outputDir = resolve(root, institutionId, runId, 'artifacts');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });

  return {
    institutionId,
    runId,
    outputDir,
    profileName,
    profilePath: playwrightProfilePath(profileName),
  };
}
