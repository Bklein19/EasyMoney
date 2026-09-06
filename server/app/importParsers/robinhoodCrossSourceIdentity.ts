function normalizedWords(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function robinhoodBankingCrossSourceIdentity(description: string): string {
  let normalized = normalizedWords(description);
  normalized = normalized.replace(
    /^internal transfer from personal checking$/,
    'internal transfer from checking',
  );
  normalized = normalized.replace(
    /^internal transfer to (?:joint )?savings(?: with .+)?$/,
    'internal transfer to savings',
  );
  return `robinhood-banking:${normalized}`;
}

export function robinhoodCreditCrossSourceIdentity(description: string): string {
  const normalized = normalizedWords(description);
  const withoutTrailingContact = normalized.replace(
    /\s+\d[\d ]{5,}(?: [a-z]{2}| credit)$/,
    '',
  );
  return `robinhood-credit:${withoutTrailingContact.replace(/\s+/g, '')}`;
}
