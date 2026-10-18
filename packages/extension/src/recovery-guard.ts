import { readOpenSyncIssues, issueProtectionIds } from './sync-issues.js';
import { SyncFailureError } from './sync-failure-class.js';
import { lookupBookmark } from './bookmark-api-error.js';
import { freezeScopeRecovery } from './pull-recovery-freeze.js';
import type { PullBookmarkApi } from './pull-applier.js';
import { isSpecialMountRole } from './pull-mount-apply.js';
import { virtualNativeId } from './projection-native-occupancy.js';
import { pendingLocalDeletionIds } from './recovery-local-deletes.js';
import {
  hasProjectableVirtualChildren, projectVirtualSnapshotChildren, recoverSnapshotProjection,
} from './recovery-projection-executor.js';
import type { MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = Parameters<typeof recoverSnapshotProjection>[0]['store']
  & Pick<ReturnType<typeof createSyncStateStore>, 'registerScope' | 'getEngineState' | 'transitionEngine'
    | 'hasRecoveryStaging' | 'listMountBindings' | 'putMountBinding' | 'listMappings'>;

export async function recoverVerifiedOrFreeze(input: {
  readonly scope: SyncScope; readonly store: Store; readonly staged: readonly MappingInput[];
  readonly api: PullBookmarkApi; readonly staleCursor?: boolean; readonly missingPage?: boolean;
  readonly freezeUnprovenIdentity?: boolean; readonly recoveryOnly?: boolean;
}): Promise<readonly MappingInput[]> {
  if (input.staleCursor) {
    await freezeScopeRecovery(input.store, input.scope, 'sync_cursor_expired');
    throw new SyncFailureError('sync_cursor_expired');
  }
  const exported = await input.store.exportScope(input.scope);
  const header = exported.recovery as { complete?: boolean; syncCursor?: string } | null | undefined;
  if (input.missingPage || header?.complete === false) {
    await freezeScopeRecovery(input.store, input.scope, 'snapshot_page_missing');
    throw new SyncFailureError('snapshot_page_missing');
  }
  const live = (await input.store.listMappings(input.scope)).map(stripScopeKey);
  const localDeletes = await pendingLocalDeletionIds(input.store, input.scope, [...live, ...input.staged]);
  const intents = await input.store.listProjectionIntents(input.scope);
  // Ghost Chrome ids fail closed before any cutover. Empty first-run and a second
  // replica joining a nonempty snapshot both stage virtual placeholders. Live may
  // already hold a proven native special root after mount-resolve Push; that is
  // not an identity freeze. Special folderRole mounts bind to the existing native
  // root and never invent a browser folder. Non-mount staged children then
  // Chrome-create under those native parents, parent-first. A later mount bind
  // re-enters this path with leftover virtual children even when some mappings
  // are already native.
  if (input.freezeUnprovenIdentity) {
    // A started delete can have committed in Chrome before its mapping removal
    // survived a worker restart. Only that exact native/COLP identity and
    // generation may be absent; permission and other read failures still fail.
    const deleting = new Map(intents.filter(intent => intent.kind === 'delete'
      && intent.generation === input.scope.generation && intent.nativeId !== undefined
      && (intent.state === 'executing' || intent.state === 'recovery'))
      .map(intent => [intent.nativeId!, intent.colpId]));
    for (const mapping of live) if (localDeletes.has(mapping.colpId)) deleting.set(mapping.nativeId, mapping.colpId);
    const identity = await readNativeIdentity(live, input.api, deleting);
    if (identity.state === 'unproven') for (const mapping of identity.subjects) {
      await input.store.recordLocalIssue(input.scope, { code: 'recovery_identity_unproven', nativeId: mapping.nativeId, now: Date.now() });
    }
    // SR-02: a read that never completed proves nothing about identity. Surfacing the raw API
    // message hands a genuine permission / managed / transient fault to the existing
    // permission/offline classification instead of freezing the scope on a claim no read made.
    if (identity.state === 'unreadable') throw new Error(identity.message);
  }
  const staged = input.staged.map(stripScopeKey);
  const mounts = await input.store.listMountBindings(input.scope);
  const bound = bindSnapshotMappings(staged, live, mounts);
  if (isVirtualSnapshotCutover(staged) || hasProjectableVirtualChildren(bound)
      || intents.some((intent) => intent.state !== 'terminal')) {
    for (const mapping of staged) {
      const mount = matchStagedMount(mounts, mapping);
      if (!mount || mount.status === 'detached' || mount.remoteMountNodeId === mapping.colpId) continue;
      const { scopeKey: _key, ...binding } = mount as MountBindingRecord & { readonly scopeKey?: string };
      await input.store.putMountBinding(input.scope, { ...binding, remoteMountNodeId: mapping.colpId });
    }
    return projectVirtualSnapshotChildren({
      scope: input.scope, store: input.store, api: input.api, bound, snapshotCursor: header?.syncCursor, recoveryOnly: input.recoveryOnly,
    });
  }
  return recoverSnapshotProjection({
    scope: input.scope, store: input.store, staged, api: input.api,
    allowTitleUrlIdentityGuess: false, recoveryOnly: input.recoveryOnly,
  });
}

export async function leftoverVirtualChildrenNeedReproject(store: Pick<Store, 'listMappings' | 'listMountBindings'>,
  scope: SyncScope): Promise<boolean> {
  const [live, mounts] = await Promise.all([store.listMappings(scope), store.listMountBindings(scope)]);
  // A remote-only subtree has no Chrome parent. It is durable sidecar state,
  // not pending native work. Account for mounts bound after Snapshot cutover.
  return hasProjectableVirtualChildren(bindSnapshotMappings(live, live, mounts),
    issueProtectionIds(live, (await readOpenSyncIssues(store, scope)).roots));
}

function stripScopeKey(mapping: MappingInput): MappingInput {
  const { scopeKey: _scopeKey, ...row } = mapping as MappingInput & { readonly scopeKey?: string };
  return row;
}

function isVirtualSnapshotCutover(staged: readonly MappingInput[]): boolean {
  return staged.length > 0 && staged.every((mapping) => virtualNativeId(mapping.nativeId));
}

// Scheduling and execution must classify the same bound graph. In a nonempty
// merge, local natives can coexist with virtual mount/remote-child mappings.
function bindSnapshotMappings(staged: readonly MappingInput[], live: readonly MappingInput[],
  mounts: readonly MountBindingRecord[]): readonly MappingInput[] {
  const liveByColp = new Map(live.map((mapping) => [mapping.colpId, mapping]));
  const projected: MappingInput[] = [];
  for (const mapping of staged) {
    if (mapping.quarantine) { projected.push(mapping); continue; }
    const mount = matchStagedMount(mounts, mapping);
    const liveHit = liveByColp.get(mapping.colpId);
    const nativeRoot = mount && mount.status !== 'detached' ? mount.nativeRootId
      : liveHit && !virtualNativeId(liveHit.nativeId) ? liveHit.nativeId : undefined;
    if (!nativeRoot) { projected.push(mapping); continue; }
    projected.push({
      ...mapping, nativeId: nativeRoot, rootNativeId: nativeRoot,
      ...(mount?.mountId || liveHit?.mountId ? { mountId: mount?.mountId ?? liveHit?.mountId } : {}),
      ...(mount?.rootRole || liveHit?.rootRole ? { rootRole: mount?.rootRole ?? liveHit?.rootRole } : {}),
    });
  }
  return projected;
}

function folderRoleOf(mapping: MappingInput): string | undefined {
  if (mapping.rootRole) return mapping.rootRole;
  const role = mapping.projection.content?.folderRole;
  return typeof role === 'string' ? role : undefined;
}

function matchStagedMount(mounts: readonly MountBindingRecord[], mapping: MappingInput) {
  const role = folderRoleOf(mapping);
  if (isSpecialMountRole(role)) return mounts.find((mount) => mount.rootRole === role);
  if (role === 'custom') {
    // Native folder keys belong to one replica. A Snapshot from another
    // replica cannot claim our custom root with an equal local key.
    return mounts.find((mount) => mount.remoteMountNodeId === mapping.colpId);
  }
  return mounts.find((mount) => mount.remoteMountNodeId === mapping.colpId);
}

/** Fresh reads distinguish a concrete missing/ambiguous identity from API access failures. */
type NativeIdentityRead =
  | { readonly state: 'proven' }
  | { readonly state: 'unproven'; readonly subjects: readonly MappingInput[] }
  | { readonly state: 'unreadable'; readonly message: string };

export async function readNativeIdentity(live: readonly MappingInput[], api: Pick<PullBookmarkApi, 'get'>,
  deleting: ReadonlyMap<string, string>): Promise<NativeIdentityRead> {
  const subjects: MappingInput[] = [];
  for (const mapping of live) {
    if (virtualNativeId(mapping.nativeId)) continue;
    const looked = await lookupBookmark((nativeId) => api.get(nativeId), mapping.nativeId);
    if (looked.class === 'present') {
      if (looked.nodes.length !== 1 || looked.nodes[0]?.id !== mapping.nativeId) subjects.push(mapping);
      continue;
    }
    if (looked.class === 'not_found' && deleting.get(mapping.nativeId) === mapping.colpId) continue;
    if (looked.class === 'not_found') { subjects.push(mapping); continue; }
    return { state: 'unreadable', message: looked.message };
  }
  return subjects.length ? { state: 'unproven', subjects } : { state: 'proven' };
}

/** Issue-held native work keeps its original recovery record without claiming ownership of the whole scope. */
export async function unprotectedProjectionIntents(store: Pick<Store, 'listMappings' | 'listProjectionIntents'>, scope: SyncScope) {
  const [mappings, intents, issues] = await Promise.all([store.listMappings(scope), store.listProjectionIntents(scope), readOpenSyncIssues(store, scope)]);
  const protectedIds = issueProtectionIds(mappings, issues.roots);
  return intents.filter(intent => intent.state !== 'terminal' && !protectedIds.has(intent.colpId) && !issues.roots.has(intent.colpId));
}
