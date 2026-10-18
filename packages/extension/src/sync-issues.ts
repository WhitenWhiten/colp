import { mergeLocalIssues, blockedPullIssue, isOpenQueueIssue, type BlockedPullIssue } from './sync-state/open-issue-facts.js';
/** One interpretation of durable open issues, shared by sync and repair consumers. */
import { projectNativeWaits, type NativeWaitStore } from './native-wait.js';
import type { LocalIssueRecord, MappingInput, PullIssueRecord, QueueOperation, SyncScope,
  createSyncStateStore } from './sync-state-store.js';

type Store = Partial<Pick<ReturnType<typeof createSyncStateStore>,
  'listQueue' | 'listPullIssues' | 'listLocalIssues' | 'listMappings' | 'listOpenIngressIssues' | 'listPullPages' | 'listPullEventsByPage'> & NativeWaitStore>;
export interface OpenSyncIssues {
  readonly queue: readonly QueueOperation[];
  readonly pull: readonly PullIssueRecord[];
  readonly local: readonly LocalIssueRecord[];
  readonly replica: readonly BlockedPullIssue[];
  readonly waits: Awaited<ReturnType<typeof projectNativeWaits>>;
  readonly roots: ReadonlySet<string>;
  readonly nativeRoots: ReadonlySet<string>;
  readonly total: number;
}

export async function readOpenSyncIssues(store: Store, scope: SyncScope): Promise<OpenSyncIssues> {
  const queue: QueueOperation[] = [];
  if (store.listQueue) for (const status of ['blocked', 'rejected', 'set_aside'] as const) {
    let after = 0;
    for (;;) {
      const rows = await store.listQueue(scope, status, after, 1_000);
      queue.push(...rows.filter(isOpenQueueIssue));
      if (rows.length < 1_000) break;
      after = rows.at(-1)!.sequence;
    }
  }
  const pull = await store.listPullIssues?.(scope) ?? [];
  const local = mergeLocalIssues([...(await store.listLocalIssues?.(scope) ?? []),
    ...(await store.listOpenIngressIssues?.(scope) ?? [])]);
  const replica: BlockedPullIssue[] = [];
  if (store.listPullPages && store.listPullEventsByPage) for (const page of await store.listPullPages(scope, ['blocked'])) {
    const issue = blockedPullIssue(page, await store.listPullEventsByPage(scope, String(page.pageId)));
    if (issue) replica.push(issue);
  }
  const waits = store.listApplyIntents ? await projectNativeWaits(store as NativeWaitStore, scope) : [];
  const roots = new Set([...pull.map(row => row.nodeId), ...replica.flatMap(issue => issue.nodeIds)]);
  for (const row of queue) {
    if (typeof row.payload.targetId === 'string') roots.add(row.payload.targetId);
    if (row.payload.type === 'create_node') roots.add(`pending-${row.opId}`);
  }
  for (const wait of waits) if (wait.colpId) roots.add(wait.colpId);
  const nativeRoots = new Set(local.map(row => row.nativeId));
  if (nativeRoots.size && store.listMappings) for (const row of await store.listMappings(scope)) {
    if (nativeRoots.has(row.nativeId)) roots.add(row.colpId);
  }
  return { queue, pull, local, waits, replica, roots, nativeRoots,
    total: queue.length + pull.length + local.length + waits.length + replica.length };
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
