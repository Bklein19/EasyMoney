import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConnectorDevelopmentRun } from './developmentRun.ts';

test('connector development runs isolate artifacts while reusing stable auth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'easymoney-connector-run-test-'));
  try {
    const first = await createConnectorDevelopmentRun({
      institutionId: 'wells-fargo',
      profileName: 'wells-fargo-catchup',
      runId: 'agent-one',
      root,
    });
    const second = await createConnectorDevelopmentRun({
      institutionId: 'wells-fargo',
      profileName: 'wells-fargo-catchup',
      runId: 'agent-two',
      root,
    });

    expect(first.outputDir).not.toBe(second.outputDir);
    expect(first.profilePath).toBe(second.profilePath);
    expect(await stat(first.outputDir).then(value => value.isDirectory())).toBe(true);
    expect(first.outputDir.startsWith(root)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('connector development runs reject path-shaped identifiers', async () => {
  await expect(createConnectorDevelopmentRun({
    institutionId: '../bank',
    profileName: 'bank-catchup',
  })).rejects.toThrow('Institution id must be a kebab-case identifier');
});
