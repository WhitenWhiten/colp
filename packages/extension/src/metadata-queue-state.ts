import type { MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';
import type { MetadataAttempt } from './local-metadata-state.js';
import { scopeKey } from './sync-state/scope-key.js';
import { metadataScope, sameMetadataAuthority } from './local-metadata-state.js';

export type MetadataQueueStore = Pick<ReturnType<typeof createSyncStateStore>,
  'listMappings' | 'getBookmarkEvent' | 'getQueueByOpId' | 'getQueueReceipt' | 'exportArchive'>;

/** Retired generations are immutable; load a large archive at most once per wake. */
export function metadataQueueReader(sync: MetadataQueueStore): MetadataQueueStore {
  const archives = new Map<string, ReturnType<MetadataQueueStore['exportArchive']>>();
  return { ...sync, exportArchive(scope) {
    const key = scopeKey(scope);
    if (!archives.has(key)) archives.set(key, sync.exportArchive(scope));
    return archives.get(key)!;
  } };
}
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
  ? value.flatMap(value => { const row = record(value); return row ? [row] : []; }) : [];

export const authoritativeMetadataMapping = (mapping: MappingInput): boolean =>
  !/^(?:local-|pending-|recovery:|sidecar:|unmounted:)/u.test(mapping.colpId)
  && !/^(?:local-|pending-)/u.test(mapping.projection.revision);

/** Legacy mappings may omit kind; native URL and canonical URL must still prove bookmark identity. */
export function metadataBookmarkMatches(mapping: MappingInput, bookmark: { readonly url?: string }): boolean {
  return (mapping.nodeKind === 'bookmark' || mapping.nodeKind === undefined)
    && typeof bookmark.url === 'string' && mapping.projection.content?.url === bookmark.url;
}

/** A receipt alone is insufficient: Pull must commit the bound resolution/transform. */
export async function settledMetadataAttempt(sync: MetadataQueueStore, scope: SyncScope,
  attempt: MetadataAttempt<unknown> | undefined, observedRevision?: string): Promise<number | undefined> {
  if (!attempt?.eventId || !sameMetadataAuthority(attempt.scopeKey, scopeKey(scope))) return undefined;
  const attemptScope = attempt.scopeKey === scopeKey(scope) ? scope : metadataScope(attempt.scopeKey);
  if (!attemptScope) return undefined;
  const event = await sync.getBookmarkEvent(attemptScope, attempt.eventId);
  const activeQueue = event?.opId ? await sync.getQueueByOpId(attemptScope, event.opId) : null;
  let queued: unknown = activeQueue;
  let receipt: unknown = activeQueue ? await sync.getQueueReceipt(attemptScope, activeQueue.sequence) : null;
  if (!queued && attempt.scopeKey !== scopeKey(scope)) {
    const archive = await sync.exportArchive(attemptScope).catch(() => null);
    if (archive?.scopeKey !== attempt.scopeKey || archive.lifecycle !== 'retired') return undefined;
    const archivedEvent = rows(archive.bookmarkEvents).find(event => event.eventId === attempt.eventId && event.scopeKey === attempt.scopeKey);
    queued = rows(archive.queue).find(queue => queue.opId === archivedEvent?.opId && queue.scopeKey === attempt.scopeKey);
    receipt = rows(archive.receipts).find(receipt => receipt.opId === record(queued)?.opId && receipt.scopeKey === attempt.scopeKey);
  }
  const queue = record(queued), evidence = record(receipt), payload = record(queue?.payload), results = record(evidence?.result)?.results;
  if (queue?.status !== 'terminal' || payload?.type !== 'update_node_content' || payload.targetId !== attempt.resourceId) return undefined;
  if (evidence?.kind !== 'terminal' || evidence.opId !== queue.opId
    || evidence.operationDigest !== queue.digest || !Array.isArray(results)) return undefined;
  return results.some(result => result && typeof result === 'object' && !Array.isArray(result)
    && result.opId === queue.opId && result.sequence === queue.sequence
    && (result.status === 'conflicted' || (['applied', 'rebased'].includes(String(result.status))
      && (queue.echoApplied === true || typeof result.revision === 'string' && result.revision === observedRevision)))) ? attempt.version : undefined;
}
