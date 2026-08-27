export type FidelityInvestmentReportStructure = "investment-report" | "portfolio-statement";

export function fidelityInvestmentReportStructure(
  sample: string,
): FidelityInvestmentReportStructure | null {
  if (!/INVESTMENT REPORT/i.test(sample) ||
    !/(?:Your Account Value|Ending Account Value)/i.test(sample)) {
    return null;
  }

  const accountNumber = sample.match(/Account (?:Number|#):?\s*([A-Z0-9]+-[A-Z0-9]+)/i)?.[1];
  if (!accountNumber) return null;

  return /^\d{3}-\d{6}$/.test(accountNumber)
    ? "portfolio-statement"
    : "investment-report";
}
