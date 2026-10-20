import { withCodecSubject } from './codec-subject.js';
import { digestJson } from '../bookmark-event-codec.js';
import { bootstrapOpId } from '../bootstrap/run-identity.js';
import { normalizeBookmarkProjection } from '../bookmark-projection-metadata.js';
import {
  SyncStateError, type BrowserRootAuthority, type ConfigureBrowserRootsInput, type DiscoveredRoot, type FaultOptions,
  type MappingInput, type MountBindingRecord, type QueueOperation, type ReceiptRecord, type SyncScope,
  type BookmarkEventRecord, type JsonObject, type ScopeRecord, type BindMountMappingInput, type BootstrapRunRecord,
} from './types.js';
import { boundedString, clone, strictObject, validateJson, validateRecord } from './codec.js';
import { constraintError, inject } from './errors.js';
import { cursorPage, requestValue, requireActiveScope, runTransaction, scopeRowsRange, transactionDone } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { normalizeBoundaries, scopeKey, validateDiscovered, validateScope, validateScopeRecord } from './scope-key.js';
import { validateQueueRecord } from './queue-validate.js';
import type { SyncStoreRuntime } from './runtime.js';

export function validateMapping(key: string, input: MappingInput, maxBytes: number) {
  return withCodecSubject({ nodeId: input.colpId, nativeId: input.nativeId }, () => validateMappingInput(key, input, maxBytes));
}
function validateMappingInput(key: string, input: MappingInput, maxBytes: number) { const value = strictObject(clone(input),
  ['nativeId', 'colpId', 'rootNativeId', 'nodeKind', 'parentNativeId', 'parentColpId', 'mountId', 'rootRole', 'quarantine', 'projection'], 'mapping',
  ['nodeKind', 'parentNativeId', 'parentColpId', 'mountId', 'rootRole', 'quarantine']); const projection = normalizeBookmarkProjection(strictObject(value.projection,
  ['revision', 'resourceRevision', 'childrenRevision', 'digest', 'contentDigest', 'content', 'childrenOrder'], 'projection',
  ['revision', 'resourceRevision', 'childrenRevision', 'contentDigest', 'content', 'childrenOrder']));
  const resourceRevision = projection.resourceRevision ?? projection.revision;
  if (resourceRevision === undefined) throw new SyncStateError('resource_revision_missing');
  const record = { scopeKey: key, nativeId: boundedString(value.nativeId, 'nativeId'),
    colpId: boundedString(value.colpId, 'colpId'), rootNativeId: boundedString(value.rootNativeId, 'rootNativeId'),
    ...(value.nodeKind === undefined ? {} : { nodeKind: validateNodeKind(value.nodeKind) }),
    ...(value.parentNativeId === undefined ? {} : { parentNativeId: boundedString(value.parentNativeId, 'parentNativeId') }),
    ...(value.parentColpId === undefined ? {} : { parentColpId: boundedString(value.parentColpId, 'parentColpId') }),
    ...(value.mountId === undefined ? {} : { mountId: boundedString(value.mountId, 'mountId') }),
    ...(value.rootRole === undefined ? {} : { rootRole: validateRootRole(value.rootRole) }),
    ...(value.quarantine === undefined ? {} : { quarantine: validateQuarantine(value.quarantine) }),
    projection: { revision: boundedString(resourceRevision, 'resourceRevision'),
      resourceRevision: boundedString(resourceRevision, 'resourceRevision'),
      ...(projection.childrenRevision === undefined ? {} : { childrenRevision: projection.childrenRevision === null ? null
        : boundedString(projection.childrenRevision, 'childrenRevision') }), digest: boundedString(projection.digest, 'digest'),
      contentDigest: boundedString(projection.contentDigest ?? projection.digest, 'contentDigest'),
      ...(projection.childrenOrder === undefined ? {} : { childrenOrder: projection.childrenOrder as string[] }),
      ...(projection.content === undefined ? {} : { content: validateJson(projection.content, 'projection.content') as JsonObject }) } };
  validateRecord(record, maxBytes); return record; }
export function validateMappingRecord(key: string, input: unknown, maxBytes: number) {
  const value = strictObject(clone(input), ['scopeKey', 'nativeId', 'colpId', 'rootNativeId', 'nodeKind', 'parentNativeId',
    'parentColpId', 'mountId', 'rootRole', 'quarantine', 'projection'], 'mapping record',
    ['nodeKind', 'parentNativeId', 'parentColpId', 'mountId', 'rootRole', 'quarantine']);
  if (value.scopeKey !== key) throw new SyncStateError('mapping_scope_invalid');
  return validateMapping(key, { nativeId: String(value.nativeId), colpId: String(value.colpId),
    rootNativeId: String(value.rootNativeId),
    ...(value.nodeKind === undefined ? {} : { nodeKind: validateNodeKind(value.nodeKind) }),
    ...(value.parentNativeId === undefined ? {} : { parentNativeId: String(value.parentNativeId) }),
    ...(value.parentColpId === undefined ? {} : { parentColpId: String(value.parentColpId) }),
    ...(value.mountId === undefined ? {} : { mountId: String(value.mountId) }),
    ...(value.rootRole === undefined ? {} : { rootRole: validateRootRole(value.rootRole) }),
    ...(value.quarantine === undefined ? {} : { quarantine: validateQuarantine(value.quarantine) }),
    projection: value.projection as MappingInput['projection'] }, maxBytes);
}
export function validateNodeKind(value: unknown): NonNullable<MappingInput['nodeKind']> {
  if (!['folder', 'bookmark', 'separator'].includes(String(value))) throw new SyncStateError('node_kind_invalid');
  return value as NonNullable<MappingInput['nodeKind']>;
}
export function validateRootRole(value: unknown): NonNullable<MappingInput['rootRole']> {
  if (!['bookmarks-bar', 'other-bookmarks', 'mobile-bookmarks', 'managed-bookmarks', 'custom'].includes(String(value))) {
    throw new SyncStateError('root_role_invalid');
  }
  return value as NonNullable<MappingInput['rootRole']>;
}
export function virtualPlaceholderNativeId(nativeId: string) {
  return nativeId.startsWith('recovery:') || nativeId.startsWith('sidecar:') || nativeId.startsWith('unmounted:');
}
/** Virtual recovery/sidecar/unmounted occupants may hand off; a live native must freeze. */
async function transferVirtualCreateOccupant(mappings: IDBObjectStore, key: string, targetId: string, maxBytes: number) {
  const collision = await requestValue(mappings.index(INDEXES.mappingByColpId).get([key, targetId]));
  if (!collision) return;
  const owner = validateMappingRecord(key, collision, maxBytes);
  if (!virtualPlaceholderNativeId(owner.nativeId)) throw new SyncStateError('mapping_identity_collision');
  mappings.delete([key, owner.nativeId]);
}
export async function rebindCreateInTransaction(tx: IDBTransaction, key: string, queued: QueueOperation,
  authority: { readonly nativeId: string; readonly targetId: string; readonly revision: string }, maxBytes: number) {
  const mappings = tx.objectStore(STORES.mappings); const currentValue = await requestValue(mappings.get([key, authority.nativeId]));
  if (!currentValue) {
    await insertCreateReceiptMapping(tx, key, queued, authority, maxBytes);
    return;
  }
  const mapping = validateMappingRecord(key, currentValue, maxBytes);
  if (mapping.colpId === authority.targetId) return;
  if (mapping.colpId !== `pending-${queued.opId}` || !mapping.projection.revision.startsWith('local-')) return;
  const events = await cursorPage<BookmarkEventRecord>(tx.objectStore(STORES.bookmarkEvents).index(INDEXES.eventByOrdinal),
    IDBKeyRange.bound([key, 1], [key, Number.MAX_SAFE_INTEGER]), Number.MAX_SAFE_INTEGER);
  const bootstrapRuns = tx.objectStoreNames.contains(STORES.bootstrapRuns)
    ? await cursorPage<BootstrapRunRecord>(tx.objectStore(STORES.bootstrapRuns), scopeRowsRange(key), Number.POSITIVE_INFINITY) : [];
  const planned = queued.payload.type === 'create_node' && bootstrapRuns.some(run =>
    bootstrapOpId(run.confirmationId, 'create', authority.nativeId) === queued.opId);
  if (!planned && !events.some((event) => event.status === 'processed' && event.opId === queued.opId
      && event.nativeId === authority.nativeId && event.kind === 'create')) {
    throw new SyncStateError('provisional_mapping_binding_invalid');
  }
  await transferVirtualCreateOccupant(mappings, key, authority.targetId, maxBytes);
  mappings.put(validateMapping(key, { nativeId: mapping.nativeId, colpId: authority.targetId,
    rootNativeId: mapping.rootNativeId, ...(mapping.nodeKind ? { nodeKind: mapping.nodeKind } : {}),
    ...(mapping.parentNativeId ? { parentNativeId: mapping.parentNativeId } : {}),
    ...(mapping.parentColpId ? { parentColpId: mapping.parentColpId } : {}),
    ...(mapping.mountId ? { mountId: mapping.mountId } : {}),
    ...(mapping.rootRole ? { rootRole: mapping.rootRole } : {}), projection: {
      revision: authority.revision, ...(mapping.nodeKind === 'folder' ? { childrenRevision: authority.revision } : {}), digest: mapping.projection.digest,
      ...(mapping.projection.content ? { content: mapping.projection.content } : {}) } }, maxBytes));
}

async function insertCreateReceiptMapping(tx: IDBTransaction, key: string, queued: QueueOperation,
  authority: { readonly nativeId: string; readonly targetId: string; readonly revision: string }, maxBytes: number) {
  if (queued.payload.type !== 'create_node' || virtualPlaceholderNativeId(authority.nativeId)
      || authority.targetId.startsWith('pending-') || authority.revision.startsWith('local-')) {
    throw new SyncStateError('provisional_mapping_binding_invalid');
  }
  const mappings = tx.objectStore(STORES.mappings);
  await transferVirtualCreateOccupant(mappings, key, authority.targetId, maxBytes);
  const facts = createNodeFacts(queued);
  const parent = await createReceiptParent(tx, key, facts.parentColpId, maxBytes);
  const content = facts.content;
  const nodeKind = facts.nodeKind;
  mappings.put(validateMapping(key, {
    nativeId: authority.nativeId, colpId: authority.targetId,
    rootNativeId: parent.rootNativeId ?? authority.nativeId,
    ...(nodeKind ? { nodeKind } : {}),
    ...(facts.rootRole ? { rootRole: facts.rootRole } : {}),
    ...(parent.parentNativeId ? { parentNativeId: parent.parentNativeId } : {}),
    ...(facts.parentColpId ? { parentColpId: facts.parentColpId } : {}),
    projection: { revision: authority.revision, digest: 'sha256:create-receipt',
      ...(nodeKind === 'folder' ? { childrenRevision: authority.revision } : {}),
      ...(content ? { content } : {}) },
  }, maxBytes));
}

async function createReceiptParent(tx: IDBTransaction, key: string, parentColpId: string | undefined, maxBytes: number) {
  let parentNativeId: string | undefined; let rootNativeId: string | undefined;
  const mappings = tx.objectStore(STORES.mappings);
  if (parentColpId) {
    const parentRow = await requestValue(mappings.index(INDEXES.mappingByColpId).get([key, parentColpId]));
    if (parentRow) {
      const parent = validateMappingRecord(key, parentRow, maxBytes);
      parentNativeId = liveMappedNativeId(parent.nativeId);
      rootNativeId = liveMappedNativeId(parent.rootNativeId) ?? parentNativeId;
    }
  }
  const mounts = await cursorPage<MountBindingRecord>(tx.objectStore(STORES.mounts), scopeRowsRange(key),
    Number.MAX_SAFE_INTEGER);
  const byRemote = parentColpId
    ? mounts.find((mount) => mount.remoteMountNodeId === parentColpId && mount.status !== 'detached') : undefined;
  parentNativeId = parentNativeId ?? liveMappedNativeId(byRemote?.nativeRootId);
  rootNativeId = rootNativeId ?? liveMappedNativeId(byRemote?.nativeRootId);
  return { parentNativeId, rootNativeId };
}

function liveMappedNativeId(nativeId: string | undefined) {
  return nativeId && !virtualPlaceholderNativeId(nativeId) && !nativeId.startsWith('pending-')
    && !nativeId.startsWith('local-') ? nativeId : undefined;
}

function createNodeFacts(queued: QueueOperation): {
  readonly nodeKind?: MappingInput['nodeKind']; readonly rootRole?: MappingInput['rootRole']; readonly content?: JsonObject; readonly parentColpId?: string
} {
  if (queued.payload.type !== 'create_node') return {};
  const inner = queued.payload.payload;
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return {};
  const payload = inner as JsonObject;
  const parentRaw = typeof payload.parentId === 'string' ? payload.parentId : undefined;
  const parentColpId = parentRaw && !parentRaw.startsWith('pending-') && parentRaw !== 'inbox-parent'
    && !parentRaw.startsWith('local-') ? parentRaw : undefined;
  const node = payload.node;
  if (!node || typeof node !== 'object' || Array.isArray(node)) return { parentColpId };
  const record = node as JsonObject;
  const nodeKind = record.kind === 'folder' || record.kind === 'bookmark' || record.kind === 'separator'
    ? record.kind : undefined;
  const content: JsonObject = {
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    ...(typeof record.url === 'string' ? { url: record.url } : {}),
    ...(typeof record.folderRole === 'string' ? { folderRole: record.folderRole } : {}),
  };
  return { nodeKind, ...(['bookmarks-bar', 'other-bookmarks', 'mobile-bookmarks'].includes(String(record.folderRole))
    ? { rootRole: record.folderRole as MappingInput['rootRole'] } : {}), content: Object.keys(content).length > 0 ? content : undefined, parentColpId };
}
export async function rebindProjectionInTransaction(tx: IDBTransaction, key: string, queued: QueueOperation,
  authority: { readonly targetId: string; readonly revision: string; readonly content?: JsonObject },
  maxBytes: number) {
  if ((queued.payload.type !== 'update_node_content' && queued.payload.type !== 'move_node')
      || queued.payload.targetId !== authority.targetId) throw new SyncStateError('authoritative_projection_invalid');
  const mappings = tx.objectStore(STORES.mappings);
  const currentValue = await requestValue(mappings.index(INDEXES.mappingByColpId).get([key, authority.targetId]));
  const mapping = validateMappingRecord(key, currentValue, maxBytes);
  if (mapping.projection.revision !== queued.operationRevision && mapping.projection.revision !== queued.baseRevision) {
    if (mapping.projection.revision === authority.revision) return;
    const later = await cursorPage<QueueOperation>(tx.objectStore(STORES.queue), scopeRowsRange(key), 20_000);
    const advanced = later.some((candidate) => candidate.sequence > queued.sequence && candidate.status !== 'rejected'
      && (candidate.payload.type === 'update_node_content' || candidate.payload.type === 'move_node')
      && candidate.payload.targetId === authority.targetId);
    if (!advanced) throw new SyncStateError('authoritative_projection_stale');
    return;
  }
  const { scopeKey: _key, ...current } = mapping;
  const payload = queued.payload.payload as JsonObject;
  const parentValue = queued.payload.type === 'move_node' && typeof payload.newParentId === 'string'
    ? await requestValue(mappings.index(INDEXES.mappingByColpId).get([key, payload.newParentId])) : undefined;
  const parent = parentValue ? validateMappingRecord(key, parentValue, maxBytes) : undefined;
  const value = queued.payload.type === 'update_node_content' && payload.value && typeof payload.value === 'object'
    && !Array.isArray(payload.value) ? payload.value : undefined;
  // A merge reflow transform is the authoritative post-merge content; without
  // one the legacy overlay keeps the local attempt until the next Pull heals.
  const content = authority.content !== undefined
    ? { ...(mapping.projection.content ?? {}), ...authority.content }
    : value ? { ...(mapping.projection.content ?? {}), ...value } : mapping.projection.content;
  mappings.put(validateMapping(key, { ...current,
    ...(parent ? { parentNativeId: parent.nativeId, parentColpId: parent.colpId, rootNativeId: parent.rootNativeId,
      mountId: parent.mountId } : {}),
    projection: { ...mapping.projection, revision: authority.revision, resourceRevision: authority.revision,
      ...(content ? { content, ...(value ? { digest: digestJson(content), contentDigest: digestJson(content) } : {}) } : {}) },
  }, maxBytes));
}
export function assertAuthoritativeCreateReceipt(queued: QueueOperation, receipt: ReceiptRecord,
  authority: { readonly nativeId: string; readonly targetId: string; readonly revision: string }) {
  const results = receipt.result?.results;
  const result = Array.isArray(results) && results.length === 1 && results[0]
    && typeof results[0] === 'object' && !Array.isArray(results[0]) ? results[0] as JsonObject : null;
  if (receipt.kind !== 'terminal' || queued.payload.type !== 'create_node' || !result
      || (result.status !== 'applied' && result.status !== 'rebased') || result.opId !== queued.opId
      || result.sequence !== queued.sequence || result.targetId !== authority.targetId
      || result.revision !== authority.revision) {
    throw new SyncStateError('provisional_mapping_binding_invalid');
  }
}
export function assertAuthoritativeProjectionReceipt(queued: QueueOperation, receipt: ReceiptRecord,
  authority: { readonly targetId: string; readonly revision: string }) {
  const results = receipt.result?.results;
  const result = Array.isArray(results) && results.length === 1 && results[0]
    && typeof results[0] === 'object' && !Array.isArray(results[0]) ? results[0] as JsonObject : null;
  if (receipt.kind !== 'terminal' || !result
      || (queued.payload.type !== 'update_node_content' && queued.payload.type !== 'move_node')
      || queued.payload.targetId !== authority.targetId || result.opId !== queued.opId || result.sequence !== queued.sequence
      || (result.status !== 'applied' && result.status !== 'rebased') || result.revision !== authority.revision
      || (result.targetId !== undefined && result.targetId !== authority.targetId)) {
    throw new SyncStateError('authoritative_projection_invalid');
  }
}

export function createMappingRepository(ctx: SyncStoreRuntime) {
  const maxRecordBytes = ctx.maxRecordBytes;
  const durableCache = ctx.durableCache;
  const open = () => ctx.open();
  const writableDatabase = () => ctx.writableDatabase();
  const assertWritable = () => ctx.assertWritable();
  const readOne = (storeName: string, key: IDBValidKey) => ctx.readOne(storeName, key);
  const factory = ctx.factory;
  const close = () => ctx.close();
  async function putMapping(input: SyncScope, mappingInput: MappingInput): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input)); const mapping = validateMapping(key, mappingInput, maxRecordBytes);
    const db = await writableDatabase();
    try { await runTransaction(db, [STORES.scopes, STORES.mappings], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const mappings = tx.objectStore(STORES.mappings);
      const byColp = await requestValue(mappings.index(INDEXES.mappingByColpId).get([key, mapping.colpId])) as
        { readonly nativeId: string } | undefined;
      if (byColp && byColp.nativeId !== mapping.nativeId) {
        if (!virtualPlaceholderNativeId(byColp.nativeId)) throw new SyncStateError('constraint');
        mappings.delete([key, byColp.nativeId]);
      }
      const existing = await requestValue(mappings.get([key, mapping.nativeId])) as MappingInput | undefined;
      if (existing && existing.colpId !== mapping.colpId) throw new SyncStateError('constraint');
      mappings.put(mapping);
    }); } catch (error) { throw constraintError(error); }
  }

  async function listMappings(input: SyncScope) {
    const key = scopeKey(validateScope(input)); const db = await open(); const tx = db.transaction(STORES.mappings, 'readonly');
    const completion = transactionDone(tx); const values = await cursorPage<ReturnType<typeof validateMapping>>(
      tx.objectStore(STORES.mappings), scopeRowsRange(key), Number.MAX_SAFE_INTEGER); await completion;
    return values.map((value) => clone(validateMappingRecord(key, value, maxRecordBytes)));
  }

  async function getMappingByNativeId(input: SyncScope, nativeId: string) {
    const key = scopeKey(validateScope(input)); const db = await open(); const tx = db.transaction(STORES.mappings, 'readonly');
    const completion = transactionDone(tx); const value = await requestValue(tx.objectStore(STORES.mappings)
      .index(INDEXES.mappingByNativeId).get([key, boundedString(nativeId, 'nativeId')])); await completion;
    return value ? clone(validateMappingRecord(key, value, maxRecordBytes)) : null;
  }

  async function getMappingByColpId(input: SyncScope, colpId: string) {
    const key = scopeKey(validateScope(input)); const db = await open(); const tx = db.transaction(STORES.mappings, 'readonly');
    const completion = transactionDone(tx); const value = await requestValue(tx.objectStore(STORES.mappings)
      .index(INDEXES.mappingByColpId).get([key, boundedString(colpId, 'colpId')])); await completion;
    return value ? clone(validateMappingRecord(key, value, maxRecordBytes)) : null;
  }

  async function rebindProvisionalBookmarkIdentity(input: SyncScope, nativeId: string, createOpId: string,
    confirmedColpId: string, confirmedRevision: string): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input));
    for (const [value, label] of [[nativeId, 'nativeId'], [createOpId, 'createOpId'],
      [confirmedColpId, 'confirmedColpId'], [confirmedRevision, 'confirmedRevision']] as const) boundedString(value, label);
    const db = await writableDatabase();
    try { await runTransaction(db, [STORES.scopes, STORES.mappings, STORES.queue, STORES.bookmarkEvents],
      'readwrite', async (tx) => {
        await requireActiveScope(tx, key); const mappings = tx.objectStore(STORES.mappings);
        const current = await requestValue(mappings.get([key, nativeId]));
        const mapping = validateMappingRecord(key, current, maxRecordBytes);
        if (mapping.colpId !== `pending-${createOpId}` || !mapping.projection.revision.startsWith('local-')) {
          throw new SyncStateError('provisional_mapping_binding_invalid');
        }
        const queued = await requestValue(tx.objectStore(STORES.queue).index(INDEXES.queueByOpId).get([key, createOpId]));
        const operation = queued ? validateQueueRecord(queued, maxRecordBytes) : null;
        if (!operation || operation.payload.type !== 'create_node') throw new SyncStateError('provisional_mapping_binding_invalid');
        const events = await cursorPage<BookmarkEventRecord>(tx.objectStore(STORES.bookmarkEvents)
          .index(INDEXES.eventByOrdinal), IDBKeyRange.bound([key, 1], [key, Number.MAX_SAFE_INTEGER]),
        Number.MAX_SAFE_INTEGER);
        if (!events.some((event) => event.status === 'processed' && event.opId === createOpId
          && event.nativeId === nativeId && event.kind === 'create')) {
          throw new SyncStateError('provisional_mapping_binding_invalid');
        }
        const collision = await requestValue(mappings.index(INDEXES.mappingByColpId).get([key, confirmedColpId]));
        if (collision) throw new SyncStateError('constraint');
        mappings.put(validateMapping(key, { nativeId, colpId: confirmedColpId, rootNativeId: mapping.rootNativeId,
          ...(mapping.nodeKind ? { nodeKind: mapping.nodeKind } : {}),
          ...(mapping.parentNativeId ? { parentNativeId: mapping.parentNativeId } : {}),
          ...(mapping.mountId ? { mountId: mapping.mountId } : {}),
          ...(mapping.rootRole ? { rootRole: mapping.rootRole } : {}),
          projection: { revision: confirmedRevision, digest: mapping.projection.digest,
            ...(mapping.projection.content ? { content: mapping.projection.content } : {}) } }, maxRecordBytes));
      }); } catch (error) { throw constraintError(error); }
  }

  async function configureBrowserRoots(input: SyncScope, configuration: ConfigureBrowserRootsInput,
    faults: FaultOptions = {}): Promise<BrowserRootAuthority> {
    assertWritable(); const key = scopeKey(validateScope(input)); const discovered = validateDiscovered(configuration.discovered);
    if (!['ready', 'permission_required', 'tree_unavailable', 'corrupt'].includes(configuration.status)) {
      throw new SyncStateError('root_status_invalid');
    }
    const selectedNative = normalizeBoundaries(configuration.selectedNativeIds, discovered);
    const privateNative = normalizeBoundaries(configuration.privateNativeIds, discovered);
    const normalized = selectedNative.length !== new Set(configuration.selectedNativeIds).size
      || privateNative.length !== new Set(configuration.privateNativeIds).size;
    const db = await writableDatabase(); let authority!: BrowserRootAuthority;
    try { await runTransaction(db, [STORES.scopes, STORES.mappings], 'readwrite', async (tx) => {
      const scope = validateScopeRecord(await requireActiveScope(tx, key), maxRecordBytes);
      if (configuration.expectedBoundaryVersion !== undefined
          && scope.boundaryVersion !== configuration.expectedBoundaryVersion) throw new SyncStateError('preview_stale');
      const mappings = tx.objectStore(STORES.mappings); const existing = await cursorPage<ReturnType<typeof validateMapping>>(
        mappings, scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
      const byNative = new Map(existing.map((record) => [record.nativeId, record]));
      const ensure = (nativeId: string) => {
        const prior = byNative.get(nativeId); if (prior) return prior.colpId;
        const mapping = validateMapping(key, { nativeId, colpId: crypto.randomUUID(), rootNativeId: nativeId,
          projection: { revision: 'local-root', digest: 'sha256:local-root' } }, maxRecordBytes);
        mappings.add(mapping); byNative.set(nativeId, mapping); return mapping.colpId;
      };
      const selectedRoots = selectedNative.map(ensure); const privateRoots = privateNative.map(ensure);
      inject(faults.fault, 'after_mapping', tx);
      const rootStatus = configuration.status === 'ready' && normalized ? 'nested_normalized' : configuration.status;
      const updated = validateScopeRecord({ ...scope, selectedRoots, privateRoots, rootStatus }, maxRecordBytes);
      tx.objectStore(STORES.scopes).put(updated); authority = { selectedRoots, privateRoots, rootStatus };
    }); } catch (error) { throw constraintError(error); }
    durableCache.set(key, clone(authority)); return clone(authority);
  }

  async function reconcileBrowserRoots(input: SyncScope, discoveredInput: readonly DiscoveredRoot[]): Promise<BrowserRootAuthority> {
    assertWritable(); const key = scopeKey(validateScope(input)); const discovered = validateDiscovered(discoveredInput);
    const db = await writableDatabase(); let authority!: BrowserRootAuthority;
    await runTransaction(db, [STORES.scopes, STORES.mappings], 'readwrite', async (tx) => {
      const scope = validateScopeRecord(await requireActiveScope(tx, key), maxRecordBytes);
      const mappings = await cursorPage<ReturnType<typeof validateMapping>>(tx.objectStore(STORES.mappings),
        scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
      const byColp = new Map(mappings.map((record) => [record.colpId, record.nativeId]));
      const selectedNative = scope.selectedRoots.map((id) => byColp.get(id));
      const privateNative = (scope.privateRoots ?? []).map((id) => byColp.get(id));
      let rootStatus: NonNullable<ScopeRecord['rootStatus']> = 'ready';
      if ([...selectedNative, ...privateNative].some((id) => id === undefined)) rootStatus = 'corrupt';
      else if ([...selectedNative, ...privateNative].some((id) => !discovered.has(id!))) rootStatus = 'root_missing';
      let selectedRoots = scope.selectedRoots; let privateRoots = scope.privateRoots ?? [];
      if (rootStatus === 'ready') {
        const normalizedSelected = normalizeBoundaries(selectedNative as string[], discovered);
        const normalizedPrivate = normalizeBoundaries(privateNative as string[], discovered);
        const changed = normalizedSelected.length !== selectedNative.length || normalizedPrivate.length !== privateNative.length;
        if (changed) rootStatus = 'nested_normalized';
        selectedRoots = normalizedSelected.map((nativeId) => mappings.find((item) => item.nativeId === nativeId)!.colpId);
        privateRoots = normalizedPrivate.map((nativeId) => mappings.find((item) => item.nativeId === nativeId)!.colpId);
      }
      tx.objectStore(STORES.scopes).put(validateScopeRecord({ ...scope, selectedRoots, privateRoots, rootStatus }, maxRecordBytes));
      authority = { selectedRoots, privateRoots, rootStatus };
    });
    durableCache.set(key, clone(authority)); return clone(authority);
  }

  async function setBrowserRootStatus(input: SyncScope,
    rootStatus: 'permission_required' | 'tree_unavailable' | 'corrupt'): Promise<BrowserRootAuthority> {
    assertWritable(); const key = scopeKey(validateScope(input)); const db = await writableDatabase(); let authority!: BrowserRootAuthority;
    await runTransaction(db, [STORES.scopes], 'readwrite', async (tx) => {
      const scope = validateScopeRecord(await requireActiveScope(tx, key), maxRecordBytes);
      const updated = validateScopeRecord({ ...scope, rootStatus }, maxRecordBytes); tx.objectStore(STORES.scopes).put(updated);
      authority = { selectedRoots: updated.selectedRoots, privateRoots: updated.privateRoots ?? [], rootStatus };
    });
    durableCache.set(key, clone(authority)); return clone(authority);
  }

  async function deleteMapping(input: SyncScope, nativeId: string): Promise<boolean> {
    assertWritable(); const key = scopeKey(validateScope(input));
    const id = boundedString(nativeId, 'nativeId'); const db = await writableDatabase(); let removed = false;
    await runTransaction(db, [STORES.scopes, STORES.mappings], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key); const mappings = tx.objectStore(STORES.mappings);
      if (!await requestValue(mappings.get([key, id]))) return;
      mappings.delete([key, id]); removed = true;
    });
    return removed;
  }

  async function bindMountMapping(input: SyncScope, mappingInput: BindMountMappingInput): Promise<boolean> {
    assertWritable();
    if (!mappingInput.nativeId || !mappingInput.colpId || !mappingInput.mountId || !mappingInput.revision
        || mappingInput.revision.startsWith('local-')) return false;
    validateScope(input);
    const existing = await getMappingByNativeId(input, mappingInput.nativeId);
    if (existing) return false;
    const byColp = await getMappingByColpId(input, mappingInput.colpId);
    if (byColp) return false;
    try {
      await putMapping(input, {
        nativeId: mappingInput.nativeId, colpId: mappingInput.colpId, rootNativeId: mappingInput.nativeId,
        nodeKind: 'folder', mountId: mappingInput.mountId,
        ...(mappingInput.rootRole ? { rootRole: mappingInput.rootRole } : {}),
        projection: { revision: mappingInput.revision, childrenRevision: mappingInput.revision,
          digest: 'sha256:mount-binding' },
      });
      return true;
    } catch (error) {
      if (error instanceof SyncStateError && error.code === 'constraint') return false;
      throw error;
    }
  }

  /** Promote a confirmed mount's local reservation using authoritative remote folder facts. */
  async function bindResolvedMountMapping(input: SyncScope, mappingInput: MappingInput): Promise<boolean> {
    assertWritable(); const key = scopeKey(validateScope(input));
    const mapping = validateMapping(key, mappingInput, maxRecordBytes);
    if (!mapping.mountId || mapping.nodeKind !== 'folder' || mapping.nativeId !== mapping.rootNativeId
        || mapping.projection.revision.startsWith('local-')) return false;
    const db = await writableDatabase(); let bound = false; let authority: BrowserRootAuthority | undefined;
    await runTransaction(db, [STORES.scopes, STORES.mappings, STORES.mounts], 'readwrite', async tx => {
      const scope = validateScopeRecord(await requireActiveScope(tx, key), maxRecordBytes);
      const mounts = tx.objectStore(STORES.mounts), mappings = tx.objectStore(STORES.mappings);
      const mount = await requestValue(mounts.get([key, mapping.mountId!])) as MountBindingRecord | undefined;
      const current = await requestValue(mappings.get([key, mapping.nativeId])) as MappingInput | undefined;
      const local = current?.projection.revision === 'local-root' && current.projection.digest === 'sha256:local-root';
      if (!mount || mount.status === 'detached' || mount.nativeRootId !== mapping.nativeId
          || mount.rootRole !== mapping.rootRole || current && !local
          || mount.remoteMountNodeId && mount.remoteMountNodeId !== mapping.colpId
            && (!local || mount.remoteMountNodeId !== current?.colpId)) return;
      const owner = await requestValue(mappings.index(INDEXES.mappingByColpId).get([key, mapping.colpId])) as MappingInput | undefined;
      if (owner && owner.nativeId !== mapping.nativeId && !virtualPlaceholderNativeId(owner.nativeId)) return;
      if (owner && owner.nativeId !== mapping.nativeId) mappings.delete([key, owner.nativeId]);
      mappings.put(mapping);
      mounts.put({ ...mount, remoteMountNodeId: mapping.colpId, status: 'active' });
      const replace = (ids: readonly string[]) => ids.map(id => local && id === current?.colpId ? mapping.colpId : id);
      const selectedRoots = replace(scope.selectedRoots), privateRoots = replace(scope.privateRoots ?? []);
      tx.objectStore(STORES.scopes).put({ ...scope, selectedRoots, privateRoots });
      authority = { selectedRoots, privateRoots, rootStatus: scope.rootStatus ?? 'ready' }; bound = true;
    });
    if (authority) durableCache.set(key, clone(authority));
    return bound;
  }

  return { putMapping, deleteMapping, listMappings, getMappingByNativeId, getMappingByColpId, bindMountMapping, bindResolvedMountMapping,
    rebindProvisionalBookmarkIdentity, configureBrowserRoots, reconcileBrowserRoots, setBrowserRootStatus };
}

function validateQuarantine(input: unknown) {
  const row = strictObject(input, ['code', 'snapshotId', 'payloadDigest'], 'quarantine');
  return { code: boundedString(row.code, 'code'), snapshotId: boundedString(row.snapshotId, 'snapshotId'),
    payloadDigest: boundedString(row.payloadDigest, 'payloadDigest') };
}
