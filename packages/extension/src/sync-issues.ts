import { openBootstrapAttention, type BootstrapDisplayIssue } from './bootstrap/open-attention.js';
import { OPEN_REMOTE_DELETE_STATES } from './remote-delete-pending-facts.js';
import { mergeLocalIssues, ingressProtectsNode, blockedPullIssue, isOpenQueueIssue, addQueueIssueRoots, type BlockedPullIssue } from './sync-state/open-issue-facts.js';
/** One interpretation of durable open issues, shared by sync and repair consumers. */
import { projectNativeWaits, type NativeWaitStore } from './native-wait.js';
import type { LocalIssueRecord, MappingInput, PullIssueRecord, QueueOperation, SyncScope,
  createSyncStateStore } from './sync-state-store.js';

export type SyncIssueStore = Partial<Pick<ReturnType<typeof createSyncStateStore>,
  'listConsumedQueueIssues' | 'listBootstrapRuns' | 'listRemoteDeleteDecisions' | 'listQueue' | 'listPullIssues' | 'listLocalIssues' | 'listMappings' | 'listOpenIngressIssues' | 'listPullPages' | 'listPullEventsByPage'> & NativeWaitStore>;
export interface OpenSyncIssues {
  readonly bootstrap: readonly BootstrapDisplayIssue[];
  readonly operationalTotal: number;
  readonly queue: readonly QueueOperation[];
  readonly pull: readonly PullIssueRecord[];
  readonly local: readonly LocalIssueRecord[];
  readonly replica: readonly BlockedPullIssue[];
  readonly waits: Awaited<ReturnType<typeof projectNativeWaits>>;
  readonly deletes: Awaited<ReturnType<ReturnType<typeof createSyncStateStore>['listRemoteDeleteDecisions']>>;
  readonly roots: ReadonlySet<string>;
  readonly nativeRoots: ReadonlySet<string>;
  readonly total: number;
}

export async function readOpenSyncIssues(store: SyncIssueStore, scope: SyncScope, options: { readonly excludeDeleteEventId?: string; readonly resolvingRestoreOpId?: string; readonly excludeQueueOpIds?: ReadonlySet<string> } = {}): Promise<OpenSyncIssues> {
  const queue: QueueOperation[] = [];
  if (store.listQueue) for (const status of ['blocked', 'rejected', 'set_aside', ...(store.listConsumedQueueIssues ? [] : ['terminal' as const])] as const) {
    let after = 0;
    for (;;) {
      const rows = await store.listQueue(scope, status, after, 1_000);
      queue.push(...rows.filter(row => isOpenQueueIssue(row) && !options.excludeQueueOpIds?.has(row.opId)));
      if (rows.length < 1_000) break;
      after = rows.at(-1)!.sequence;
    }
  }
  if (store.listConsumedQueueIssues) queue.push(...(await store.listConsumedQueueIssues(scope)).filter(row => !options.excludeQueueOpIds?.has(row.opId)));
  const pull = (await store.listPullIssues?.(scope) ?? []).filter(issue => !issue.conflictOpIds?.length
    || !issue.conflictOpIds.every(opId => options.excludeQueueOpIds?.has(opId)));
  const local = mergeLocalIssues([...(await store.listLocalIssues?.(scope) ?? []),
    ...(await store.listOpenIngressIssues?.(scope) ?? [])]);
  const replica: BlockedPullIssue[] = [];
  if (store.listPullPages && store.listPullEventsByPage) for (const page of await store.listPullPages(scope, ['blocked'])) {
    const issue = blockedPullIssue(page, await store.listPullEventsByPage(scope, String(page.pageId)));
    if (issue) replica.push(issue);
  }
  const waits = store.listApplyIntents ? await projectNativeWaits(store as NativeWaitStore, scope) : [];
  const deletes = (await store.listRemoteDeleteDecisions?.(scope, OPEN_REMOTE_DELETE_STATES) ?? []).filter(row => row.eventId !== options.excludeDeleteEventId && !(row.state === 'restoring' && row.restoreOpId === options.resolvingRestoreOpId));
  const roots = new Set([...pull.map(row => row.nodeId), ...replica.flatMap(issue => issue.nodeIds)]);
  for (const decision of deletes) roots.add(decision.targetId);
  addQueueIssueRoots(roots, queue);
  for (const wait of waits) if (wait.colpId) roots.add(wait.colpId);
  const nativeRoots = new Set([...local.filter(ingressProtectsNode).map(row => row.nativeId), ...deletes.flatMap(row => row.nativeIds)]);
  if (nativeRoots.size && store.listMappings) for (const row of await store.listMappings(scope)) {
    if (nativeRoots.has(row.nativeId)) roots.add(row.colpId);
  }
  const bootstrap = store.listBootstrapRuns ? openBootstrapAttention(await store.listBootstrapRuns(scope), await store.listMappings?.(scope) ?? []) : [];
  const operationalTotal = deletes.length + queue.length + pull.length + local.length + waits.length + replica.length;
  return { queue, pull, local, waits, replica, deletes, roots, nativeRoots, bootstrap, operationalTotal,
    total: operationalTotal + bootstrap.length };
}

/** Parent edges include existing mappings and never-confirmed creates. */
export function issueAncestry(mappings: readonly MappingInput[], queue: readonly QueueOperation[] = []) {
  const byNative = new Map(mappings.map(row => [row.nativeId, row.colpId]));
  const parents = new Map<string, string | null>();
  for (const row of mappings) parents.set(row.colpId,
    row.parentColpId ?? (row.parentNativeId ? byNative.get(row.parentNativeId) ?? row.parentNativeId : null));
  for (const row of queue) if (row.payload.type === 'create_node') {
    const payload = row.payload.payload as { readonly parentId?: unknown };
    if (typeof payload.parentId === 'string') parents.set(`pending-${row.opId}`, payload.parentId);
  }
  return parents;
}

/** Unknown/cyclic ancestry cannot prove independence. Bound traversal even on corrupt local data. */
export function dependsOnIssue(targets: readonly string[], roots: ReadonlySet<string>,
  parents: ReadonlyMap<string, string | null>): boolean {
  if (roots.size === 0) return false;
  for (const target of targets) {
    let id: string | null = target; const seen = new Set<string>();
    for (let depth = 0; id !== null; depth++) {
      if (roots.has(id)) return true;
      if (seen.has(id) || depth >= 256) return true;
      seen.add(id);
      // An unmapped target is normal for a create. Its explicit parent is checked separately.
      if (!parents.has(id)) { if (id !== target) return true; break; }
      id = parents.get(id) ?? null;
    }
  }
  return false;
}

/** Preserve the issue closure and only its required ancestors; independent siblings stay eligible. */
export function issueProtectionIds(mappings: readonly MappingInput[], roots: ReadonlySet<string>): Set<string> {
  const parents = issueAncestry(mappings);
  const protectedIds = new Set<string>();
  for (const mapping of mappings) if (dependsOnIssue([mapping.colpId], roots, parents)) protectedIds.add(mapping.colpId);
  for (const id of [...protectedIds]) {
    let parent = parents.get(id); const seen = new Set<string>();
    for (let depth = 0; parent && depth < 256 && !seen.has(parent); depth++) {
      seen.add(parent); protectedIds.add(parent); parent = parents.get(parent);
    }
  }
  return protectedIds;
}

/** Both old placement and the complete incoming graph prove protection; each fills the other's missing ancestors. */
export function snapshotIssueProtectionIds(live: readonly MappingInput[], staged: readonly MappingInput[], roots: ReadonlySet<string>): Set<string> {
  return new Set([...issueProtectionIds([...staged, ...live], roots), ...issueProtectionIds([...live, ...staged], roots)]);
}
