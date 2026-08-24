import { z } from 'zod';

import { isSyncInstitutionId } from './registry.ts';
import {
  SYNC_WORKER_PROTOCOL_VERSION,
  type SyncExecutionPlan,
  type SyncWorkerMessage,
} from './types.ts';

export const SYNC_WORKER_MESSAGE_PREFIX = '@@easymoney-sync:';

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const runIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const nullableString = z.string().nullable();
const artifactFileNameSchema = z.string().min(1).refine(value =>
  value !== '.' && value !== '..' && !/[\\/]/.test(value),
  'Artifact file name must not contain a path',
);

const syncGoalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('current'),
    overlapDays: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('backfill'),
    stopAt: isoDateSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('range'),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
  }).strict(),
]);

const syncAccountCoverageSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  institution: nullableString,
  type: z.string(),
  latestFactDate: nullableString,
  earliestFactDate: nullableString,
  latestBalanceDate: nullableString,
  earliestBalanceDate: nullableString,
  balanceDates: z.array(z.string()),
  sourceAccountName: nullableString,
  sourceAccountNames: z.array(z.string()),
  accountAliases: z.array(z.string()),
  accountHolder: nullableString,
  artifactFileNames: z.array(z.string()),
}).strict();

const syncExecutionPlanSchema = z.object({
  protocolVersion: z.literal(SYNC_WORKER_PROTOCOL_VERSION),
  runId: runIdSchema,
  institutionId: z.string(),
  today: isoDateSchema,
  accounts: z.array(syncAccountCoverageSchema),
  connectionId: z.string().min(1).optional(),
  goal: syncGoalSchema,
  outputDir: z.string().min(1),
}).strict();

const syncEventSchema = z.object({
  runId: runIdSchema,
  timestamp: z.string(),
  type: z.enum(['phase', 'action', 'artifact', 'import', 'review', 'warning', 'complete', 'error']),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
}).strict();

const syncArtifactManifestSchema = z.object({
  protocolVersion: z.literal(SYNC_WORKER_PROTOCOL_VERSION),
  runId: runIdSchema,
  institutionId: z.string(),
  artifacts: z.array(z.object({
    fileName: artifactFileNameSchema,
    accountId: z.number().int().positive(),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()),
}).strict();

const syncWorkerMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    protocolVersion: z.literal(SYNC_WORKER_PROTOCOL_VERSION),
    kind: z.literal('event'),
    event: syncEventSchema,
  }).strict(),
  z.object({
    protocolVersion: z.literal(SYNC_WORKER_PROTOCOL_VERSION),
    kind: z.literal('manifest'),
    manifest: syncArtifactManifestSchema,
  }).strict(),
]);

function parseJson(input: string, description: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new Error(`${description} is not valid JSON`);
  }
}

function registeredInstitution<T extends { institutionId: string }>(
  value: T,
  description: string,
): asserts value is T & { institutionId: SyncExecutionPlan['institutionId'] } {
  if (!isSyncInstitutionId(value.institutionId)) {
    throw new Error(`${description} names an unsupported institution connector`);
  }
}

export function parseSyncExecutionPlan(input: string): SyncExecutionPlan {
  const plan = syncExecutionPlanSchema.parse(parseJson(input, 'Sync execution plan'));
  registeredInstitution(plan, 'Sync execution plan');
  return plan;
}

export function serializeSyncExecutionPlan(plan: SyncExecutionPlan): string {
  return JSON.stringify(syncExecutionPlanSchema.parse(plan));
}

export function parseSyncWorkerMessage(input: string): SyncWorkerMessage {
  const message = syncWorkerMessageSchema.parse(parseJson(input, 'Sync worker message'));
  if (message.kind === 'manifest') {
    registeredInstitution(message.manifest, 'Sync artifact manifest');
  }
  return message as SyncWorkerMessage;
}

export function serializeSyncWorkerMessage(message: SyncWorkerMessage): string {
  return JSON.stringify(syncWorkerMessageSchema.parse(message));
}

export function parseSyncWorkerLine(input: string): SyncWorkerMessage | null {
  if (!input.startsWith(SYNC_WORKER_MESSAGE_PREFIX)) return null;
  return parseSyncWorkerMessage(input.slice(SYNC_WORKER_MESSAGE_PREFIX.length));
}

export function serializeSyncWorkerLine(message: SyncWorkerMessage): string {
  return `${SYNC_WORKER_MESSAGE_PREFIX}${serializeSyncWorkerMessage(message)}`;
}
