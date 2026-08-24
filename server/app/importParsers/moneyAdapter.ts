import type { AppImportParseInput, AppImportParseResult, AppImportParser } from '../importTypes.ts';
import type { ParseResult, ParserMeta } from './moneyParsers/types.ts';

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
  const toAppSourceRole = (transaction: ParseResult['transactions'][number]) => {
    if (transaction.category === 'in-kind-transfer') return 'statement-only';
    if (transaction.category === 'statement-summary') return 'statement-summary';
    return 'activity';
  };

  const toAppAmountCents = (transaction: ParseResult['transactions'][number]) => {
    if (transaction.raw?.type === 'credit-card-activity') {
      return -transaction.amount_cents;
    }
    return transaction.amount_cents;
  };

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
        coveredFrom: result.covered_from ?? null,
        coveredTo: result.covered_to ?? null,
        transactions: result.transactions.map((transaction, index) => ({
          sourceRowIndex: index,
          date: transaction.date,
          amountCents: toAppAmountCents(transaction),
          description: transaction.description,
          institution: transaction.institution,
          account: transaction.account,
          ...(transaction.account_holder ? { accountHolder: transaction.account_holder } : {}),
          sourceRole: toAppSourceRole(transaction),
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
          ...(balance.account_holder ? { accountHolder: balance.account_holder } : {}),
          raw: {},
        })),
      };
    },
  };
}
