import type { loadClassificationContext } from './classification-context.js';
import type { ClassificationCandidateCoverage } from './classification-policy.js';

export type ClassificationContext = NonNullable<Awaited<ReturnType<typeof loadClassificationContext>>>;
export type ClassificationStage = 'l1' | 'l2' | 'tags';
export interface ClassificationCallResult {
  readonly answer: unknown;
  readonly modelVersion: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly attemptNumber?: number;
}
export interface ClassificationCallRunner {
  run(stage: ClassificationStage, chunkIndex: number, input: unknown,
    send: () => Promise<ClassificationCallResult>): Promise<ClassificationCallResult>;
}
export interface ClassificationExecutionContext {
  readonly executionId: string; readonly deadlineAt: string;
  readonly signal: AbortSignal; readonly calls: ClassificationCallRunner;
}
export interface ClassificationProviderOutput {
  readonly l1: unknown; readonly l2: unknown; readonly tags: readonly unknown[];
  readonly candidateCoverage: ClassificationCandidateCoverage;
  readonly modelVersion: string | null;
}
export interface BookmarkClassificationProvider {
  readonly id: string; readonly model: string; readonly policyVersion: string;
  readonly promptVersion: string;
  readonly capabilities: {readonly idempotency: false};
  classify(input: ClassificationContext, execution: ClassificationExecutionContext): Promise<ClassificationProviderOutput>;
}
export class ClassificationProviderError extends Error {
  /** Dispatches already issued for this logical call when the error is raised after retrying. */
  constructor(readonly code: 'outcome_unknown' | 'credentials' | 'contract_drift' | 'deadline' | 'budget_exhausted' | 'disabled' | 'lease_lost' | 'configuration_changed' | 'rate_limited',
    readonly attempts?: number) {
    super(code); this.name = 'ClassificationProviderError';
  }
}
