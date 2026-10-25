import type { PageResult, SiteItem } from './contracts.js';
import type { ImportRead } from './ledger-types.js';
import type { SiteDefinition } from './registry-types.js';
import type { ReconcileSnapshot } from './reconcile-model.js';
export interface ReconcilePage { request: ImportRead; result: PageResult }
/** A qualified, contiguous, closed snapshot is required for inferred negative memberships. */
export function reconcileSnapshot(definition: Pick<SiteDefinition, 'collectionSnapshot'>, collectionId: string, pages: readonly ReconcilePage[]): ReconcileSnapshot {
  const relevant = pages.filter(p => p.request.query.kind === 'items' && p.request.query.collectionId === collectionId);
  const items = new Map<string, SiteItem>(), seen = new Set<string>(); let cursor: string | null = null, snapshotId: string | null = null;
  let complete = false, consistent = definition.collectionSnapshot === 'pointInTime', reason: string | null = null;
  for (const { request, result } of relevant) {
    if (complete || request.query.cursor !== cursor || result.status !== 'ok' || result.kind !== 'items' || result.collectionId !== collectionId) { reason = 'sourceReadIncomplete'; break; }
    if (result.page.coverage !== 'complete' || result.page.omissions?.length) { reason = 'sourceReadIncomplete'; consistent = false; }
    if (result.page.consistency !== 'pointInTime') consistent = false;
    else if (snapshotId === null) snapshotId = result.page.snapshotId;
    else if (snapshotId !== result.page.snapshotId) { consistent = false; reason = 'sourceSnapshotChanged'; }
    for (const row of result.page.items) {
      if (items.has(row.item.id)) consistent = false;
      items.set(row.item.id, row.item);
    }
    cursor = result.page.nextCursor;
    if (cursor && seen.has(cursor)) { reason = 'sourceReadIncomplete'; break; }
    if (cursor) seen.add(cursor); else complete = true;
  }
  complete = complete && !reason;
  return { collectionId, items: [...items.values()], complete, absence: complete && consistent ? 'proven' : 'unverified', snapshotId,
    reason: reason ?? (!complete ? 'sourceReadIncomplete' : !consistent ? 'sourceAbsenceUnverified' : null) };
}
