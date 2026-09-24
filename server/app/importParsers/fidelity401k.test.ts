import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fidelity401kParser, fidelity401kStatementIdentity } from './fidelity401k.ts';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

test('extracts the generated statement plan, independent of attribute order and quote style', async () => {
  expect(await fidelity401kStatementIdentity('<input type="hidden" id ="sodPlan" name="sodPlan" value="12345">'))
    .toBe('fidelity:retail-token:12345');
  expect(await fidelity401kStatementIdentity("<INPUT value='12345' name='sodPlan' type='hidden'>"))
    .toBe('fidelity:retail-token:12345');
});

test('does not infer identity from names, headings, scripts or unrelated fields', async () => {
  expect(await fidelity401kStatementIdentity(`<h2>Example employer (12345)</h2>
    <input name="planNumber" value="12345">
    <script>var plan = '12345'; var template = '<input type="hidden" name="sodPlan" value="12345">';</script>
    <!-- <input type="hidden" name="sodPlan" value="12345"> -->`)).toBeNull();
});

test('rejects invalid or conflicting statement plans', async () => {
  for (const value of ['', '1234', '123456', 'abcde']) {
    await expect(fidelity401kStatementIdentity(`<input type="hidden" name="sodPlan" value="${value}">`))
      .rejects.toThrow('invalid plan identity');
  }
  await expect(fidelity401kStatementIdentity('<input name="sodPlan" value="12345">')).rejects.toThrow('invalid');
  await expect(fidelity401kStatementIdentity(`<input type="hidden" name="sodPlan" value="12345">
    <input type="hidden" name="sodPlan" value="54321">`)).rejects.toThrow('conflicting');
});

test('adds identity to parsed balances while retaining legacy HTML behavior and contribution evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fidelity-statement-identity-'));
  temporaryDirectories.push(root);
  const fileName = 'fidelity-401k-example-2026-08.html';
  const filePath = join(root, fileName);
  const html = `<html><body>Statement Period: 08/01/2026 to 08/31/2026
    Ending Balance $12,500.00 Your Contributions $200.00 Employer Contributions $100.00</body></html>`;
  for (const identified of [false, true]) {
    await Bun.write(filePath, html + (identified ? '<input type="hidden" name="sodPlan" value="12345">' : ''));
    const parsed = await fidelity401kParser.parse({ fileName, filePath, text: '', rows: [], headers: [] });
    expect(parsed.transactions).toEqual([]);
    expect(parsed.balances).toHaveLength(1);
    expect(parsed.balances[0]).toMatchObject({
      account: 'Fidelity 401(k)', date: '2026-08-31', balanceCents: 1250000,
      raw: { statementCashFlow: { netContributionsCents: 30000 } },
    });
    expect(parsed.balances[0]?.remoteAccountId).toBe(identified ? 'fidelity:retail-token:12345' : undefined);
  }
});
