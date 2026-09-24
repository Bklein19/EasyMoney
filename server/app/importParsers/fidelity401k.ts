import { meta, default as parse } from './moneyParsers/fidelity-401k-html.ts';
import { createMoneyParserAdapter } from './moneyAdapter.ts';
import { fidelityRetailActivityRemoteAccountId } from './fidelityAccountIdentity.ts';

const parser = createMoneyParserAdapter({
  meta,
  name: 'Fidelity 401(k)',
  parseMoneyFile: parse,
});

/** The generated NetBenefits statement identifies its plan in this hidden field. */
export async function fidelity401kStatementIdentity(html: string): Promise<string | null> {
  const ids = new Set<string>();
  await new HTMLRewriter().on('input[name="sodPlan"]', { element(element) {
    const value = element.getAttribute('value')?.trim() ?? '';
    if (element.getAttribute('type')?.toLowerCase() !== 'hidden' || !/^\d{5}$/.test(value)) {
      throw new Error('Fidelity retirement statement has an invalid plan identity');
    }
    ids.add(value);
  } }).transform(new Response(html)).text();
  if (ids.size > 1) throw new Error('Fidelity retirement statement has conflicting plan identities');
  const id = [...ids][0];
  return id ? fidelityRetailActivityRemoteAccountId(id) : null;
}

export const fidelity401kParser = {
  ...parser,
  async parse(input: Parameters<typeof parser.parse>[0]) {
    const result = await parser.parse(input);
    // Read the retained original, just as the underlying balance parser does.
    // Older saved statements without metadata keep their existing account name.
    const remoteAccountId = await fidelity401kStatementIdentity(await Bun.file(input.filePath!).text());
    if (!remoteAccountId) return result;
    return {
      ...result,
      balances: result.balances.map(balance => ({ ...balance, remoteAccountId })),
    };
  },
};
