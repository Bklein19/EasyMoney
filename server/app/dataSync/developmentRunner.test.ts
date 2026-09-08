import { expect, test } from 'bun:test';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SyncArtifactManifest, SyncExecutionPlan } from './types.ts';
import { SYNC_WORKER_PROTOCOL_VERSION } from './types.ts';
import {
  runConnectorDevelopment,
  type ConnectorDevelopmentResult,
} from './developmentRunner.ts';
import { serializeSyncExecutionPlan } from './workerProtocol.ts';

function sourcePlan(outputDir: string): SyncExecutionPlan {
  return {
    protocolVersion: SYNC_WORKER_PROTOCOL_VERSION,
    runId: 'private-source-run',
    institutionId: 'wells-fargo',
    today: '2026-09-07',
    accounts: [{
      id: 71,
      name: 'Private Checking Name',
      institution: 'Wells Fargo',
      type: 'checking',
      last4: '9876',
      latestFactDate: '2026-08-01',
      earliestFactDate: '2020-01-01',
      latestBalanceDate: '2026-07-31',
      earliestBalanceDate: '2020-01-31',
      balanceDates: ['2026-07-31'],
      sourceAccountName: 'Private Checking 9876',
      sourceAccountNames: ['Private Checking 9876'],
      accountAliases: ['Secret Alias'],
      accountHolder: 'Private Person',
      artifactFileNames: ['private-person-checking-9876.pdf'],
    }],
    goal: { kind: 'current', overlapDays: 7 },
    outputDir,
  };
}

test('development runner reuses a private plan without persisting identifiers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'easymoney-connector-development-'));
  const sourcePath = join(root, 'private-source-plan.json');
  await writeFile(sourcePath, serializeSyncExecutionPlan(sourcePlan(join(root, 'private-artifacts'))), { mode: 0o600 });
  const result = await runConnectorDevelopment({
    institutionId: 'wells-fargo',
    sourcePlanPath: sourcePath,
    goal: { kind: 'current', overlapDays: 7 },
    root,
    runId: 'safe-run',
    today: '2026-09-07',
  }, {
    clock: () => new Date('2026-09-07T12:00:00.000Z'),
    runExecutionPlan: async (plan, report) => {
      expect(plan.accounts).toEqual(sourcePlan(join(root, 'private-artifacts')).accounts);
      report({
        type: 'phase',
        message: 'Discovering Private Person account 9876',
        data: {
          step: 'account-discovery',
          status: 'completed',
          accountCount: 1,
          accountId: 71,
          last4: '9876',
          url: 'https://private.example.test/account/9876',
        },
      });
      report({
        type: 'phase',
        message: 'Validated private-person-checking-9876.pdf',
        data: {
          step: 'statement-validation',
          status: 'completed',
          artifactKind: 'statement',
          parserValidated: true,
          transactionCount: 3,
          balanceCount: 1,
        },
      });
      return {
        protocolVersion: SYNC_WORKER_PROTOCOL_VERSION,
        runId: plan.runId,
        institutionId: plan.institutionId,
        artifacts: [{
          fileName: 'wells-fargo-checking-9876-2026-08-31.pdf',
          accountId: 71,
          sizeBytes: 4_096,
          sha256: 'a'.repeat(64),
        }],
      } satisfies SyncArtifactManifest;
    },
  });

  expect(result.status).toBe('complete');
  expect(result.artifactCount).toBe(1);
  expect(result.artifactTypes).toEqual({ pdf: 1 });
  expect(result.parserValidationCount).toBe(1);
  const resultPath = join(root, 'wells-fargo', 'safe-run', 'result.json');
  const persisted = await readFile(resultPath, 'utf8');
  expect(persisted).not.toContain('Private Person');
  expect(persisted).not.toContain('9876');
  expect(persisted).not.toContain('private-person-checking');
  expect(persisted).not.toContain('https://');
  expect(persisted).not.toContain('aaaaaaaa');
  if (process.platform !== 'win32') {
    expect((await stat(resultPath)).mode & 0o777).toBe(0o600);
  }
});

test('development runner persists a safe failure code at the active production stage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'easymoney-connector-development-failure-'));
  const sourcePath = join(root, 'source-plan.json');
  await writeFile(sourcePath, serializeSyncExecutionPlan(sourcePlan(join(root, 'private-artifacts'))), { mode: 0o600 });
  let written: ConnectorDevelopmentResult | undefined;
  const result = await runConnectorDevelopment({
    institutionId: 'wells-fargo',
    sourcePlanPath: sourcePath,
    goal: { kind: 'current', overlapDays: 7 },
    root,
    runId: 'failed-run',
    today: '2026-09-07',
  }, {
    clock: () => new Date('2026-09-07T12:00:00.000Z'),
    writeResult: async (_path, value) => { written = structuredClone(value); },
    runExecutionPlan: async (_plan, report) => {
      report({
        type: 'action',
        message: 'Downloading account 9876 for Private Person',
        data: { step: 'activity-download', status: 'started', accountId: 71, last4: '9876' },
      });
      throw new Error('request timed out for Private Person account 9876 at https://private.example.test');
    },
  });

  expect(result.status).toBe('failed');
  expect(result.failure).toEqual({
    code: 'request-timeout',
    summary: 'An authenticated request timed out',
    stage: 'activity-download',
  });
  const persisted = JSON.stringify(written);
  expect(persisted).not.toContain('Private Person');
  expect(persisted).not.toContain('9876');
  expect(persisted).not.toContain('https://');
});

test('development runner rejects a source plan for another connector before creating output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'easymoney-connector-development-mismatch-'));
  const sourcePath = join(root, 'source-plan.json');
  const plan = sourcePlan(join(root, 'private-artifacts'));
  plan.institutionId = 'fidelity';
  await writeFile(sourcePath, serializeSyncExecutionPlan(plan), { mode: 0o600 });

  await expect(runConnectorDevelopment({
    institutionId: 'wells-fargo',
    sourcePlanPath: sourcePath,
    goal: { kind: 'current', overlapDays: 7 },
    root,
    runId: 'mismatch-run',
  })).rejects.toThrow('institution does not match');
  await expect(stat(join(root, 'wells-fargo'))).rejects.toThrow();
});
