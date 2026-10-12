import { digestJson } from './bookmark-event-codec.js';
import type { JsonObject } from './sync-state-store.js';

/** Lazy read/write migration: old internal order fields never reach content consumers. */
export function normalizeBookmarkProjection(projection: Record<string, unknown>): Record<string, unknown> {
  const raw = projection.content;
  const content = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as JsonObject : undefined;
  const order = projection.childrenOrder ?? content?.childrenOrder;
  if (order !== undefined && (!Array.isArray(order) || order.some(id => typeof id !== 'string'))) {
    throw new Error('projection_order_invalid');
  }
  const migrated = content && ('childrenOrder' in content || 'childrenOrderDigest' in content);
  const clean = migrated ? Object.fromEntries(Object.entries(content)
    .filter(([key]) => key !== 'childrenOrder' && key !== 'childrenOrderDigest')) : content;
  return { ...projection, ...(order === undefined ? {} : { childrenOrder: [...order as string[]] }),
    ...(migrated ? { content: clean, digest: digestJson(clean!), contentDigest: digestJson(clean!) } : {}) };
}
