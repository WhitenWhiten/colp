import type { CompleteRemoteSnapshot } from './bootstrap/remote-snapshot.js';
import { assertRejoinBoundary } from './scope-rejoin-boundary.js';
import { digestJson } from './bookmark-event-codec.js';
import type { JsonObject, MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

export interface RejoinNative { readonly title?: string; readonly url?: string; readonly parentId?: string; readonly index?: number;
  readonly type?: 'bookmark' | 'folder' | 'separator'; readonly unmodifiable?: string; readonly folderType?: string; }
export interface RejoinChrome {
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

/** Persist callback suppression before Chrome; retries compare the actual post-state before calling again. */
export async function applyRejoinMutation(input: RejoinChrome & { store: ReturnType<typeof createSyncStateStore>; scope: SyncScope },
  mapping: MappingInput, kind: 'change' | 'remove' | 'move', target: JsonObject, before: RejoinNative) {
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
  if (kind === 'change') await input.updateNative!(mapping.nativeId, target);
  else if (kind === 'remove') await input.removeNative!(mapping.nativeId, mapping.nodeKind === 'folder');
  else await input.moveNative!(mapping.nativeId, target as { parentId: string; index: number });
  await input.store.persistApplyIntentFacts(input.scope, `rejoin:${correlationId}`, { state: 'page_complete' });
}
