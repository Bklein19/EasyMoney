import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';

import { createConnectorDevelopmentRun } from './developmentRun.ts';
import { createSyncExecutionPlanFromAccounts } from './executionPlanCore.ts';
import { runSyncExecutionPlan } from './runner.ts';
import type {
  SyncArtifactManifest,
  SyncExecutionPlan,
  SyncGoal,
  SyncInstitutionId,
  SyncReporter,
} from './types.ts';
import { parseSyncExecutionPlan } from './workerProtocol.ts';

const SAFE_LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PERSISTED_EVENTS = 500;

export interface ConnectorDevelopmentOptions {
  institutionId: SyncInstitutionId;
  sourcePlanPath: string;
  goal: SyncGoal;
  root?: string;
  profileName?: string;
  runId?: string;
  today?: string;
  now?: Date;
  processId?: number;
}

export interface ConnectorDevelopmentRunCreated {
  institutionId: SyncInstitutionId;
  runId: string;
  resultPath: string;
}

export interface SafeConnectorDevelopmentEvent {
  type: 'phase' | 'action' | 'artifact' | 'import' | 'review' | 'warning' | 'complete' | 'error';
  step?: string;
  status?: string;
  accountKind?: string;
  artifactKind?: string;
  accountCount?: number;
  discoveredAccountCount?: number;
  artifactCount?: number;
  unavailableArtifactCount?: number;
  transactionCount?: number;
  balanceCount?: number;
  byteLength?: number;
  durationMs?: number;
  parserValidated?: true;
}

export type ConnectorDevelopmentFailureCode =
  | 'authentication-timeout'
  | 'authentication-required'
  | 'browser-closed'
  | 'request-timeout'
  | 'parser-validation-failed'
  | 'account-discovery-failed'
  | 'browser-profile-unavailable'
  | 'connector-run-failed';

export interface ConnectorDevelopmentResult {
  version: 1;
  institutionId: SyncInstitutionId;
  runId: string;
  status: 'running' | 'complete' | 'failed';
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  eventCount: number;
  events: SafeConnectorDevelopmentEvent[];
  parserValidationCount: number;
  artifactCount: number;
  artifactTypes: Record<string, number>;
  failure?: {
    code: ConnectorDevelopmentFailureCode;
    summary: string;
    stage: string;
  };
}

interface ConnectorDevelopmentDependencies {
  createDevelopmentRun?: typeof createConnectorDevelopmentRun;
  createExecutionPlan?: typeof createSyncExecutionPlanFromAccounts;
  runExecutionPlan?: typeof runSyncExecutionPlan;
  readSourcePlan?: (path: string) => Promise<string>;
  writeResult?: (path: string, result: ConnectorDevelopmentResult) => Promise<void>;
  clock?: () => Date;
  onRunCreated?: (run: ConnectorDevelopmentRunCreated) => void;
}

function safeLabel(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_LABEL.test(value) ? value : undefined;
}

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function safeEvent(
  event: Parameters<SyncReporter>[0],
): SafeConnectorDevelopmentEvent {
  const data = event.data ?? {};
  const safe: SafeConnectorDevelopmentEvent = { type: event.type };
  for (const key of ['step', 'status', 'accountKind', 'artifactKind'] as const) {
    const value = safeLabel(data[key]);
    if (value !== undefined) safe[key] = value;
  }
  for (const key of [
    'accountCount',
    'discoveredAccountCount',
    'artifactCount',
    'unavailableArtifactCount',
    'transactionCount',
    'balanceCount',
    'byteLength',
    'durationMs',
  ] as const) {
    const value = safeCount(data[key]);
    if (value !== undefined) safe[key] = value;
  }
  if (data.parserValidated === true) safe.parserValidated = true;
  return safe;
}

function classifyFailure(error: unknown): NonNullable<ConnectorDevelopmentResult['failure']> {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (/auth(?:entication)?.*tim(?:ed|e)[ -]?out/.test(message)) {
    return { code: 'authentication-timeout', summary: 'Authentication timed out', stage: 'authentication' };
  }
  if (/auth(?:entication)?.*(?:required|login|sign[ -]?in)/.test(message)) {
    return { code: 'authentication-required', summary: 'Authentication was not completed', stage: 'authentication' };
  }
  if (/browser.*closed|closed.*browser/.test(message)) {
    return { code: 'browser-closed', summary: 'Browser closed before the connector completed', stage: 'browser' };
  }
  if (/request.*tim(?:ed|e)[ -]?out|tim(?:ed|e)[ -]?out.*request/.test(message)) {
    return { code: 'request-timeout', summary: 'An authenticated request timed out', stage: 'request' };
  }
  if (/parser|validation/.test(message)) {
    return { code: 'parser-validation-failed', summary: 'Artifact parser validation failed', stage: 'validation' };
  }
  if (/account.*(?:discover|mapping|ambiguous)|(?:discover|mapping|ambiguous).*account/.test(message)) {
    return { code: 'account-discovery-failed', summary: 'Account discovery or mapping failed', stage: 'account-discovery' };
  }
  if (/profile.*(?:lock|lease|unavailable)|(?:lock|lease).*profile/.test(message)) {
    return { code: 'browser-profile-unavailable', summary: 'Browser profile was unavailable', stage: 'browser-profile' };
  }
  return { code: 'connector-run-failed', summary: 'Connector development run failed', stage: 'connector-run' };
}

function activeFailureStage(
  events: readonly SafeConnectorDevelopmentEvent[],
  fallback: string,
): string {
  const active = new Map<string, number>();
  for (const [index, event] of events.entries()) {
    if (!event.step || !event.status) continue;
    if (event.status === 'started') active.set(event.step, index);
    if (event.status === 'completed' || event.status === 'skipped') active.delete(event.step);
    if (event.status === 'failed' && event.step !== 'sync') return event.step;
  }
  return [...active.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? fallback;
}

function artifactTypes(manifest: SyncArtifactManifest): Record<string, number> {
  const result: Record<string, number> = {};
  for (const artifact of manifest.artifacts) {
    const extension = extname(artifact.fileName).toLowerCase();
    const type = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension.slice(1) : 'unknown';
    result[type] = (result[type] ?? 0) + 1;
  }
  return result;
}

export async function writeConnectorDevelopmentResult(
  path: string,
  result: ConnectorDevelopmentResult,
): Promise<void> {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

export async function runConnectorDevelopment(
  options: ConnectorDevelopmentOptions,
  dependencies: ConnectorDevelopmentDependencies = {},
): Promise<ConnectorDevelopmentResult> {
  if (options.today !== undefined && !ISO_DATE.test(options.today)) {
    throw new Error('Development runner today must use YYYY-MM-DD');
  }
  const sourcePlanText = await (dependencies.readSourcePlan ?? (path => readFile(path, 'utf8')))(
    resolve(options.sourcePlanPath),
  );
  const sourcePlan = parseSyncExecutionPlan(sourcePlanText);
  if (sourcePlan.institutionId !== options.institutionId) {
    throw new Error('Development source plan institution does not match the requested connector');
  }

  const clock = dependencies.clock ?? (() => new Date());
  const started = options.now ?? clock();
  const development = await (dependencies.createDevelopmentRun ?? createConnectorDevelopmentRun)({
    institutionId: options.institutionId,
    profileName: options.profileName ?? `${options.institutionId}-catchup`,
    ...(options.root ? { root: options.root } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    now: started,
    ...(options.processId === undefined ? {} : { processId: options.processId }),
  });
  const resultPath = join(dirname(development.outputDir), 'result.json');
  const plan: SyncExecutionPlan = (dependencies.createExecutionPlan ?? createSyncExecutionPlanFromAccounts)({
    runId: development.runId,
    institutionId: options.institutionId,
    ...(sourcePlan.connectionId ? { connectionId: sourcePlan.connectionId } : {}),
    goal: options.goal,
  }, {
    ...(options.today ? { today: options.today } : { now: started }),
    accounts: sourcePlan.accounts,
    outputDir: development.outputDir,
  });
  const result: ConnectorDevelopmentResult = {
    version: 1,
    institutionId: options.institutionId,
    runId: development.runId,
    status: 'running',
    startedAt: started.toISOString(),
    updatedAt: started.toISOString(),
    eventCount: 0,
    events: [],
    parserValidationCount: 0,
    artifactCount: 0,
    artifactTypes: {},
  };
  const writeResult = dependencies.writeResult ?? writeConnectorDevelopmentResult;
  let pendingWrite = writeResult(resultPath, structuredClone(result));
  dependencies.onRunCreated?.({
    institutionId: options.institutionId,
    runId: development.runId,
    resultPath,
  });

  const report: SyncReporter = event => {
    const persistedEvent = safeEvent(event);
    result.eventCount += 1;
    result.events.push(persistedEvent);
    if (result.events.length > MAX_PERSISTED_EVENTS) result.events.shift();
    if (persistedEvent.parserValidated) result.parserValidationCount += 1;
    result.updatedAt = clock().toISOString();
    const snapshot = structuredClone(result);
    pendingWrite = pendingWrite.then(() => writeResult(resultPath, snapshot));
  };

  try {
    const manifest = await (dependencies.runExecutionPlan ?? runSyncExecutionPlan)(plan, report);
    await pendingWrite;
    const completedAt = clock().toISOString();
    result.status = 'complete';
    result.updatedAt = completedAt;
    result.completedAt = completedAt;
    result.artifactCount = manifest.artifacts.length;
    result.artifactTypes = artifactTypes(manifest);
    await writeResult(resultPath, result);
    return result;
  } catch (error) {
    await pendingWrite;
    const completedAt = clock().toISOString();
    const failure = classifyFailure(error);
    failure.stage = activeFailureStage(result.events, failure.stage);
    result.status = 'failed';
    result.updatedAt = completedAt;
    result.completedAt = completedAt;
    result.failure = failure;
    await writeResult(resultPath, result);
    return result;
  }
}
