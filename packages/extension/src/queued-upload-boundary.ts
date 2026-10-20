import { assertRejoinDeleteUpload } from './scope-rejoin-upload.js';
import { assertBootstrapUploadAllowed } from './bootstrap/upload-boundary.js';
import { mountResolveOpIdMatches } from './bootstrap/run-identity.js';
import { classifyBookmarkApiFailure } from './bookmark-api-error.js';
import { digestJson, plannedCreateNativeId } from './bookmark-event-codec.js';
import { resolveIngressBoundary } from './bookmark-event-ingress.js';
import { localRemovalCoversNative } from './local-create-successor.js';
import { boundNativeId, isNonChromeNativeId } from './pull-mount-apply.js';
import type { BookmarkEventRecord, JsonObject, QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;
export class QueuedUploadExcludedError extends Error {
  readonly code = 'queued_upload_excluded';
  constructor(readonly reason: 'private_local' | 'unselected_range') { super('queued_upload_excluded'); }
}

/** Every native producer must obey the live boundary, including already durable drafts. */
export async function assertQueuedUploadAllowed(input: {
  readonly store: Store; readonly scope: SyncScope; readonly queue: QueueOperation;
  readonly parentOf: (nativeId: string) => Promise<string | undefined>;
}): Promise<void> {
  const { store, scope, queue } = input;
  const payload = object(queue.payload.payload);
  // These are separately confirmed cloud commands, not native-content uploads.
  if ((['delete_node', 'delete_subtree'].includes(String(queue.payload.type)) && payload?.reason === 'scope_remote_delete')
      || (queue.payload.type === 'restore_node' && payload?.reason === 'remote_delete_restore')) return;
  if (['delete_node', 'delete_subtree'].includes(String(queue.payload.type)) && payload?.reason === 'rejoin_local_delete') {
    await assertRejoinDeleteUpload(input); return;
  }
  await assertBootstrapUploadAllowed(input);
  const recorded = await store.getScope(scope);
  if (recorded?.rootStatus !== 'ready' && recorded?.rootStatus !== 'nested_normalized') throw new Error('upload_boundary_unavailable');
  for (const id of recorded.privateRoots ?? []) {
    if (!await store.getMappingByColpId(scope, id)) throw new Error('upload_boundary_unavailable');
  }
  const boundary = await resolveIngressBoundary(store, scope);
  const mounts = await store.listMountBindings(scope);
  const sources = new Set<string>();
  const events: BookmarkEventRecord[] = [];
  const original = await store.getBookmarkEvent(scope, queue.opId);
  if (original) events.push(original);
  for (let after = 0;;) {
    const page = await store.listBookmarkEventsByOperation(scope, queue.opId, after, 1_000);
    events.push(...page);
    if (page.length < 1_000) break;
    after = page.at(-1)!.ordinal;
  }
  for (const event of events) sources.add(event.nativeId);
  const planned = plannedCreateNativeId(queue.opId);
  if (planned) sources.add(planned);
  for (const id of [`pending-${queue.opId}`, queue.payload.targetId, payload?.parentId, payload?.newParentId]) {
    if (typeof id !== 'string') continue;
    const mapped = await store.getMappingByColpId(scope, id);
    if (mapped) {
      const nativeId = boundNativeId(mapped, mounts);
      if (!isNonChromeNativeId(nativeId)) sources.add(nativeId);
    }
  }
  const role = object(payload?.node)?.folderRole;
  if (queue.payload.type === 'create_node' && typeof role === 'string') {
    for (const mount of mounts) if (mount.rootRole === role
        || role === 'custom' && mount.customSourceKey && mountResolveOpIdMatches(queue.opId, mount.customSourceKey)) sources.add(mount.nativeRootId);
  }
  // Advanced plans have no ordinary inbox row. Recover their immutable native
  // provenance instead of treating a still-selected destination as consent to
  // upload a source that the user has since moved outside the range.
  if (queue.opId.startsWith('ab.')) {
    let proven = false;
    for (const plan of await store.listAdvancedPlans(scope)) {
      const saved = await store.readAdvancedPlan(scope, plan.planId);
      for (const step of saved?.steps ?? []) {
        const stepId = step.definition.stepId;
        if (typeof stepId !== 'string' || `ab.${digestJson({ planId: plan.planId, stepId }).slice(7)}` !== queue.opId) continue;
        const source = object(step.definition.action === 'create' ? step.definition.source : step.definition.target);
        if (typeof source?.nativeId === 'string') { sources.add(source.nativeId); proven = true; }
      }
    }
    if (!proven) throw new Error('upload_boundary_unavailable');
  }
  if (sources.size === 0) throw new Error('upload_boundary_unavailable');
  for (const nativeId of sources) {
    let id: string | undefined = nativeId, inRange = false;
    const seen = new Set<string>();
    while (id) {
      if (seen.has(id) || seen.size >= 256) throw new Error('upload_boundary_unavailable');
      seen.add(id);
      if (boundary.privateNative.has(id) || await store.getLocalSyncExclusion(scope, id)) throw new QueuedUploadExcludedError('private_local');
      if (boundary.selectedNative.has(id)) inRange = true;
      const current: string = id;
      try { id = await input.parentOf(current); }
      catch (error) {
        if (classifyBookmarkApiFailure(error) !== 'not_found') throw error;
        let removal = events.find(event => event.kind === 'remove' && (event.nativeId === current
          || Array.isArray(event.details.deleteNativeIds) && event.details.deleteNativeIds.includes(current)));
        if (!removal) {
          const mapping = await store.getMappingByNativeId(scope, current);
          for (let after = 0;;) {
            const page = await store.listBookmarkEventsByStatus(scope, 'pending', after, 1_000);
            removal = page.find(event => localRemovalCoversNative(event, current,
              mapping?.colpId ?? `pending-${queue.opId}`, queue.opId));
            if (removal || page.length < 1_000) break;
            after = page.at(-1)!.ordinal;
          }
        }
        // A missing native is usable only with a proven captured removal.
        // Bootstrap's stronger pending-successor check already ran above.
        if (!removal && !(planned === current && queue.opId.startsWith('b3.'))) throw error;
        id = (await store.listDeletionJournal(scope, current)).sort((a, b) => b.ordinal - a.ordinal)[0]?.parentNativeId;
        if (!id) throw error;
      }
    }
    if (!inRange) throw new QueuedUploadExcludedError('unselected_range');
  }
}

export function isUploadExcluded(error: unknown): boolean {
  return error instanceof Error && ['bootstrap_upload_excluded', 'queued_upload_excluded', 'subscription_upload_excluded'].includes(error.message);
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}
