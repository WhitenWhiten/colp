import { withinPrivateNativeBoundary } from './native-private-boundary.js';
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
import type { DeleteMemberResult } from './sync-state/delete-member-repository.js';
export type { DeleteMemberResult } from './sync-state/delete-member-repository.js';
import type {
  IntentRecord, JsonObject, MappingInput, MountBindingRecord, SyncScope, createSyncStateStore,
} from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>,
  'getApplyIntent' | 'getMappingByNativeId' | 'getLocalSyncExclusion' | 'listQueue' | 'listPullIssues' | 'listLocalIssues' | 'listMappings'
  | 'prepareDeleteMembers' | 'saveDeleteMember' | 'listRemoteDeleteDecisions' | 'listApplyIntents' | 'getPullEvent' | 'getScope' | 'getMappingByColpId'>;

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
  const counts = intent.anchors?.deleteJournal as JsonObject | undefined;
  if (counts) return intent.liveWorkKind === 'delete' && Number.isSafeInteger(counts.memberCount)
    && Number(counts.memberCount) > 0 && counts.terminalCount === counts.memberCount && counts.failedCount === 0;
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
  const journal = await input.store.prepareDeleteMembers(input.scope, input.intentId, input.members);
  const frozen = { members: journal.map(({ colpId, nativeId }) => ({ colpId, nativeId })) };
  const results = Object.fromEntries(journal.map(row => [row.colpId, row.result]));
  const saveResult = async (row: DeleteMember, result: DeleteMemberResult) => {
    await input.store.saveDeleteMember(input.scope, input.intentId, row.colpId, { result });
    results[row.colpId] = result;
  };
  const memberNative = new Set(frozen.members.map((row) => row.nativeId));
  const byNative = new Map(frozen.members.map((row) => [row.nativeId, row]));
  const mappingByNative = new Map(input.mappings.map((row) => [row.nativeId, row]));
  if (!input.writable) {
    for (const row of frozen.members) {
      if (TERMINAL.has(results[row.colpId] ?? '')) continue;
      if (isProtectedNativeRoot(row.nativeId, input.mounts)) await saveResult(row, 'protected');
      else if (isNonChromeNativeId(row.nativeId)) await saveResult(row, 'absent');
    }
    return summarize(frozen.members, results);
  }
  const order = await orderMembers(input.api, frozen.members, results);
  const intent = await input.store.getApplyIntent(input.scope, input.intentId);
  const issues = await readOpenSyncIssues(input.store, input.scope, { excludeDeleteEventId: intent?.eventId });
  const privateRoots = (await input.store.getScope(input.scope))?.privateRoots ?? [];
  const ancestry = issueAncestry([...await input.store.listMappings(input.scope), ...input.mappings], issues.queue);
  for (const row of order) {
    const prior = results[row.colpId];
    if (prior && TERMINAL.has(prior)) continue;
    if (isNonChromeNativeId(row.nativeId)) { await saveResult(row, 'absent'); continue; }
    // G4: a bookmark with a change set aside on this browser is never deleted for
    // the server; it stays in place, outside sync, and its folder stays with it.
    if (issues.nativeRoots.has(row.nativeId) || dependsOnIssue([row.colpId], issues.roots, ancestry)) {
      await saveResult(row, 'retained');
      continue;
    }
    const mapping = mappingByNative.get(row.nativeId);
    if (mapping && privateRoots.length > 0) {
      const current = await lookupBookmark(id => input.api.get(id), row.nativeId);
      if (current.class === 'present' && await withinPrivateNativeBoundary({ store: input.store, scope: input.scope,
        mapping, privateRoots, lookup: id => lookupBookmark(native => input.api.get(native), id) })) {
        await saveResult(row, 'protected'); continue;
      }
      if (current.class !== 'present' && current.class !== 'not_found') throw deleteFailure(current);
    }
    if (isProtectedNativeRoot(row.nativeId, input.mounts)
      || (mapping !== undefined && !mayMutateNative(mapping, input.mounts))) {
      await saveResult(row, 'protected');
      continue;
    }
    const looked = await lookupBookmark((id) => input.api.get(id), row.nativeId);
    const classified = classifyLookup(looked);
    if (classified === 'failed') {
      await saveResult(row, 'failed');
      throw deleteFailure(looked);
    }
    if (classified === 'absent') {
      await saveResult(row, 'absent');
      continue;
    }
    // Persist the complete local preimage before any destructive Chrome call.
    // Uncaptured changes stay native and follow the existing retained/exclusion path.
    const current = looked.class === 'present' ? looked.nodes[0] : undefined;
    if (!current) throw new SyncFailureError('native_call_failed');
    await input.store.saveDeleteMember(input.scope, input.intentId, row.colpId, { preimage: {
      nativeId: row.nativeId, colpId: row.colpId, title: current.title ?? '',
      ...(current.url === undefined ? {} : { url: current.url }),
      ...(current.parentId === undefined ? {} : { parentId: current.parentId }),
    } });
    if (!mapping || Object.keys(unqueuedNativeContentFields(current,
      nativeContent(mapping.projection.content ?? {}), {})).length > 0) {
      await saveResult(row, 'retained');
      continue;
    }
    if (mapping?.nodeKind === 'folder'
      && await shouldRetain(input, row.nativeId, memberNative, byNative, results)) {
      await saveResult(row, 'retained');
      continue;
    }
    // IndexedDB persistence and folder checks yield to browser edits. Re-read
    // after those barriers; never remove a node whose saved preimage is stale.
    const fresh = await lookupBookmark((id) => input.api.get(id), row.nativeId);
    if (fresh.class === 'not_found') {
      await saveResult(row, 'absent');
      continue;
    }
    if (fresh.class !== 'present') throw deleteFailure(fresh);
    const latest = fresh.nodes[0];
    if (!latest) throw new SyncFailureError('native_call_failed');
    if (latest.title !== current.title || latest.url !== current.url || latest.parentId !== current.parentId) {
      await saveResult(row, 'retained');
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
      await saveResult(row, 'retained');
      continue;
    }
    await saveResult(row, 'applied');
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

