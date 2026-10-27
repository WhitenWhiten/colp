export interface ImportReviewSummary {
  reviewSamples?: readonly { itemId: string; collectionId: string; reason: string }[];
  reviewCounts?: Record<string, number>;
}

/** These failures describe the mapping or settings, rather than individual videos. */
export const importScopeProblems = new Set([
  'sourceDestinationNeedsReview', 'sourceDestinationChanged', 'sourceDestinationMigrationRequired',
  'sourceMappingMigrationRequired', 'mountMigrationRequired', 'bindingUnavailable',
  'sourceAutomationPaused', 'sourcePolicyUnavailable', 'permissionRequired', 'sourceSyncUpgradeRequired',
]);

export function countImportReviews(rows: readonly { reviewReason?: string | null }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) if (row.reviewReason) counts[row.reviewReason] = (counts[row.reviewReason] ?? 0) + 1;
  return counts;
}

export function importBlocker(job: { reason: string | null; authorization?: import('./import-authorization.js').ImportAuthorization; preview?: {
  counts: { createBookmarks: number; createFolders: number; review: number }; reviewCounts?: Record<string, number>;
} | null } | null): string | null {
  if (job?.authorization === 'differentAccount' || job?.authorization === 'unavailable') return null;
  if (job?.reason && importScopeProblems.has(job.reason)) return job.reason;
  const preview = job?.preview;
  if (!preview || preview.counts.createBookmarks || preview.counts.createFolders) return null;
  return Object.keys(preview.reviewCounts ?? {}).find(code => importScopeProblems.has(code)) ?? null;
}
