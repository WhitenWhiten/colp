import { SyncFailureError } from './sync-failure-class.js';
/**
 * Per-member remote delete. Completed members replay; missing parents do not
 * prove descendants absent. Permission/managed stay failed, never absent.
 */
import {
  lookupBookmark, lookupBookmarkChildren, type BookmarkLookup, type BookmarkNode,
} from './bookmark-api-error.js';
import { readOpenSyncIssues, issueAncestry, dependsOnIssue } from './sync-issues.js';
import { nativeContent } from './pull-projection.js';
import { unqueuedNativeContentFields } from './pull-native-content-barrier.js';
import { classifyNativeCallFacts } from './native-call-result.js';
import type { PullBookmarkApi } from './pull-applier-types.js';
import { isNonChromeNativeId, isProtectedNativeRoot, mayMutateNative } from './pull-mount-apply.js';
import { nativeIsLocallyExcluded } from './remote-delete-exclusion.js';
import type { ApplyIntentFactsPatch } from './sync-state/intent-facts-repository.js';
import type {
  IntentRecord, JsonObject, MappingInput, MountBindingRecord, SyncScope, createSyncStateStore,
} from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>,
  'getApplyIntent' | 'persistApplyIntentFacts' | 'getMappingByNativeId' | 'getLocalSyncExclusion' | 'listQueue' | 'listPullIssues' | 'listLocalIssues' | 'listMappings'
  | 'listApplyIntents' | 'getPullEvent'>;

export type DeleteMemberResult = 'not_started' | 'applied' | 'absent' | 'retained' | 'protected' | 'failed';

export interface DeleteMember {
  readonly colpId: string;
  readonly nativeId: string;
}

export interface RemoteDeleteMemberOutcome {
  readonly members: readonly DeleteMember[];
  readonly results: Readonly<Record<string, DeleteMemberResult>>;
  readonly deletedNativeIds: readonly string[];
  readonly retainedNativeIds: readonly string[];
  readonly protectedNativeIds: readonly string[];
}

const TERMINAL: ReadonlySet<string> = new Set(['applied', 'absent', 'retained', 'protected']);

/** Delete has fixed member identities; its receipt is the whole member ledger,
 * not a newly returned native id as for create. Partial/invalid ledgers prove nothing. */
export function hasTerminalDeleteEvidence(intent: Pick<IntentRecord, 'liveWorkKind' | 'anchors'>): boolean {
  const raw = intent.anchors?.deleteMemberSet; const ledger = readDeleteAnchors(intent.anchors);
  return intent.liveWorkKind === 'delete' && Array.isArray(raw) && ledger !== null
    && ledger.members.length === raw.length
    && new Set(ledger.members.map(row => row.colpId)).size === ledger.members.length
    && new Set(ledger.members.map(row => row.nativeId)).size === ledger.members.length
    && ledger.members.every(row => TERMINAL.has(ledger.results[row.colpId] ?? ''));
}

export async function executeRemoteDeleteMembers(input: {
  readonly store: Store;
  readonly scope: SyncScope;
  readonly api: PullBookmarkApi;
  readonly mounts: readonly MountBindingRecord[];
  readonly intentId: string;
  readonly members: readonly DeleteMember[];
  readonly mappings: readonly MappingInput[];
  readonly writable: boolean;
  readonly crash?: (boundary: string) => void;
}): Promise<RemoteDeleteMemberOutcome> {
  const frozen = await persistMemberSet(input);
  const results = { ...frozen.results };
  const memberNative = new Set(frozen.members.map((row) => row.nativeId));
  const byNative = new Map(frozen.members.map((row) => [row.nativeId, row]));
  const mappingByNative = new Map(input.mappings.map((row) => [row.nativeId, row]));
  if (!input.writable) {
    for (const row of frozen.members) {
      if (TERMINAL.has(results[row.colpId] ?? '')) continue;
      if (isProtectedNativeRoot(row.nativeId, input.mounts)) results[row.colpId] = 'protected';
      else if (isNonChromeNativeId(row.nativeId)) results[row.colpId] = 'absent';
    }
    await writeResults(input, frozen.members, results);
    return summarize(frozen.members, results);
  }
  const order = await orderMembers(input.api, frozen.members, results);
  const issues = await readOpenSyncIssues(input.store, input.scope);
  const ancestry = issueAncestry(await input.store.listMappings(input.scope), issues.queue);
  for (const row of order) {
    const prior = results[row.colpId];
    if (prior && TERMINAL.has(prior)) continue;
    if (isNonChromeNativeId(row.nativeId)) { results[row.colpId] = 'absent'; continue; }
    // G4: a bookmark with a change set aside on this browser is never deleted for
    // the server; it stays in place, outside sync, and its folder stays with it.
    if (issues.nativeRoots.has(row.nativeId) || dependsOnIssue([row.colpId], issues.roots, ancestry)) {
      results[row.colpId] = 'retained';
      await writeResults(input, frozen.members, results);
      continue;
    }
    const mapping = mappingByNative.get(row.nativeId);
    if (isProtectedNativeRoot(row.nativeId, input.mounts)
      || (mapping !== undefined && !mayMutateNative(mapping, input.mounts))) {
      results[row.colpId] = 'protected';
      await writeResults(input, frozen.members, results);
      continue;
    }
    const looked = await lookupBookmark((id) => input.api.get(id), row.nativeId);
    const classified = classifyLookup(looked);
    if (classified === 'failed') {
      results[row.colpId] = 'failed';
      await writeResults(input, frozen.members, results, 'failed');
      throw deleteFailure(looked);
    }
    if (classified === 'absent') {
      results[row.colpId] = 'absent';
      await writeResults(input, frozen.members, results);
      continue;
    }
    // Persist the complete local preimage before any destructive Chrome call.
    // Uncaptured changes stay native and follow the existing retained/exclusion path.
    const current = looked.class === 'present' ? looked.nodes[0] : undefined;
    if (!current) throw new SyncFailureError('native_call_failed');
    const intent = await input.store.getApplyIntent(input.scope, input.intentId);
    if (!intent) throw new SyncFailureError('intent_not_found');
    const priorImages = intent.anchors?.deletePreimages;
    await patchIntent(input, { anchors: { ...intent.anchors,
      deletePreimages: { ...(priorImages && typeof priorImages === 'object' && !Array.isArray(priorImages)
        ? priorImages : {}), [row.colpId]: { nativeId: row.nativeId, colpId: row.colpId,
        title: current.title ?? '', ...(current.url === undefined ? {} : { url: current.url }),
        ...(current.parentId === undefined ? {} : { parentId: current.parentId }) } },
    } });
    if (!mapping || Object.keys(unqueuedNativeContentFields(current,
      nativeContent(mapping.projection.content ?? {}), {})).length > 0) {
      results[row.colpId] = 'retained';
      await writeResults(input, frozen.members, results);
      continue;
    }
    if (mapping?.nodeKind === 'folder'
      && await shouldRetain(input, row.nativeId, memberNative, byNative, results)) {
      results[row.colpId] = 'retained';
      await writeResults(input, frozen.members, results);
      continue;
    }
    // IndexedDB persistence and folder checks yield to browser edits. Re-read
    // after those barriers; never remove a node whose saved preimage is stale.
    const fresh = await lookupBookmark((id) => input.api.get(id), row.nativeId);
    if (fresh.class === 'not_found') {
      results[row.colpId] = 'absent';
      await writeResults(input, frozen.members, results);
      continue;
    }
    if (fresh.class !== 'present') throw deleteFailure(fresh);
    const latest = fresh.nodes[0];
    if (!latest) throw new SyncFailureError('native_call_failed');
    if (latest.title !== current.title || latest.url !== current.url || latest.parentId !== current.parentId) {
      results[row.colpId] = 'retained';
      await writeResults(input, frozen.members, results);
      continue;
    }
    try {
      await removeMember(input.api, latest);
    } catch (error) {
      // Chrome's non-recursive remove owns the atomic non-empty check. A new
      // child arriving after shouldRetain must never expand the authorized set.
      if (mapping?.nodeKind !== 'folder' || !(error instanceof Error)
          || !/non-empty folder/iu.test(error.message)) throw error;
      const children = await lookupBookmarkChildren((id) => input.api.getChildren(id), row.nativeId);
      if (children.class !== 'present' || children.nodes.length === 0) throw error;
      results[row.colpId] = 'retained';
      await writeResults(input, frozen.members, results);
      continue;
    }
    results[row.colpId] = 'applied';
    await writeResults(input, frozen.members, results);
    input.crash?.('after_delete_member');
  }
  return summarize(frozen.members, results);
}

export async function collectRetainedNativeIds(api: PullBookmarkApi, roots: readonly string[],
  skip: ReadonlySet<string>): Promise<string[]> {
  const found = new Set<string>();
  for (const root of roots) {
    await walkRemaining(api, root, skip, found);
  }
  return [...found];
}

async function walkRemaining(api: PullBookmarkApi, nativeId: string, skip: ReadonlySet<string>,
  found: Set<string>): Promise<void> {
  if (found.has(nativeId) || skip.has(nativeId)) return;
  const looked = await lookupBookmark((id) => api.get(id), nativeId);
  if (looked.class !== 'present') return;
  found.add(nativeId);
  const children = await lookupBookmarkChildren((id) => api.getChildren(id), nativeId);
  if (children.class !== 'present') return;
  for (const child of children.nodes) await walkRemaining(api, child.id, skip, found);
}

function classifyLookup(looked: BookmarkLookup): 'present' | 'absent' | 'failed' {
  if (looked.class === 'present') return 'present';
  const failed = looked.class === 'permission_denied' || looked.class === 'managed_not_writable'
    || looked.class === 'other_failure';
  return classifyNativeCallFacts({
    intentExists: true, callStarted: true, nativeEventCorrelationOnly: false,
    deleteTargetProvenAbsent: looked.class === 'not_found',
    permissionOrManagedOrOtherError: failed, waitingDependency: false,
  }) === 'absent' ? 'absent' : 'failed';
}

async function removeMember(api: PullBookmarkApi, node: BookmarkNode | undefined):
  Promise<void> {
  if (node?.unmodifiable) throw new Error("Can't modify a managed bookmark.");
  if (!node) throw new SyncFailureError('native_call_failed');
  await api.remove(node.id);
}

function deleteFailure(looked: BookmarkLookup): Error {
  if (looked.class === 'permission_denied' || looked.class === 'managed_not_writable'
    || looked.class === 'other_failure') {
    return new Error(looked.message);
  }
  return new SyncFailureError('native_call_failed');
}

async function shouldRetain(input: {
  readonly store: Store; readonly scope: SyncScope; readonly api: PullBookmarkApi;
}, nativeId: string, memberNative: ReadonlySet<string>,
  byNative: ReadonlyMap<string, DeleteMember>,
  results: Readonly<Record<string, DeleteMemberResult>>): Promise<boolean> {
  const children = await lookupBookmarkChildren((id) => input.api.getChildren(id), nativeId);
  if (children.class === 'not_found') return false;
  if (children.class !== 'present') throw new Error(children.message);
  for (const child of children.nodes) {
    if (!memberNative.has(child.id)) return true;
    const member = byNative.get(child.id);
    if (member && results[member.colpId] === 'retained') return true;
    if (await nativeIsLocallyExcluded(input.store, input.scope, child.id)) return true;
    const mapping = await input.store.getMappingByNativeId(input.scope, child.id);
    if (!mapping && !memberNative.has(child.id)) return true;
    if (mapping && !member) return true;
  }
  return false;
}

async function orderMembers(api: PullBookmarkApi, members: readonly DeleteMember[],
  results: Readonly<Record<string, DeleteMemberResult>>): Promise<DeleteMember[]> {
  const remaining = members.filter((row) => !TERMINAL.has(results[row.colpId] ?? ''));
  const nativeOrder: string[] = [];
  const seen = new Set<string>();
  const visit = async (nativeId: string): Promise<void> => {
    if (seen.has(nativeId)) return;
    seen.add(nativeId);
    const children = await lookupBookmarkChildren((id) => api.getChildren(id), nativeId);
    if (children.class === 'present') {
      for (const child of children.nodes) await visit(child.id);
    }
    nativeOrder.push(nativeId);
  };
  for (const row of remaining) await visit(row.nativeId);
  const rank = new Map(nativeOrder.map((id, index) => [id, index]));
  return [...remaining].sort((left, right) =>
    (rank.get(left.nativeId) ?? 1_000_000) - (rank.get(right.nativeId) ?? 1_000_000));
}

async function persistMemberSet(input: {
  readonly store: Store; readonly scope: SyncScope; readonly intentId: string;
  readonly members: readonly DeleteMember[];
}): Promise<{ members: readonly DeleteMember[]; results: Record<string, DeleteMemberResult> }> {
  const intent = await input.store.getApplyIntent(input.scope, input.intentId);
  const stored = readDeleteAnchors(intent?.anchors);
  if (stored) return stored;
  const results: Record<string, DeleteMemberResult> = {};
  for (const row of input.members) results[row.colpId] = 'not_started';
  await patchIntent(input, {
    liveWorkKind: 'delete', replayState: 'started', nativeResult: 'not_started',
    anchors: deleteAnchors(input.members, results),
  });
  return { members: input.members, results };
}

async function writeResults(input: {
  readonly store: Store; readonly scope: SyncScope; readonly intentId: string;
}, members: readonly DeleteMember[], results: Record<string, DeleteMemberResult>,
  nativeResult?: 'failed' | 'absent' | 'applied_with_evidence'): Promise<void> {
  const allDone = members.every((row) => TERMINAL.has(results[row.colpId] ?? ''));
  const anyFailed = members.some((row) => results[row.colpId] === 'failed');
  await patchIntent(input, {
    liveWorkKind: 'delete',
    anchors: deleteAnchors(members, results),
    nativeResult: nativeResult ?? (anyFailed ? 'failed' : allDone ? 'applied_with_evidence' : 'not_started'),
    replayState: allDone ? 'awaiting_receipt' : 'started',
    ...(nativeResult === 'failed' ? { nativeResultConfirmation: { kind: 'failed' as const, code: 'permission_denied' } }
      : {}),
  });
}

async function patchIntent(input: {
  readonly store: Store; readonly scope: SyncScope; readonly intentId: string;
}, facts: ApplyIntentFactsPatch): Promise<void> {
  const intent = await input.store.getApplyIntent(input.scope, input.intentId);
  if (!intent) throw new SyncFailureError('intent_not_found');
  await input.store.persistApplyIntentFacts(input.scope, input.intentId, { ...facts,
    ...(facts.anchors ? { anchors: { ...intent.anchors, ...facts.anchors } } : {}),
  });
}

function summarize(members: readonly DeleteMember[],
  results: Record<string, DeleteMemberResult>): RemoteDeleteMemberOutcome {
  const deletedNativeIds: string[] = [];
  const retainedNativeIds: string[] = [];
  const protectedNativeIds: string[] = [];
  for (const row of members) {
    if (results[row.colpId] === 'applied' || results[row.colpId] === 'absent') {
      deletedNativeIds.push(row.nativeId);
    }
    if (results[row.colpId] === 'retained') retainedNativeIds.push(row.nativeId);
    if (results[row.colpId] === 'protected') protectedNativeIds.push(row.nativeId);
  }
  return { members, results, deletedNativeIds, retainedNativeIds, protectedNativeIds };
}

function deleteAnchors(members: readonly DeleteMember[],
  results: Record<string, DeleteMemberResult>): JsonObject {
  return {
    deleteMemberSet: members.map((row) => ({ colpId: row.colpId, nativeId: row.nativeId })),
    deleteMemberResults: { ...results },
  };
}

function readDeleteAnchors(anchors: JsonObject | undefined): {
  members: DeleteMember[]; results: Record<string, DeleteMemberResult>;
} | null {
  const set = anchors?.deleteMemberSet;
  if (!Array.isArray(set) || set.length === 0) return null;
  const members: DeleteMember[] = [];
  for (const row of set) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const colpId = row.colpId; const nativeId = row.nativeId;
    if (typeof colpId !== 'string' || typeof nativeId !== 'string') continue;
    members.push({ colpId, nativeId });
  }
  if (!members.length) return null;
  const raw = anchors?.deleteMemberResults;
  const results: Record<string, DeleteMemberResult> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [colpId, value] of Object.entries(raw)) {
      if (typeof value === 'string') results[colpId] = value as DeleteMemberResult;
    }
  }
  return { members, results };
}

