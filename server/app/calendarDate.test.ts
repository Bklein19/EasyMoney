import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('local financial calendar date', () => {
  test('keeps institution defaults on the local calendar day', () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'easymoney-calendar-date-'));
    try {
      const result = Bun.spawnSync({
        cmd: [process.execPath, '--eval', `
          const { localCalendarDate } = await import('./server/app/calendarDate.ts');
          const { createSyncExecutionPlan } = await import('./server/app/dataSync/executionPlan.ts');
          const { parseBankOfAmericaArgs } = await import('./server/app/dataSync/institutions/bankOfAmerica.ts');
          const localEvening = new Date('2026-08-28T02:30:00.000Z');
          const plan = createSyncExecutionPlan({
            runId: 'sync-local-date-test',
            institutionId: 'fidelity',
            goal: { kind: 'current', overlapDays: 7 },
          }, {
            now: localEvening,
            accounts: [],
            outputDir: '/runtime/sync/artifacts',
          });
          const bankOfAmerica = parseBankOfAmericaArgs([], localEvening);
          console.log(JSON.stringify({
            utcDate: localEvening.toISOString().slice(0, 10),
            localDate: localCalendarDate(localEvening),
            planDate: plan.today,
            bankOfAmerica,
          }));
        `],
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          TZ: 'America/Los_Angeles',
          EASYMONEY_DB_PATH: path.join(testDirectory, 'easymoney.sqlite'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(new TextDecoder().decode(result.stderr)).toBe('');
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(new TextDecoder().decode(result.stdout)) as {
        utcDate: string;
        localDate: string;
        planDate: string;
        bankOfAmerica: {
          outputDir: string;
          through: string;
          checkingFrom: string;
          savingsFrom: string;
          cardFrom: string;
        };
      };
      expect(output.utcDate).toBe('2026-08-28');
      expect(output.localDate).toBe('2026-08-27');
      expect(output.planDate).toBe('2026-08-27');
      expect(output.bankOfAmerica.outputDir.endsWith('/Downloads/easymoney-imports/2026-08-27')).toBe(true);
      expect(output.bankOfAmerica).toMatchObject({
        through: '2026-08-27',
        checkingFrom: '2026-08-27',
        savingsFrom: '2026-08-27',
        cardFrom: '2026-08-27',
      });
    } finally {
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  });

});
