import { liveCreateNativeId, plannedCreateNativeId } from './bookmark-event-codec.js';
import { authoritativeColpId, identityFromMapping } from './bookmark-node-identity.js';
import type { BookmarkEventRecord, JsonObject, MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

export interface CreateReceiptIdentity {
  readonly nativeId: string; readonly colpId: string; readonly rootNativeId: string;
  readonly revision: string; readonly childrenRevision?: string; readonly content: JsonObject | null;
  readonly nodeKind?: MappingInput['nodeKind']; readonly parentNativeId?: string;
  readonly createOpId?: string;
}

type Store = ReturnType<typeof createSyncStateStore>;

/** Resolve a live native from a terminal planned create_node receipt. Never invents pending-* identity. */
export async function identityFromCreateReceipt(store: Store, scope: SyncScope, nativeId: string):
  Promise<CreateReceiptIdentity | null> {
  if (!liveCreateNativeId(nativeId)) return null;
  const queued = await findCreateQueueForNative(store, scope, nativeId);
  if (!queued || queued.payload.type !== 'create_node' || queued.status !== 'terminal') return null;
  const durable = await store.getMappingByNativeId(scope, nativeId);
  if (durable && authoritativeColpId(durable.colpId) && !durable.projection.revision.startsWith('local-')) {
    if ((await store.getRemoteObservation(scope, durable.colpId))?.kind === 'tombstone') return null;
    return { ...identityFromMapping(durable), createOpId: queued.opId };
  }
  const receipt = await store.getQueueReceipt(scope, queued.sequence);
  const applied = receiptAppliedTarget(receipt?.result);
  if (!applied || (await store.getRemoteObservation(scope, applied.targetId))?.kind === 'tombstone') return null;
  const parent = await createReceiptParentIdentity(store, scope, queued.payload);
  const nodeKind = createPayloadKind(queued.payload);
  const content = createPayloadContent(queued.payload);
  return {
    nativeId, colpId: applied.targetId, rootNativeId: parent?.rootNativeId ?? nativeId,
    revision: applied.revision, content, createOpId: queued.opId,
    ...(nodeKind ? { nodeKind } : {}), ...(parent?.nativeId ? { parentNativeId: parent.nativeId } : {}),
  };
}

export async function plannedCreateOpIdForNative(store: Store, scope: SyncScope, nativeId: string):
  Promise<string | null> {
  if (!liveCreateNativeId(nativeId)) return null;
  const queued = await findCreateQueueForNative(store, scope, nativeId);
  if (queued?.status === 'terminal') {
    const receipt = await store.getQueueReceipt(scope, queued.sequence);
    const applied = receiptAppliedTarget(receipt?.result);
    if (applied && (await store.getRemoteObservation(scope, applied.targetId))?.kind === 'tombstone') return null;
  }
  return queued?.payload.type === 'create_node' ? queued.opId : null;
}

/** Pending or sent create for this native: reuse the original event, do not invent a second create. */
export async function inFlightCreateEvidence(store: Store, scope: SyncScope, nativeId: string):
  Promise<{ readonly eventId: string; readonly identity: CreateReceiptIdentity } | null> {
  const create = await latestCreateEvent(store, scope, nativeId);
  if (!create) return null;
  const mapping = create.details.mapping as unknown as MappingInput | undefined;
  if (create.status === 'pending' && mapping) {
    return { eventId: create.eventId, identity: identityFromMapping(mapping) };
  }
  if (!create.opId || !mapping) return null;
  const queued = await store.getQueueByOpId(scope, create.opId);
  if (!queued || queued.status === 'terminal') return null;
  return { eventId: create.eventId, identity: identityFromMapping(mapping) };
}

async function findCreateQueueForNative(store: Store, scope: SyncScope, nativeId: string) {
  const planned = await findPlannedCreateRow(store, scope, nativeId);
  if (planned) return planned;
  const create = await latestCreateEvent(store, scope, nativeId);
  return create?.opId ? store.getQueueByOpId(scope, create.opId) : null;
}

async function findPlannedCreateRow(store: Store, scope: SyncScope, nativeId: string) {
  let after = 0;
  for (;;) {
    const page = await store.listQueue(scope, undefined, after, 1_000);
    const matched = page.find((row) => row.payload.type === 'create_node'
      && plannedCreateNativeId(row.opId) === nativeId);
    if (matched || page.length < 1_000) return matched ?? null;
    after = page[page.length - 1]!.sequence;
  }
}

async function latestCreateEvent(store: Store, scope: SyncScope, nativeId: string):
  Promise<BookmarkEventRecord | null> {
  let after = 0; let found: BookmarkEventRecord | null = null;
  for (;;) {
    const page = await store.listBookmarkEventsByNative(scope, nativeId, after, 1_000);
    for (const event of page) if (event.kind === 'create' && (event.opId || event.details.mapping)) found = event;
    if (page.length < 1_000) return found;
    after = page[page.length - 1]!.ordinal;
  }
}

async function createReceiptParentIdentity(store: Store, scope: SyncScope, payload: JsonObject) {
  const inner = payload.payload;
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return null;
  const parentId = (inner as JsonObject).parentId;
  if (typeof parentId !== 'string' || !liveCreateNativeId(parentId)) return null;
  const mapped = await store.getMappingByColpId(scope, parentId);
  if (mapped && liveCreateNativeId(mapped.nativeId)) {
    return { nativeId: mapped.nativeId, rootNativeId: liveCreateNativeId(mapped.rootNativeId) ?? mapped.nativeId };
  }
  const mount = (await store.listMountBindings(scope)).find((item) =>
    item.remoteMountNodeId === parentId && item.status !== 'detached' && liveCreateNativeId(item.nativeRootId));
  return mount ? { nativeId: mount.nativeRootId, rootNativeId: mount.nativeRootId } : null;
}

function receiptAppliedTarget(result: JsonObject | undefined): { readonly targetId: string; readonly revision: string } | null {
  const results = result?.results;
  if (!Array.isArray(results) || !results[0] || typeof results[0] !== 'object' || Array.isArray(results[0])) return null;
  const row = results[0] as JsonObject;
  if ((row.status !== 'applied' && row.status !== 'rebased') || typeof row.targetId !== 'string'
      || typeof row.revision !== 'string' || !liveCreateNativeId(row.targetId)
      || row.revision.startsWith('local-')) return null;
  return { targetId: row.targetId, revision: row.revision };
}

function createPayloadKind(payload: JsonObject): MappingInput['nodeKind'] {
  const inner = payload.payload;
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return undefined;
  const node = (inner as JsonObject).node;
  if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const kind = (node as JsonObject).kind;
  return kind === 'folder' || kind === 'bookmark' || kind === 'separator' ? kind : undefined;
}

function createPayloadContent(payload: JsonObject): JsonObject | null {
  const inner = payload.payload;
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return null;
  const node = (inner as JsonObject).node;
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const record = node as JsonObject;
  const content = {
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    ...(typeof record.url === 'string' ? { url: record.url } : {}),
  };
  return Object.keys(content).length > 0 ? content : null;
}
