export const SYNC_CORE_COVERAGE_FILES: readonly string[];
export const SYNC_PULL_COVERAGE_FILES: readonly string[];
export const SYNC_PULL_BRANCH_MINIMUM: number;
export const SYNC_NEW_COVERAGE_FILES: readonly string[];
export const SYNC_NEW_BRANCH_MINIMUM: number;

export type SyncCoverageMetrics = Readonly<{
  lines: number;
  branches: number;
  functions: number;
  statements: number;
}>;

export function evaluateSyncCoverageRatchet(
  summary: unknown,
  baseline: { readonly files: Readonly<Record<string, SyncCoverageMetrics>> },
): string[];

export function measuredSyncCoverageBaseline(
  summary: unknown,
  previous?: { readonly files: Readonly<Record<string, SyncCoverageMetrics>> },
): { metrics: string[]; files: Record<string, SyncCoverageMetrics> };
