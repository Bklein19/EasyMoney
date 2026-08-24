import { basename } from 'node:path';

export type SequoiaFundFileAccountIdentity =
  | { kind: 'last4'; value: string }
  | { kind: 'key'; value: string }
  | { kind: 'legacy'; value: null };

const storedHashPrefix = /^[0-9a-f]{64}-/i;
const accountIdentityPattern = /(?:^|-)account-(last4)-(\d{4})(?:-|\.)|(?:^|-)account-(key)-([a-f0-9]{12})(?:-|\.)/i;

export function sequoiaFundOriginalFileName(fileName: string): string {
  return basename(fileName).replace(storedHashPrefix, '');
}

export function sequoiaFundFileAccountIdentity(fileName: string): SequoiaFundFileAccountIdentity {
  const match = sequoiaFundOriginalFileName(fileName).match(accountIdentityPattern);
  if (match?.[1] && match[2]) return { kind: 'last4', value: match[2] };
  if (match?.[3] && match[4]) return { kind: 'key', value: match[4].toLowerCase() };
  return { kind: 'legacy', value: null };
}

export function sequoiaFundSourceAccountName(fileName: string): string {
  const identity = sequoiaFundFileAccountIdentity(fileName);
  if (identity.kind === 'last4') return `Sequoia Fund - ${identity.value}`;
  if (identity.kind === 'key') return `Sequoia Fund account ${identity.value}`;
  return 'Sequoia Fund';
}

export function isSequoiaFundActivityFileName(fileName: string): boolean {
  return /^sequoia-fund-account-(?:last4-\d{4}|key-[a-f0-9]{12})-activity-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/i
    .test(sequoiaFundOriginalFileName(fileName));
}

export function isSequoiaFundStatementFileName(fileName: string): boolean {
  const original = sequoiaFundOriginalFileName(fileName);
  return /^sequoia-fund-\d{4}-\d{2}-\d{2}\.pdf$/i.test(original) ||
    /^sequoia-fund-account-(?:last4-\d{4}|key-[a-f0-9]{12})-\d{4}-\d{2}-\d{2}-statement-[a-f0-9]{10}\.pdf$/i
      .test(original);
}
