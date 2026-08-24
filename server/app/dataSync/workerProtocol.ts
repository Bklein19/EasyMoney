import { z } from 'zod';

import { isSyncInstitutionId } from './registry.ts';
import {
  SYNC_WORKER_PROTOCOL_VERSION,
  type SyncArtifactManifest,
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
const syncArtifactAccountRoutesSchema = z.array(z.object({
  remoteAccountId: z.string().trim().min(1),
  accountId: z.number().int().positive().optional(),
}).strict()).min(1).superRefine((routes, context) => {
  const remoteAccountIds = new Set<string>();
  for (const [index, route] of routes.entries()) {
    if (remoteAccountIds.has(route.remoteAccountId)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate remote account identity: ${route.remoteAccountId}`,
        path: [index, 'remoteAccountId'],
      });
    }
    remoteAccountIds.add(route.remoteAccountId);
  }
});

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
  artifacts: z.array(z.union([
    z.object({
      fileName: artifactFileNameSchema,
      accountId: z.number().int().positive(),
      sizeBytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict(),
    z.object({
      fileName: artifactFileNameSchema,
      accountRoutes: syncArtifactAccountRoutesSchema,
      sizeBytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict(),
  ])),
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

export function validateSyncArtifactManifestForPlan(
  manifest: SyncArtifactManifest,
  plan: SyncExecutionPlan,
): void {
  if (manifest.runId !== plan.runId || manifest.institutionId !== plan.institutionId) {
    throw new Error('Sync artifact manifest does not match its execution plan');
  }
  const plannedAccountIds = new Set(plan.accounts.map(account => account.id));
  const concreteAccountIds = manifest.artifacts.flatMap(artifact =>
    artifact.accountId !== undefined
      ? [artifact.accountId]
      : artifact.accountRoutes.flatMap(route =>
          route.accountId === undefined ? [] : [route.accountId]
        )
  );
  if (concreteAccountIds.some(accountId => !plannedAccountIds.has(accountId))) {
    throw new Error('Sync artifact manifest names an account outside its execution plan');
  }
  const artifactNames = manifest.artifacts.map(artifact => artifact.fileName);
  if (new Set(artifactNames).size !== artifactNames.length) {
    throw new Error('Sync artifact manifest repeats an artifact');
  }
}

export function serializeSyncWorkerLine(message: SyncWorkerMessage): string {
  return `${SYNC_WORKER_MESSAGE_PREFIX}${serializeSyncWorkerMessage(message)}`;
}
