import { createBookmarkAnnotationStore } from './bookmark-annotation-store.js';
import { tagsFitSync } from './bookmark-tag-limits.js';
import type { ClassificationTagUsage } from './generated/classification/classification-policy.js';

/** Both sources include synced bookmarks; max avoids counting that same vocabulary twice. */
export async function localClassificationTags(synced: readonly ClassificationTagUsage[] = []): Promise<ClassificationTagUsage[]> {
  const store = createBookmarkAnnotationStore();
  try {
    const usage = new Map<string, number>();
    for (const { tag, count } of [...synced, ...await store.tagCounts()]) if (tagsFitSync([tag])) usage.set(tag, Math.max(usage.get(tag) ?? 0, count));
    return [...usage].map(([tag, count]) => ({ tag, count }));
  } finally { store.close(); }
}
