import { StatementValidationError, validateStatementTotals } from './statementValidation';

// Extraction recipes are institution-specific. Never substitute parsed row sums
// for missing printed totals: that would make the check tautological.
const money = '((?:\\$\\(|\\(?-?\\s*\\$?)[\\d,]+\\.\\d{2}\\)?|[—-](?![\\d.]))';
function read(text: string, label: string) {
  const match = text.match(new RegExp(label + '\\s+' + money, 'i'));
  if (!match) throw new StatementValidationError('invalid-evidence');
  if (/^[—-]$/.test(match[1]!.trim())) return 0;
  const magnitude = Math.round(Number(match[1]!.replace(/[^\d.]/g, '')) * 100);
  return /[-(]/.test(match[1]!) ? -magnitude : magnitude;
}
export function checkCashStatement(kind: 'marcus' | 'bofa-deposit' | 'bofa-card' | 'wells-deposit', text: string, amounts: number[]) {
  let opening: number, closing: number, credits: number, debits: number;
  if (kind === 'marcus') {
    if (!/Deposits and Other Credits/i.test(text)) return { status: 'unavailable', reason: 'summary-not-found' };
    opening = read(text, 'Beginning Balance'); closing = read(text, 'Ending Balance');
    // Interest is already included in printed Deposits and Other Credits.
    credits = read(text, 'Deposits and Other Credits'); debits = read(text, 'Withdrawals and Other Debits');
  } else if (kind === 'bofa-deposit') {
    if (!/Account summary/i.test(text)) return { status: 'unavailable', reason: 'summary-not-found' };
    const summary = text.slice(text.search(/Account summary/i)).split(/Account number|Annual Percentage Yield|Please see/i)[0]!;
    opening = read(summary, 'Beginning balance on [A-Za-z]+ \\d{1,2}, \\d{4}'); closing = read(summary, 'Ending balance on [A-Za-z]+ \\d{1,2}, \\d{4}');
    credits = read(summary, 'Deposits and other additions');
    debits = Math.abs(read(summary, '(?:Withdrawals and other subtractions|Other subtractions)')) + Math.abs(read(summary, 'Service fees'));
    if (/^\s*Checks\s+[-$\d]/m.test(summary)) debits += Math.abs(read(summary, 'Checks'));
  } else if (kind === 'bofa-card') {
    if (!/Previous Balance/i.test(text)) return { status: 'unavailable', reason: 'summary-not-found' };
    opening = -read(text, 'Previous Balance'); closing = -read(text, 'New Balance Total');
    credits = Math.abs(read(text, 'Payments and Other Credits'));
    debits = Math.abs(read(text, 'Purchases and Adjustments')) + Math.abs(read(text, 'Fees Charged')) + Math.abs(read(text, 'Interest Charged'));
  } else {
    if (!/Deposits\/Additions/i.test(text)) return { status: 'unavailable', reason: 'summary-not-found' };
    opening = read(text, 'Beginning balance on \\d{1,2}/\\d{1,2}'); closing = read(text, 'Ending balance on \\d{1,2}/\\d{1,2}');
    credits = read(text, 'Deposits/Additions'); debits = Math.abs(read(text, 'Withdrawals/Subtractions'));
  }
  return validateStatementTotals({ openingBalanceCents: opening, closingBalanceCents: closing, creditsCents: credits, debitsCents: debits }, amounts);
}

export function checkTiaaRollForward(text: string, closingBalanceCents: number) {
  if (!/Beginning balance/i.test(text)) return { status: 'unavailable', reason: 'roll-forward-not-found' };
  const summary = text.slice(text.search(/Beginning balance/i)).split(/Personal rate of return/i)[0]!;
  const opening = read(summary, 'Beginning balance');
  const closing = read(summary, 'Ending balance');
  // Zero activity categories are omitted in this table. Restrict detection to
  // this table, never borrow a similarly named row from later plan details.
  const movements = ['Your contributions', 'Employer contributions', 'Other Credits', 'Distributions/Other Debits', 'Fees', 'Gains/Loss'].map(label => new RegExp(label, 'i').test(summary) ? read(summary, label) : 0);
  if (opening + movements.reduce((a, b) => a + b, 0) !== closing || closing !== closingBalanceCents) throw new StatementValidationError('statement-arithmetic');
  return { status: 'passed', checks: ['investment-roll-forward', 'closing-balance'], transactionCompleteness: 'unavailable', openingBalanceCents: opening, closingBalanceCents: closing };
}

export function checkInvestmentRollForward(kind: 'merrill' | 'morgan-stanley' | 'netbenefits', text: string, closingBalanceCents: number) {
  let opening: number, closing: number, movements: number[];
  if (kind === 'merrill') {
    if (!/Opening Value \(/.test(text)) return { status: 'unavailable', reason: 'roll-forward-not-found' };
    opening = read(text, 'Opening Value \\(\\d{2}/\\d{2}\\)');
    closing = read(text, 'Closing Value \\(\\d{2}/\\d{2}\\)');
    movements = [read(text, 'Total Credits'), -Math.abs(read(text, 'Total Debits')), read(text, 'Securities You Transferred In/Out'), read(text, 'Market Gains/\\(Losses\\)')];
  } else if (kind === 'morgan-stanley') {
    if (!/TOTAL BEGINNING VALUE/.test(text)) return { status: 'unavailable', reason: 'roll-forward-not-found' };
    opening = read(text, 'TOTAL BEGINNING VALUE'); closing = read(text, 'TOTAL ENDING VALUE');
    movements = [read(text, 'Net Credits/Debits/Transfers'), read(text, 'Change in Value')];
  } else {
    if (!/Beginning Balance/.test(text)) return { status: 'unavailable', reason: 'roll-forward-not-found' };
    // This recipe is deliberately limited to the explicit three-line summary.
    // Additional movement categories need a format-specific implementation.
    if (/Withdrawals|Distributions|Fees|Other Credits|Transfer/i.test(text)) return { status: 'unavailable', reason: 'additional-movement-categories' };
    opening = read(text, 'Beginning Balance'); closing = read(text, 'Ending Balance');
    movements = [read(text, 'Your Contributions'), read(text, 'Employer Contributions'), read(text, 'Change in Market Value')];
  }
  if (opening + movements.reduce((a, b) => a + b, 0) !== closing || closing !== closingBalanceCents) throw new StatementValidationError('statement-arithmetic');
  return { status: 'passed', checks: ['investment-roll-forward', 'closing-balance'], transactionCompleteness: 'unavailable', openingBalanceCents: opening, closingBalanceCents: closing };
}

export function checkFidelityPortfolioSections(text: string, rows: Array<{ amount_cents: number; raw: Record<string, unknown> }>) {
  const checked: string[] = [];
  // Securities-transfer totals are cash columns, not the market value of the
  // transferred holdings; comparing them would be a false validation failure.
  for (const [label, type] of [['Contributions', 'contribution'], ['Distributions', 'distribution']] as const) {
    if (!new RegExp('Total ' + label, 'i').test(text)) continue;
    const expected = Math.abs(read(text, 'Total ' + label));
    const actual = rows.filter(row => row.raw.type === type).reduce((sum, row) => sum + Math.abs(row.amount_cents), 0);
    if (expected !== actual) throw new StatementValidationError(type === 'contribution' ? 'parsed-credits' : 'parsed-debits');
    checked.push(label);
  }
  return checked.length ? { status: 'passed', checks: ['printed-section-totals'], sections: checked, transactionCompleteness: 'unavailable' }
    : { status: 'unavailable', reason: 'section-totals-not-found' };
}
