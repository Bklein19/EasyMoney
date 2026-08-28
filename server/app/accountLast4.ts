export function normalizeAccountLast4(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (!/^\d{4}$/.test(normalized)) {
    throw new Error('Account last four must contain exactly four digits.');
  }
  return normalized;
}

export function accountLast4FromLabel(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  const explicit = normalized.match(
    /(?:ending in|(?:x|\*|\u2022){2,}|[-\u2013\u2014])\s*(\d{4})$/i,
  )?.[1];
  if (explicit) return explicit;

  // Some retirement sources expose a multi-digit plan identifier rather than
  // a masked account number. Require more than four digits so a statement year
  // such as "Retirement plan 2026" cannot become account metadata.
  const identifier = normalized.match(/\b(?:account|acct|plan)\b.*?(\d{5,})(?!\d)$/i)?.[1];
  return identifier?.slice(-4) ?? null;
}

export function accountLast4FromRemoteIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || !/[:|]/.test(normalized)) return null;
  const terminalToken = normalized.split(/[:|]/).filter(Boolean).at(-1)?.trim() ?? '';
  const digits = terminalToken.match(/^(?:[A-Za-z])?(\d{4,})$/)?.[1];
  return digits?.slice(-4) ?? null;
}

export function commonAccountLast4(values: Array<string | null | undefined>): string | null {
  const candidates = new Set(values
    .map(value => accountLast4FromLabel(value) ?? accountLast4FromRemoteIdentity(value))
    .filter((value): value is string => value !== null));
  return candidates.size === 1 ? [...candidates][0]! : null;
}

export function sourceAccountLast4(sourceAccount: {
  sourceAccountKey?: string | null;
  sourceAccountName?: string | null;
}): string | null {
  const candidates = new Set([
    accountLast4FromLabel(sourceAccount.sourceAccountName),
    accountLast4FromLabel(sourceAccount.sourceAccountKey) ??
      accountLast4FromRemoteIdentity(sourceAccount.sourceAccountKey),
  ].filter((value): value is string => value !== null));
  return candidates.size === 1 ? [...candidates][0]! : null;
}
