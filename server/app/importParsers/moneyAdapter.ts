import type { AppImportParseInput, AppImportParseResult, AppImportParser } from '../importTypes.ts';
import type { ParseResult, ParserMeta } from '../../../money/src/types.ts';

type MoneyParse = (filePath: string) => Promise<ParseResult>;

interface MoneyParserAdapterOptions {
  meta: ParserMeta;
  name: string;
  parseMoneyFile: MoneyParse;
}

export function createMoneyParserAdapter({
  meta,
  name,
  parseMoneyFile,
}: MoneyParserAdapterOptions): AppImportParser {
  return {
    id: meta.id,
    name,
    institution: meta.institution,
    sourceType: meta.kind,
    priority: meta.priority,
    matches: ({ fileName, sample }) => meta.matches({ filename: fileName, sample }),
    async parse(input: AppImportParseInput): Promise<AppImportParseResult> {
      if (!input.filePath) {
        throw new Error(`${name} requires a file path`);
      }

      const result = await parseMoneyFile(input.filePath);
      return {
        transactions: result.transactions.map((transaction, index) => ({
          sourceRowIndex: index,
          date: transaction.date,
          amountCents: transaction.amount_cents,
          description: transaction.description,
          institution: transaction.institution,
          account: transaction.account,
          sourceRole: transaction.category === 'in-kind-transfer' ? 'statement-only' : 'activity',
          raw: {
            moneyId: transaction.id,
            moneyCategory: transaction.category,
            ...(transaction.raw || {}),
          },
        })),
        balances: result.balances.map((balance, index) => ({
          sourceRowIndex: index,
          date: balance.date,
          balanceCents: balance.balance_cents,
          institution: balance.institution,
          account: balance.account,
          raw: {},
        })),
      };
    },
  };
}
