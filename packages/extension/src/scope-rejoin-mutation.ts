import type { CompleteRemoteSnapshot } from './bootstrap/remote-snapshot.js';
import { assertRejoinBoundary } from './scope-rejoin-boundary.js';
import { rejoinBoundaryDigest } from './scope-rejoin-authority.js';
import { exclusionEvidenceDigest, mappingEvidenceDigest, type RejoinMutationAuthority } from './sync-state/rejoin-decision-repository.js';
import { digestJson } from './bookmark-event-codec.js';
import type { JsonObject, MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

export interface RejoinNative { readonly title?: string; readonly url?: string; readonly parentId?: string; readonly index?: number;
  readonly type?: 'bookmark' | 'folder' | 'separator'; readonly unmodifiable?: string; readonly folderType?: string; }
export interface RejoinChrome {
  readonly expectedRejoinBoundary?: string;
  readonly readRemoteSnapshot?: () => Promise<CompleteRemoteSnapshot>;
  readonly admittedNativeRootIds?: readonly string[];
  readonly crash?: (boundary: string) => void;
  readonly getNative: (id: string) => Promise<RejoinNative | undefined>;
  readonly getChildren?: (id: string) => Promise<readonly (RejoinNative & { readonly id: string })[]>;
  readonly updateNative?: (id: string, changes: { title?: string; url?: string }) => Promise<unknown>;
  readonly removeNative?: (id: string, tree: boolean) => Promise<unknown>;
  readonly moveNative?: (id: string, placement: { parentId: string; index: number }) => Promise<unknown>;
  readonly createNative?: (input: { parentId: string; index?: number; title?: string; url?: string }) => Promise<{ readonly id: string }>;
}
type MutationInput = RejoinChrome & { store: ReturnType<typeof createSyncStateStore>; scope: SyncScope; mount: MountBindingRecord };

export async function rejoinMutationAuthority(input: MutationInput, mapping: MappingInput,
  destination?: string): Promise<RejoinMutationAuthority> {
  const recorded = await input.store.getScope(input.scope);
  const boundaryDigest = input.expectedRejoinBoundary ?? rejoinBoundaryDigest(recorded);
  const current = await input.store.getMappingByNativeId(input.scope, mapping.nativeId);
  if (!current || mappingEvidenceDigest(current) !== mappingEvidenceDigest(mapping)
    || rejoinBoundaryDigest(recorded) !== boundaryDigest) throw new Error('rejoin_boundary_changed');
  const parents: MappingInput[] = [];
  for (const id of new Set([input.mount.nativeRootId, mapping.parentNativeId, destination])) {
    if (!id || id === mapping.nativeId) continue;
    const parent = await input.store.getMappingByNativeId(input.scope, id);
    if (!parent) throw new Error('rejoin_boundary_changed');
    parents.push(parent);
  }
  return { before: mapping, mount: input.mount, parents, boundaryDigest,
    exclusionDigest: exclusionEvidenceDigest(await input.store.listLocalSyncExclusions(input.scope)) };
}

export function rejoinNativeDigest(value: RejoinNative): string {
  return digestJson({ title: value.title ?? null, url: value.url ?? null, parentId: value.parentId ?? null,
    index: value.index ?? null, type: value.type ?? null, unmodifiable: value.unmodifiable ?? null, folderType: value.folderType ?? null });
}

/** Persist callback suppression before Chrome; retries compare the actual post-state before calling again. */
export async function applyRejoinMutation(input: MutationInput,
  mapping: MappingInput, kind: 'change' | 'remove' | 'move', target: JsonObject, before: RejoinNative,
  beforeNative?: () => Promise<void>) {
  const authority = await rejoinMutationAuthority(input, mapping, kind === 'move' ? String(target.parentId) : undefined);
  const details = kind === 'remove' ? { parentId: before.parentId ?? '', index: before.index ?? 0 }
    : kind === 'move' ? { ...target, oldParentId: before.parentId ?? '', oldIndex: before.index ?? 0 } : target;
  const correlationId = digestJson({ kind, nativeId: mapping.nativeId, details });
  if (!await input.store.findApplyIntent(input.scope, correlationId)) {
    await input.store.createApplyIntent(input.scope, { intentId: `rejoin:${correlationId}`, correlationId,
      operationId: `rejoin:${correlationId}`, expected: { kind, nativeId: mapping.nativeId },
      liveWorkKind: 'rejoin', colpId: mapping.colpId,
      state: 'browser_call_started', nativeTargetId: mapping.nativeId, generation: input.scope.generation,
      expiresAt: Date.now() + 300_000, preStateDigest: digestJson({ ...before }),
      expectedPostState: { digest: digestJson(target), ...(kind === 'change' ? { nativeContent: target } : {}) } });
  }
  input.crash?.('after_rejoin_intent');
  await assertRejoinBoundary(input, mapping);
  if (kind === 'move') await assertRejoinBoundary(input, mapping, { parentNativeId: String(target.parentId) });
  // Preserve the actionable order-conflict classification when a user has
  // already reordered; the same fingerprint is checked again below.
  await beforeNative?.();
  const current = await input.getNative(mapping.nativeId);
  if (!current || rejoinNativeDigest(current) !== rejoinNativeDigest(before)) throw new Error('rejoin_boundary_changed');
  await input.store.assertRejoinMutation(input.scope, authority);
  // Order operations carry a full sibling fingerprint, which must be the final
  // native check rather than a preflight invalidated by our own async reads.
  await beforeNative?.();
  if (kind === 'change') await input.updateNative!(mapping.nativeId, target);
  else if (kind === 'remove') await input.removeNative!(mapping.nativeId, mapping.nodeKind === 'folder');
  else await input.moveNative!(mapping.nativeId, target as { parentId: string; index: number });
  await input.store.persistApplyIntentFacts(input.scope, `rejoin:${correlationId}`, { state: 'page_complete' });
  return authority;
}
