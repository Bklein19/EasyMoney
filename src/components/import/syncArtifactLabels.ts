import type { SyncArtifactReview } from '../../../server/app/dataSync/types.ts';

type ArtifactLabelMetadata = Pick<
  SyncArtifactReview,
  'coveredFrom' | 'coveredTo' | 'institution' | 'parserLabel' | 'sourceType'
>;

const SOURCE_TYPE_LABELS: Record<string, string> = {
  'activity-export': 'Activity export',
  statement: 'Statement',
};

const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const SHORT_MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function cleanLabel(value: string | null | undefined) {
  return value?.trim() || null;
}

function calendarDate(value: string | null | undefined): CalendarDate | null {
  const match = cleanLabel(value)?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const verified = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (
    verified.getUTCFullYear() !== date.year ||
    verified.getUTCMonth() + 1 !== date.month ||
    verified.getUTCDate() !== date.day
  ) return null;
  return date;
}

function serialDay(date: CalendarDate) {
  return Date.UTC(date.year, date.month - 1, date.day) / 86_400_000;
}

function datePeriod(artifact: ArtifactLabelMetadata): string | null {
  if (artifact.sourceType !== 'activity-export' && artifact.sourceType !== 'statement') return null;
  const from = calendarDate(artifact.coveredFrom);
  const to = calendarDate(artifact.coveredTo);
  const first = from || to;
  const last = to || from;
  if (!first || !last) return null;

  if (artifact.sourceType === 'activity-export') {
    return first.year === last.year ? String(last.year) : `${first.year}–${last.year}`;
  }

  if (first.year === last.year && first.month === last.month) {
    return `${MONTH_LABELS[last.month - 1]} ${last.year}`;
  }

  const firstQuarter = Math.floor((first.month - 1) / 3) + 1;
  const lastQuarter = Math.floor((last.month - 1) / 3) + 1;
  if (
    first.year === last.year &&
    firstQuarter === lastQuarter &&
    serialDay(last) - serialDay(first) > 45
  ) return `Q${lastQuarter} ${last.year}`;

  if (first.year === last.year) {
    return `${SHORT_MONTH_LABELS[first.month - 1]}–${SHORT_MONTH_LABELS[last.month - 1]} ${last.year}`;
  }
  return `${SHORT_MONTH_LABELS[first.month - 1]} ${first.year}–${SHORT_MONTH_LABELS[last.month - 1]} ${last.year}`;
}

export function syncArtifactSourceLabel(sourceType: string | null | undefined) {
  const normalized = cleanLabel(sourceType)?.toLowerCase();
  if (!normalized) return 'Unknown artifact type';
  return SOURCE_TYPE_LABELS[normalized] || normalized.replaceAll('-', ' ');
}

export function syncArtifactTitle(artifact: ArtifactLabelMetadata) {
  const sourceLabel = syncArtifactSourceLabel(artifact.sourceType);
  const period = datePeriod(artifact);
  const kindLabel = artifact.sourceType === 'activity-export' ? 'activity' : sourceLabel.toLowerCase();
  if (period) return `${period} ${kindLabel}`;
  return cleanLabel(artifact.parserLabel) || sourceLabel;
}

export function syncArtifactSubtitle(artifact: ArtifactLabelMetadata) {
  const title = syncArtifactTitle(artifact).toLowerCase();
  return [cleanLabel(artifact.parserLabel), cleanLabel(artifact.institution)]
    .find(label => label && !title.includes(label.toLowerCase())) || null;
}
