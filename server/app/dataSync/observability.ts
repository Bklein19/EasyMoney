import type { SyncReporter } from './types.ts';

export type SyncStepDetails = Record<string, string | number | boolean | null>;

export interface SyncStepOptions {
  step: string;
  message: string;
  completeMessage?: string;
  details?: SyncStepDetails;
}

type Clock = () => number;

export async function reportSyncStep<T>(
  report: SyncReporter,
  options: SyncStepOptions,
  operation: () => Promise<T>,
  clock: Clock = performance.now.bind(performance),
): Promise<T> {
  const startedAt = clock();
  report({
    type: 'action',
    message: options.message,
    data: {
      ...options.details,
      step: options.step,
      status: 'started',
    },
  });

  try {
    const result = await operation();
    report({
      type: 'action',
      message: options.completeMessage ?? `${options.message} complete`,
      data: {
        ...options.details,
        step: options.step,
        status: 'completed',
        durationMs: Math.max(0, Math.round(clock() - startedAt)),
      },
    });
    return result;
  } catch (error) {
    report({
      type: 'action',
      message: `${options.message} failed`,
      data: {
        ...options.details,
        step: options.step,
        status: 'failed',
        durationMs: Math.max(0, Math.round(clock() - startedAt)),
      },
    });
    throw error;
  }
}
