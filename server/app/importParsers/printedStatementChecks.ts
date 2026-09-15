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
    // Bound the actual summary: navigation and later investment tables are not
    // movement rows. Zero categories are omitted by NetBenefits.
    const summary = text.match(new RegExp('Beginning Balance\\s+' + money + '([\\s\\S]*?)Ending Balance\\s+' + money));
    if (!summary) throw new StatementValidationError('invalid-evidence');
    opening = read(summary[0], 'Beginning Balance'); closing = read(summary[0], 'Ending Balance');
    let remaining = summary[2]!;
    movements = [];
    for (const label of ['Your Contributions', 'Employer Contributions', 'Change in Market Value', 'Fees']) {
      const row = new RegExp(label + '\\s+' + money, 'i');
      if (row.test(remaining)) { movements.push(read(remaining, label)); remaining = remaining.replace(row, ''); }
    }
    if (remaining.trim()) return { status: 'unavailable', reason: 'additional-movement-categories' };
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

export function checkFidelityAccountRollForward(text: string, closingBalanceCents: number) {
  const summary = text.match(/Beginning Account Value[\s\S]*?Ending Account Value[^\n]*/)?.[0];
  if (!summary) return { status: 'unavailable', reason: 'roll-forward-not-found' };
  const date = '(?: as of [A-Za-z]+ \\d{1,2}, \\d{4})?\\s*\\**';
  const opening = read(summary, 'Beginning Account Value' + date);
  const closing = read(summary, 'Ending Account Value' + date);
  // Costs are a breakdown of Subtractions, not an additional subtraction.
  const movements = ['Additions', 'Subtractions', 'Change in Investment Value \\*?'].map(label =>
    new RegExp(label).test(summary) ? read(summary, label) : 0);
  if (opening + movements.reduce((a,b) => a+b,0) !== closing || closing !== closingBalanceCents) throw new StatementValidationError('statement-arithmetic');
  return { status: 'passed', checks: ['investment-roll-forward', 'closing-balance'], transactionCompleteness: 'unavailable', openingBalanceCents: opening, closingBalanceCents: closing };
}

export function checkSequoiaShares(text: string, closingBalanceCents: number, purchaseCount: number) {
  const section = text.match(/Beginning Balance as of[\s\S]*?Ending Balance as of[^\n]*/)?.[0];
  if (!section) return { status: 'unavailable', reason: 'share-summary-not-found' };
  const anchor = /(?:Beginning|Ending) Balance as of \d{2}\/\d{2}\/\d{2}\s+\$([\d,]+\.\d{2})\s+\$[\d,]+\.\d{2}\s+([\d,]+\.\d{3})/g;
  const anchors = [...section.matchAll(anchor)];
  if (anchors.length !== 2) throw new StatementValidationError('invalid-evidence');
  const shares = (value: string) => Math.round(Number(value.replace(/,/g,''))*1000);
  let running = shares(anchors[0]![2]!);
  let purchases = 0, rows = 0;
  for (const line of section.split('\n').filter(line => /^\s*\d{2}\/\d{2}\/\d{2}\s/.test(line))) {
    const row = line.match(/^\s*\d{2}\/\d{2}\/\d{2}\s+(Shares Purchased[^\d]*|Fund Purchase[^\d]*\d*|(?:Income Reinvest|Cap Gain Rein|ST CG Rein)\s+[\d.]+)\s+([\d,]+\.\d{2})\s+[\d,]+\.\d{2}\s+([\d,]+\.\d{3})\s+([\d,]+\.\d{3})/);
    if (!row) throw new StatementValidationError('unparsed-rows');
    running += shares(row[3]!);
    if (running !== shares(row[4]!)) throw new StatementValidationError('statement-arithmetic');
    if (/^(Shares Purchased|Fund Purchase)/.test(row[1]!)) purchases++;
    rows++;
  }
  if (!rows && !/No transactions this period\./.test(section)) throw new StatementValidationError('invalid-evidence');
  if (purchases !== purchaseCount) throw new StatementValidationError('unparsed-rows');
  if (running !== shares(anchors[1]![2]!) || Math.round(Number(anchors[1]![1]!.replace(/,/g,''))*100) !== closingBalanceCents) throw new StatementValidationError('statement-arithmetic');
  return { status: 'passed', checks: ['share-roll-forward', 'closing-balance', 'purchase-row-coverage'], transactionCompleteness: 'purchase-scope-only', activityRows: rows };
}

export function checkVanguardEmptyActivity(text: string, parsedCount: number) {
  // An explicitly bounded, entirely empty table is evidence. Absence of a
  // recognized date pattern in a nonempty table is not.
  const section = text.match(/Completed transactions([\s\S]*?)If you had an adjustment/);
  if (!section || section[1]!.trim()) return { status: 'unavailable', reason: 'no-recognized-activity-rows' };
  if (parsedCount) throw new StatementValidationError('unparsed-rows');
  return { status: 'passed', checks: ['explicit-empty-activity-table'], transactionCompleteness: 'completed-transactions-only' };
}
