import { mkdir } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const SESSION = 'sequoia-fund-catchup';
const LOGIN_URL = 'https://secureaccountview.com/BFWeb/clients/sequoiafund/index';
const OUTPUT_DIR = '/private/tmp/easymoney-sequoia-fund-catchup';
const PLAYWRIGHT_CLI = [
  'npx',
  '--yes',
  '-p',
  '@playwright/cli@latest',
  'playwright-cli',
];

type Artifact = {
  key: 'activity' | 'statement-2026-03-31' | 'statement-2026-06-30';
  kind: 'csv' | 'pdf';
  path: string;
};

const artifacts: Artifact[] = [
  {
    key: 'activity',
    kind: 'csv',
    path: `${OUTPUT_DIR}/sequoia-fund-activity-2025-08-13-to-2026-08-13.csv`,
  },
  {
    key: 'statement-2026-03-31',
    kind: 'pdf',
    path: `${OUTPUT_DIR}/sequoia-fund-2026-03-31.pdf`,
  },
  {
    key: 'statement-2026-06-30',
    kind: 'pdf',
    path: `${OUTPUT_DIR}/sequoia-fund-2026-06-30.pdf`,
  },
];

type CliResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

type BrowserResult = {
  status: 'complete' | 'authentication-required';
  downloaded?: Array<{ key: Artifact['key']; bytes: number }>;
};

async function runCli(args: string[]): Promise<CliResult> {
  const subprocess = Bun.spawn([...PLAYWRIGHT_CLI, ...args], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { exitCode, stderr, stdout };
}

function safeCliError(result: CliResult): string {
  const output = `${result.stdout}\n${result.stderr}`;
  const safeMessages = [
    'Expected exactly one Sequoia investment account',
    'History filter not found',
    'Transaction filter not found',
    'Activity CSV form not found',
    'Activity response failed CSV validation',
    'Required statement date is not available',
    'Statement response failed PDF validation',
  ];
  return safeMessages.find((message) => output.includes(message)) ??
    `playwright-cli exited with code ${result.exitCode}`;
}

async function isValidArtifact(artifact: Artifact): Promise<boolean> {
  if (extname(artifact.path) !== `.${artifact.kind}`) return false;

  const file = Bun.file(artifact.path);
  if (!(await file.exists()) || file.size < 32) return false;

  const signature = new Uint8Array(
    await file.slice(0, Math.min(file.size, 512)).arrayBuffer(),
  );
  if (artifact.kind === 'pdf') {
    return new TextDecoder().decode(signature.slice(0, 5)) === '%PDF-';
  }

  const prefix = new TextDecoder().decode(signature).trimStart().toLowerCase();
  return !signature.includes(0) && !prefix.startsWith('<') && !prefix.startsWith('%pdf-');
}

function buildBrowserProgram(requested: Artifact[]): string {
  const config = {
    loginUrl: LOGIN_URL,
    activity: requested.find((artifact) => artifact.key === 'activity') ?? null,
    statements: requested
      .filter((artifact) => artifact.kind === 'pdf')
      .map((artifact) => ({
        key: artifact.key,
        date: artifact.key.replace('statement-', '').split('-').slice(1).join('/') +
          '/' + artifact.key.replace('statement-', '').split('-')[0],
        filename: basename(artifact.path),
        path: artifact.path,
      })),
  };

  // playwright-cli invokes this function with its existing authenticated Page.
  return `async page => {
    const config = ${JSON.stringify(config)};
    const isLoginPage = async () => page.locator('input[type="password"]').count().then(count => count > 0);
    const saveBase64 = async (base64, mimeType, filename, path) => {
      const downloadPromise = page.waitForEvent('download');
      await page.evaluate(({ base64, mimeType, filename }) => {
        const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, { base64, mimeType, filename });
      const download = await downloadPromise;
      await download.saveAs(path);
    };

    const onAccountSite = await page.evaluate(() => location.hostname === 'secureaccountview.com');
    if (!onAccountSite) await page.goto(config.loginUrl);
    await page.waitForLoadState('domcontentloaded');
    if (await isLoginPage()) return JSON.stringify({ status: 'authentication-required' });

    const origin = await page.evaluate(() => location.origin);
    const downloaded = [];

    if (config.activity) {
      await page.goto(origin + '/BFWeb/clients/sequoiafund/transactionhistory');
      await page.waitForLoadState('domcontentloaded');
      if (await isLoginPage()) return JSON.stringify({ status: 'authentication-required' });

      await page.waitForFunction(() => {
        const select = document.querySelector('select#fundAccount');
        return select instanceof HTMLSelectElement && select.options.length >= 2;
      });
      const accountOptionCount = await page.evaluate(() =>
        document.querySelector('select#fundAccount')?.querySelectorAll('option').length ?? 0,
      );
      if (accountOptionCount !== 2) {
        throw new Error('Expected exactly one Sequoia investment account');
      }
      await page.evaluate(() => {
        const setSelection = (selector, index) => {
          const select = document.querySelector(selector);
          if (!(select instanceof HTMLSelectElement)) throw new Error('History filter not found');
          select.selectedIndex = index;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setSelection('select#fundAccount', 1);
        setSelection('select#duration', 2);
        const transactionTypes = document.querySelector('select#transActionType');
        if (!(transactionTypes instanceof HTMLSelectElement)) throw new Error('Transaction filter not found');
        setSelection('select#transActionType', transactionTypes.options.length - 1);
      });

      const result = await page.evaluate(async () => {
        const form = [...document.querySelectorAll('form')]
          .find(candidate => new URL(candidate.action).pathname.endsWith('/transactionHistoryCSV'));
        if (!form) throw new Error('Activity CSV form not found');

        const response = await fetch(form.action, {
          method: 'POST',
          body: new FormData(form),
          credentials: 'include',
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const signature = String.fromCharCode(...bytes.slice(0, 64)).trimStart().toLowerCase();
        if (!response.ok || bytes.length < 32 || signature.startsWith('<') || signature.startsWith('%pdf-')) {
          throw new Error('Activity response failed CSV validation');
        }

        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return { base64: btoa(binary), bytes: bytes.length };
      });

      await saveBase64(
        result.base64,
        'text/csv',
        config.activity.path.split('/').pop(),
        config.activity.path,
      );
      downloaded.push({ key: config.activity.key, bytes: result.bytes });
    }

    if (config.statements.length) {
      await page.goto(origin + '/BFWeb/clients/sequoiafund/viewStatements');
      await page.waitForLoadState('domcontentloaded');
      if (await isLoginPage()) return JSON.stringify({ status: 'authentication-required' });

      for (const statement of config.statements) {
        await page.waitForFunction((date) =>
          [...document.querySelectorAll('li.noBulletLi')]
            .some(item => (item.innerText || '').includes(date)),
        statement.date);
        const item = page.locator('li.noBulletLi')
          .filter({ hasText: statement.date })
          .locator('a.statementLink')
          .first();
        if (await item.count() !== 1) {
          throw new Error('Required statement date is not available');
        }

        const popupPromise = page.waitForEvent('popup');
        await item.click();
        const popup = await popupPromise;
        await popup.waitForLoadState('domcontentloaded').catch(() => {});

        try {
          const response = await page.context().request.get(popup.url());
          const body = await response.body();
          const contentType = response.headers()['content-type'] || '';
          const valid = response.ok() &&
            contentType.toLowerCase().startsWith('application/pdf') &&
            body.length >= 32 &&
            body.subarray(0, 5).toString() === '%PDF-';
          if (!valid) throw new Error('Statement response failed PDF validation');

          await saveBase64(body.toString('base64'), 'application/pdf', statement.filename, statement.path);
          downloaded.push({ key: statement.key, bytes: body.length });
        } finally {
          await popup.close().catch(() => {});
        }
      }
    }

    return JSON.stringify({ status: 'complete', downloaded });
  }`;
}

function parseBrowserResult(stdout: string): BrowserResult {
  const first = JSON.parse(stdout.trim());
  return JSON.parse(typeof first === 'string' ? first : JSON.stringify(first));
}

async function main(): Promise<void> {
  const unknownArgs = process.argv.slice(2).filter((argument) => argument !== '--force');
  if (unknownArgs.length) throw new Error(`Unknown argument: ${unknownArgs[0]}`);

  await mkdir(OUTPUT_DIR, { recursive: true });
  const force = process.argv.includes('--force');
  const requested: Artifact[] = [];

  for (const artifact of artifacts) {
    if (!force && await isValidArtifact(artifact)) {
      console.log(`skip valid ${basename(artifact.path)}`);
    } else {
      requested.push(artifact);
    }
  }

  if (requested.length) {
    const sessions = await runCli(['list']);
    if (sessions.exitCode !== 0) throw new Error('Unable to list Playwright sessions');

    if (!sessions.stdout.includes(SESSION)) {
      const opened = await runCli([
        `-s=${SESSION}`,
        'open',
        LOGIN_URL,
        '--persistent',
        '--headed',
      ]);
      if (opened.exitCode !== 0) throw new Error('Unable to open the Sequoia login session');
    }

    const browserRun = await runCli([
      `-s=${SESSION}`,
      '--raw',
      'run-code',
      buildBrowserProgram(requested),
    ]);
    if (browserRun.exitCode !== 0) {
      throw new Error(`Sequoia browser workflow failed: ${safeCliError(browserRun)}`);
    }

    const result = parseBrowserResult(browserRun.stdout);
    if (result.status === 'authentication-required') {
      console.log(`Authentication required in headed session ${SESSION}.`);
      console.log('Complete login, MFA, or CAPTCHA there, then rerun this command.');
      process.exitCode = 2;
      return;
    }

    for (const artifact of result.downloaded ?? []) {
      console.log(`downloaded ${artifact.key} (${artifact.bytes} bytes)`);
    }
  }

  for (const artifact of artifacts) {
    if (!(await isValidArtifact(artifact))) {
      throw new Error(`Artifact validation failed: ${basename(artifact.path)}`);
    }
    console.log(`validated ${basename(artifact.path)} (${Bun.file(artifact.path).size} bytes)`);
  }
}

await main();
