import type {
  JsonObject, MappingInput, MountBindingRecord, RemoteObservationRecord, SyncScope, createSyncStateStore,
} from './sync-state-store.js';
import type { BookmarkLookup } from './bookmark-api-error.js';
import type { PullBookmarkApi, PullNode } from './pull-applier-types.js';
import { digest } from './pull-codec.js';
import { durableEventDetails } from './bookmark-event-codec.js';
import { mappingFor, nativeContent } from './pull-projection.js';
import { isNonChromeNativeId, isProtectedNativeRoot, mayMutateNative } from './pull-mount-apply.js';
import { mappingMountActivity } from './pull-range-move.js';
import { pauseBindingForMapping } from './sync-state/remote-observation.js';
import { withinPrivateNativeBoundary } from './native-private-boundary.js';
import { performCheckedNativeWrite, prepareNativeWriteCheck, type NativeWriteBoundaryStore } from './pull-native-write-boundary.js';

type Store = NativeWriteBoundaryStore & Pick<ReturnType<typeof createSyncStateStore>, 'stageBookmarkEvent' | 'getPullEvent'>;

/** Chrome title/url that is neither the known projection nor the incoming remote value. */
export function unqueuedNativeContentFields(
  current: { readonly title?: string; readonly url?: string } | undefined,
  known: JsonObject,
  incoming: JsonObject,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const key of ['title', 'url'] as const) {
    const live = current?.[key];
    if (typeof live === 'string' && live !== known[key] && live !== incoming[key]) fields[key] = live;
  }
  return fields;
}

export async function persistUnqueuedNativeContent(
  store: Store,
  scope: SyncScope,
  mapping: MappingInput,
  overlay: Record<string, string>,
  known: JsonObject,
  now: () => number,
  sourceEventId: string,
): Promise<void> {
  if (Object.keys(overlay).length === 0) return;
  const eventId = `native-barrier:${mapping.nativeId}:${digest({ sourceEventId, overlay, known })}`;
  const nextContent = { ...known, ...overlay };
  await store.stageBookmarkEvent(scope, {
    eventId,
    dedupeKey: eventId,
    occurredAt: new Date(now()).toISOString(),
    kind: 'change',
    nativeId: mapping.nativeId,
    details: durableEventDetails({
      operation: {
        type: 'update_node_content',
        targetId: mapping.colpId,
        baseRevision: mapping.projection.revision,
        dependencies: [],
        payload: {
          base: Object.fromEntries(Object.keys(overlay).map((key) => [key, known[key] ?? null])),
          value: overlay,
        },
      },
      mapping: {
        nativeId: mapping.nativeId,
        colpId: mapping.colpId,
        rootNativeId: mapping.rootNativeId,
        ...(mapping.nodeKind ? { nodeKind: mapping.nodeKind } : {}),
        ...(mapping.parentNativeId ? { parentNativeId: mapping.parentNativeId } : {}),
        projection: {
          revision: `local-${eventId}`,
          digest: digest(nextContent),
          content: { ...mapping.projection.content, ...nextContent },
        },
      },
    }),
  });
}

interface RemoteContentUpdateInput {
  readonly store: Store;
  readonly scope: SyncScope;
  readonly api: PullBookmarkApi;
  readonly mapping: MappingInput;
  /** A later Snapshot can own authority while the confirmed create supplies
   * the older native content baseline. Neither value replaces the other. */
  readonly authorityMapping?: MappingInput;
  readonly incomingMapping: MappingInput;
  readonly effectDigest: string;
  readonly eventId: string;
  readonly mounts: readonly MountBindingRecord[];
  readonly now: () => number;
  readonly lookup: (id: string) => Promise<BookmarkLookup>;
  readonly targetMissingError: (colpId: string, nativeId: string) => Promise<Error>;
  readonly queuedLocal: JsonObject;
  readonly observationCursor?: string;
}

export async function applyRemoteNodeContentUpdate(input: Omit<RemoteContentUpdateInput, 'incomingMapping'> & {
  readonly node: PullNode;
}) {
  return applyRemoteMappingContentUpdate({ ...input,
    incomingMapping: mappingFor(input.node, input.mapping.nativeId, input.mapping.parentNativeId ?? null,
      input.node.parentId, input.mapping.projection.childrenRevision ?? null, input.mapping.rootNativeId) });
}

/** Pull and Snapshot must preserve the same local content before advancing authority. */
export async function applyRemoteMappingContentUpdate(input: RemoteContentUpdateInput): Promise<{
  readonly mapping: MappingInput;
  readonly rangeExit?: {
    readonly observation: Omit<RemoteObservationRecord, 'scopeKey'>;
  };
}> {
  const { store, scope, api, mapping, incomingMapping, mounts, now, lookup, queuedLocal } = input;
  const incoming = nativeContent(incomingMapping.projection.content ?? {});
  const known = nativeContent(mapping.projection.content ?? {});
  const scopeRecord = await store.getScope(scope);
  const preserveMountTitle = scopeRecord?.selectedRoots.includes(incomingMapping.colpId) === true
    || isProtectedNativeRoot(mapping.nativeId, mounts);
  const landedOnly = isNonChromeNativeId(mapping.nativeId) || mappingMountActivity(mapping, mounts) !== 'active'
    || await withinPrivateNativeBoundary({ store, scope, mapping, privateRoots: scopeRecord?.privateRoots ?? [], lookup });
  const local: JsonObject = { ...queuedLocal };
  let deferredContent: JsonObject | undefined;
  if (!preserveMountTitle && !landedOnly && mayMutateNative(mapping, mounts)) {
    const looked = await lookup(mapping.nativeId);
    if (looked.class === 'not_found') throw await input.targetMissingError(incomingMapping.colpId, mapping.nativeId);
    if (looked.class !== 'present') throw new Error(looked.message);
    const current = looked.nodes[0];
    const overlay = unqueuedNativeContentFields(current, known, incoming);
    if (Object.keys(overlay).length) {
      await persistUnqueuedNativeContent(store, scope, mapping, overlay, known, now, input.eventId);
      // Chrome is independently writable during the durable barrier. Do not
      // overwrite any field using this stale snapshot; retain remote authority
      // as an observation and let capture/reconciliation settle the local work.
      deferredContent = nativeContent(current ?? {});
      Object.assign(local, overlay);
    } else {
      const projectedContent = { ...incoming, ...local };
      const changes = Object.fromEntries(Object.entries(projectedContent)
        .filter(([key, value]) => current?.[key as 'title' | 'url'] !== value));
      if (Object.keys(changes).length && current) {
        const check = await prepareNativeWriteCheck({ store, scope, api,
          mapping: input.authorityMapping ?? mapping, preimage: current });
        await performCheckedNativeWrite(api, check, beforeNative => api.update(mapping.nativeId, changes, beforeNative));
      }
    }
  }
  const preserveLocal = Object.keys(local).length > 0;
  const projectedContent = deferredContent ?? { ...incoming, ...local };
  if (preserveLocal || landedOnly) {
    const { scopeKey: _scopeKey, ...currentMapping } = mapping as MappingInput & { readonly scopeKey?: string };
    const nextMapping = preserveLocal && !landedOnly ? { ...currentMapping,
      projection: { ...mapping.projection, content: { ...mapping.projection.content, ...projectedContent },
        digest: digest({ ...mapping.projection.content, ...projectedContent }),
        contentDigest: digest({ ...mapping.projection.content, ...projectedContent }) } } : currentMapping;
    return {
      mapping: nextMapping,
      rangeExit: {
        observation: {
          colpId: incomingMapping.colpId, remoteRevision: incomingMapping.projection.revision,
          cursor: input.observationCursor ?? String((await store.getPullEvent(scope, input.eventId))?.cursor ?? '0'),
          kind: 'content', payload: incoming,
          sourceDigest: digest({ effectId: input.effectDigest, action: 'observe_only' }), observedAt: now(),
          ...pauseBindingForMapping(mapping, mounts),
        },
      },
    };
  }
  return {
    mapping: incomingMapping,
  };
}
