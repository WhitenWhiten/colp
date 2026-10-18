import { OPEN_REMOTE_DELETE_STATES } from '../remote-delete-pending-facts.js';
import { openIngressIssue, ingressProtectsNode, blockedPullIssue } from './open-issue-facts.js';
/** Transaction-local view of the same durable issue roots used by Pull and delete protection. */
import { issueAncestry } from '../sync-issues.js';
import { projectUnresolvedNativeWait } from '../native-wait-open.js';
import { cursorPage, scopeRowsRange, requestValue } from './idb.js';
import { STORES, INDEXES } from './schema.js';
import type { IntentRecord, MappingInput, UnknownRecord, BookmarkEventRecord } from './types.js';

export const ISSUE_DEPENDENCY_STORES = [STORES.receipts, STORES.mappings, STORES.diagnostics, STORES.intents, STORES.pullEvents, STORES.bookmarkEvents, STORES.pullPages, STORES.remoteDeleteDecisions] as const;
export async function transactionIssueDependencies(queue: IDBObjectStore, key: string, excludeEventId?: string) {
  const tx = queue.transaction;
  const mappings = await requestValue<MappingInput[]>(tx.objectStore(STORES.mappings).getAll(scopeRowsRange(key)));
  const diagnostics = await requestValue<UnknownRecord[]>(tx.objectStore(STORES.diagnostics).index(INDEXES.diagnosticByScope)
    .getAll(IDBKeyRange.bound([key], [key, []])));
  const prerequisiteOpIds = new Set<string>();
  const roots = new Set<string>(); const nativeRoots = new Set<string>();
  for (const row of diagnostics) {
    if (row.kind === 'pull_issue' && typeof row.nodeId === 'string') roots.add(row.nodeId);
    if (row.kind === 'local_issue' && typeof row.nativeId === 'string') nativeRoots.add(row.nativeId);
  }
  const intents = await requestValue<IntentRecord[]>(tx.objectStore(STORES.intents).getAll(scopeRowsRange(key)));
  for (const intent of intents) {
    const event = intent.eventId ? await requestValue(tx.objectStore(STORES.pullEvents).get([key, intent.eventId])) as UnknownRecord | undefined : undefined;
    if (!projectUnresolvedNativeWait(intent, event?.state)) continue;
    if (intent.colpId) roots.add(intent.colpId);
    if (intent.nativeTargetId) nativeRoots.add(intent.nativeTargetId);
  }
  for (const diagnostic of diagnostics) {
    const park = diagnostic.park as UnknownRecord | undefined; if (typeof park?.eventId !== 'string' || park.eventId === excludeEventId) continue;
    const event = await requestValue<BookmarkEventRecord | undefined>(tx.objectStore(STORES.bookmarkEvents).get([key, park.eventId]));
    const issue = openIngressIssue(diagnostic, event);
    if (event?.status === 'pending' && typeof park.dependencyOpId === 'string') prerequisiteOpIds.add(park.dependencyOpId);
    if (event?.status === 'pending' && typeof park.dependencyEventId === 'string') {
      const predecessor = await requestValue<BookmarkEventRecord | undefined>(tx.objectStore(STORES.bookmarkEvents).get([key, park.dependencyEventId]));
      if (predecessor?.opId) prerequisiteOpIds.add(predecessor.opId);
    }
    if (issue && ingressProtectsNode(issue)) nativeRoots.add(issue.nativeId);
  }
  for (const mapping of mappings) if (nativeRoots.has(mapping.nativeId)) roots.add(mapping.colpId);
  const pages = await requestValue<UnknownRecord[]>(tx.objectStore(STORES.pullPages).getAll(scopeRowsRange(key)));
  for (const page of pages) {
    if (page.state !== 'blocked') continue;
    const events = await cursorPage<UnknownRecord>(tx.objectStore(STORES.pullEvents).index(INDEXES.pullEventByPage),
      IDBKeyRange.bound([key, page.pageId], [key, page.pageId, []]), Number.MAX_SAFE_INTEGER);
    const issue = blockedPullIssue(page, events); for (const id of issue?.nodeIds ?? []) roots.add(id);
  }
  const independentRoots = new Set(roots);
  const decisions = await requestValue<UnknownRecord[]>(tx.objectStore(STORES.remoteDeleteDecisions).getAll(scopeRowsRange(key)));
  for (const decision of decisions) if ((OPEN_REMOTE_DELETE_STATES as readonly string[]).includes(String(decision.state))) roots.add(String(decision.targetId));
  const byNative = new Map(mappings.map(row => [row.nativeId, row.colpId]));
  const operationParents = new Map<string, string[]>();
  const events = await requestValue<BookmarkEventRecord[]>(tx.objectStore(STORES.bookmarkEvents).getAll(scopeRowsRange(key)));
  for (const event of events) {
    if (!event.opId) continue;
    const context = event.details.context as UnknownRecord | undefined;
    if (!context) continue;
    const parents = [context.sourceParentNativeId, context.targetParentNativeId, context.parentNativeId]
      .filter((id): id is string => typeof id === 'string').map(id => byNative.get(id) ?? id);
    operationParents.set(event.opId, parents);
  }
  return { roots, independentRoots, prerequisiteOpIds, decisions, parents: issueAncestry(mappings), operationParents };
}
