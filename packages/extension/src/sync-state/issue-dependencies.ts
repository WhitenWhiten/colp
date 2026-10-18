/** Transaction-local view of the same durable issue roots used by Pull and delete protection. */
import { issueAncestry } from '../sync-issues.js';
import { projectUnresolvedNativeWait } from '../native-wait-open.js';
import { cursorPage, scopeRowsRange, requestValue } from './idb.js';
import { STORES, INDEXES } from './schema.js';
import type { IntentRecord, MappingInput, UnknownRecord, BookmarkEventRecord } from './types.js';

export const ISSUE_DEPENDENCY_STORES = [STORES.mappings, STORES.diagnostics, STORES.intents, STORES.pullEvents, STORES.bookmarkEvents] as const;
export async function transactionIssueDependencies(queue: IDBObjectStore, key: string) {
  const tx = queue.transaction;
  const mappings = await cursorPage<MappingInput>(tx.objectStore(STORES.mappings), scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
  const diagnostics = await cursorPage<UnknownRecord>(tx.objectStore(STORES.diagnostics).index(INDEXES.diagnosticByScope),
    IDBKeyRange.bound([key], [key, []]), Number.MAX_SAFE_INTEGER);
  const roots = new Set<string>(); const nativeRoots = new Set<string>();
  for (const row of diagnostics) {
    if (row.kind === 'pull_issue' && typeof row.nodeId === 'string') roots.add(row.nodeId);
    if (row.kind === 'local_issue' && typeof row.nativeId === 'string') nativeRoots.add(row.nativeId);
  }
  const intents = await cursorPage<IntentRecord>(tx.objectStore(STORES.intents), scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
  for (const intent of intents) {
    const event = intent.eventId ? await requestValue(tx.objectStore(STORES.pullEvents).get([key, intent.eventId])) as UnknownRecord | undefined : undefined;
    if (!projectUnresolvedNativeWait(intent, event?.state)) continue;
    if (intent.colpId) roots.add(intent.colpId);
    if (intent.nativeTargetId) nativeRoots.add(intent.nativeTargetId);
  }
  for (const row of mappings) if (nativeRoots.has(row.nativeId)) roots.add(row.colpId);
  const byNative = new Map(mappings.map(row => [row.nativeId, row.colpId]));
  const operationParents = new Map<string, string[]>();
  const events = await cursorPage<BookmarkEventRecord>(tx.objectStore(STORES.bookmarkEvents), scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
  for (const event of events) {
    if (!event.opId) continue;
    const context = event.details.context as UnknownRecord | undefined;
    if (!context) continue;
    const parents = [context.sourceParentNativeId, context.targetParentNativeId, context.parentNativeId]
      .filter((id): id is string => typeof id === 'string').map(id => byNative.get(id) ?? id);
    operationParents.set(event.opId, parents);
  }
  return { roots, parents: issueAncestry(mappings), operationParents };
}
