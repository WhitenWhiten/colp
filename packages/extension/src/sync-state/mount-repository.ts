import { digestJson } from '../bookmark-event-codec.js';
import { storeAttentionPages, loadAttentionPages } from './attention-pages.js';
import {
  SyncStateError, type BootstrapMode, type BootstrapRunRecord, type DeletionJournalRecord,
  type MountBindingRecord, type MountBindingStatus, type ScopePreviewRecord, type SpecialFolderRole,
  type SyncScope,
} from './types.js';
import { validateMountPauseBaseline } from './scope-facts-repository.js';
import { boundedString, clone, safeInteger, strictObject, validateJson, validateRecord } from './codec.js';
import { constraintError } from './errors.js';
import { cursorPage, requestValue, requireActiveScope, runTransaction, scopeRowsRange, transactionDone } from './idb.js';
import { INDEXES, STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import type { SyncStoreRuntime } from './runtime.js';
import type { PlannedMount } from '../bookmark-boundary.js';

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const SPECIAL_ROLES = new Set<string>(['bookmarks-bar', 'other-bookmarks', 'mobile-bookmarks']);

export function previewHasTitlesOrUrls(record: unknown): boolean {
  const encoded = JSON.stringify(record);
  return /"title"|"url"/u.test(encoded);
}

export function createMountRepository(ctx: SyncStoreRuntime) {
  const maxRecordBytes = ctx.maxRecordBytes;
  const writableDatabase = () => ctx.writableDatabase();
  const assertWritable = () => ctx.assertWritable();
  const open = () => ctx.open();

  async function putMountBinding(input: SyncScope, binding: Omit<MountBindingRecord, 'scopeKey'>): Promise<MountBindingRecord> {
    assertWritable(); const key = scopeKey(validateScope(input));
    const record = validateMountBinding(key, binding, maxRecordBytes);
    const db = await writableDatabase();
    try {
      await runTransaction(db, [STORES.scopes, STORES.mounts], 'readwrite', async (tx) => {
        await requireActiveScope(tx, key);
        tx.objectStore(STORES.mounts).put(record);
      });
    } catch (error) { throw constraintError(error); }
    return clone(record);
  }

  async function replaceMountBindings(input: SyncScope, bindings: readonly Omit<MountBindingRecord, 'scopeKey'>[]): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input));
    const records = bindings.map((binding) => validateMountBinding(key, binding, maxRecordBytes));
    const db = await writableDatabase();
    try {
      await runTransaction(db, [STORES.scopes, STORES.mounts], 'readwrite', async (tx) => {
        await requireActiveScope(tx, key);
        const store = tx.objectStore(STORES.mounts);
        const existing = await cursorPage<MountBindingRecord>(store, scopeRowsRange(key), Number.MAX_SAFE_INTEGER);
        for (const row of existing) store.delete([key, row.mountId]);
        for (const record of records) store.put(record);
      });
    } catch (error) { throw constraintError(error); }
  }

  async function listMountBindings(input: SyncScope): Promise<MountBindingRecord[]> {
    const key = scopeKey(validateScope(input)); const db = await open();
    const tx = db.transaction(STORES.mounts, 'readonly'); const completion = transactionDone(tx);
    const values = await cursorPage<MountBindingRecord>(tx.objectStore(STORES.mounts), scopeRowsRange(key),
      Number.MAX_SAFE_INTEGER); await completion;
    return values.map((value) => clone(validateMountBinding(key, value, maxRecordBytes)));
  }

  async function getMountBinding(input: SyncScope, mountId: string): Promise<MountBindingRecord | null> {
    const key = scopeKey(validateScope(input)); const db = await open();
    const tx = db.transaction(STORES.mounts, 'readonly'); const completion = transactionDone(tx);
    const value = await requestValue(tx.objectStore(STORES.mounts).get([key, boundedString(mountId, 'mountId')]));
    await completion;
    return value ? clone(validateMountBinding(key, value, maxRecordBytes)) : null;
  }

  async function detachMount(input: SyncScope, mountId: string,
    baseline?: NonNullable<MountBindingRecord['pauseBaseline']>): Promise<MountBindingRecord> {
    if (!baseline) return setMountStatus(input, mountId, 'detached');
    assertWritable(); const key = scopeKey(validateScope(input));
    const pauseBaseline = validateMountPauseBaseline(baseline);
    const db = await writableDatabase(); let updated!: MountBindingRecord;
    await runTransaction(db, [STORES.scopes, STORES.mounts], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const store = tx.objectStore(STORES.mounts);
      const current = await requestValue(store.get([key, boundedString(mountId, 'mountId')]));
      if (!current) throw new SyncStateError('mount_not_found');
      const prior = validateMountBinding(key, current, maxRecordBytes);
      updated = validateMountBinding(key, { ...prior, status: 'detached', pendingRemoteDelete: undefined, pauseBaseline },
        maxRecordBytes);
      store.put(updated);
    });
    return clone(updated);
  }

  async function putMountPauseBaseline(input: SyncScope, mountId: string,
    baseline: NonNullable<MountBindingRecord['pauseBaseline']>): Promise<MountBindingRecord> {
    assertWritable(); const key = scopeKey(validateScope(input));
    const pauseBaseline = validateMountPauseBaseline(baseline);
    const db = await writableDatabase(); let updated!: MountBindingRecord;
    await runTransaction(db, [STORES.scopes, STORES.mounts], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const store = tx.objectStore(STORES.mounts);
      const current = await requestValue(store.get([key, boundedString(mountId, 'mountId')]));
      if (!current) throw new SyncStateError('mount_not_found');
      const prior = validateMountBinding(key, current, maxRecordBytes);
      updated = validateMountBinding(key, { ...prior, pauseBaseline }, maxRecordBytes);
      store.put(updated);
    });
    return clone(updated);
  }

  async function rejoinMount(input: SyncScope, mountId: string): Promise<MountBindingRecord> {
    const current = await getMountBinding(input, mountId);
    if (!current) throw new SyncStateError('mount_not_found');
    return setMountStatus(input, mountId, 'active');
  }

  async function setMountStatus(input: SyncScope, mountId: string, status: MountBindingStatus): Promise<MountBindingRecord> {
    assertWritable(); const key = scopeKey(validateScope(input));
    const db = await writableDatabase(); let updated!: MountBindingRecord;
    await runTransaction(db, [STORES.scopes, STORES.mounts], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const store = tx.objectStore(STORES.mounts);
      const current = await requestValue(store.get([key, boundedString(mountId, 'mountId')]));
      if (!current) throw new SyncStateError('mount_not_found');
      const prior = validateMountBinding(key, current, maxRecordBytes);
      updated = validateMountBinding(key, { ...prior, status, pendingRemoteDelete: undefined }, maxRecordBytes);
      store.put(updated);
    });
    return clone(updated);
  }

  async function planRemoteDelete(input: SyncScope, command: {
    readonly mountId: string; readonly confirmationToken: string; readonly affectedCount: number;
    readonly opId?: string;
  }): Promise<MountBindingRecord> {
    assertWritable(); const key = scopeKey(validateScope(input));
    boundedString(command.confirmationToken, 'confirmationToken', 256);
    safeInteger(command.affectedCount, 'affectedCount');
    const db = await writableDatabase(); let updated!: MountBindingRecord;
    await runTransaction(db, [STORES.scopes, STORES.mounts], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      const store = tx.objectStore(STORES.mounts);
      const current = await requestValue(store.get([key, boundedString(command.mountId, 'mountId')]));
      if (!current) throw new SyncStateError('mount_not_found');
      const prior = validateMountBinding(key, current, maxRecordBytes);
      if (prior.pendingRemoteDelete?.opId) {
        if (prior.pendingRemoteDelete.confirmation !== command.confirmationToken
          || prior.pendingRemoteDelete.affectedCount !== command.affectedCount) throw new SyncStateError('remote_delete_command_pending');
        updated = prior; return;
      }
      updated = validateMountBinding(key, { ...prior, pendingRemoteDelete: {
        confirmation: command.confirmationToken, affectedCount: command.affectedCount,
        ...(command.opId ? { opId: command.opId } : {}) } }, maxRecordBytes);
      store.put(updated);
    });
    return clone(updated);
  }

  function isMountActive(binding: MountBindingRecord): boolean { return binding.status === 'active'; }

  async function putScopePreview(input: SyncScope, preview: Omit<ScopePreviewRecord, 'scopeKey'>): Promise<ScopePreviewRecord> {
    assertWritable(); const key = scopeKey(validateScope(input));
    const record = validateScopePreview(key, preview, maxRecordBytes);
    if (previewHasTitlesOrUrls(record)) throw new SyncStateError('preview_content_forbidden');
    const db = await writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.previews], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      tx.objectStore(STORES.previews).put(record);
    });
    return clone(record);
  }

  async function getScopePreview(input: SyncScope, previewId: string): Promise<ScopePreviewRecord | null> {
    const key = scopeKey(validateScope(input)); const db = await open();
    const tx = db.transaction(STORES.previews, 'readonly'); const completion = transactionDone(tx);
    const value = await requestValue(tx.objectStore(STORES.previews).get([key, boundedString(previewId, 'previewId')]));
    await completion;
    return value ? clone(validateScopePreview(key, value, maxRecordBytes)) : null;
  }

  async function putBootstrapRun(input: SyncScope, run: Omit<BootstrapRunRecord, 'scopeKey'>, expected?: BootstrapRunRecord): Promise<BootstrapRunRecord> {
    assertWritable(); const key = scopeKey(validateScope(input));
    const { attention: rawAttention, ...rest } = run;
    const attention = rawAttention ? validateAttention(rawAttention) : undefined;
    const record = validateBootstrapRun(key, { ...rest, ...(attention ? { attention: { ...attention, items: [] } } : {}) }, maxRecordBytes);
    const db = await writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.bootstrapRuns, STORES.diagnostics], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      if (expected) {
        const prior = await requestValue<BootstrapRunRecord | undefined>(tx.objectStore(STORES.bootstrapRuns).get([key, run.runId]));
        const current = prior && { ...prior, ...(prior.attention ? { attention: await loadAttentionPages(tx, key, prior.attention) } : {}) };
        if (!current || digestJson(JSON.parse(JSON.stringify(current))) !== digestJson(JSON.parse(JSON.stringify(expected)))) {
          throw new SyncStateError('bootstrap_confirmation_stale');
        }
      }
      const storedAttention = attention ? await storeAttentionPages(tx, key, attention, maxRecordBytes) : undefined;
      tx.objectStore(STORES.bootstrapRuns).put({ ...record, ...(storedAttention ? { attention: storedAttention } : {}) });
    });
    return clone({ ...record, ...(attention ? { attention } : {}) });
  }

  async function listBootstrapRuns(input: SyncScope): Promise<BootstrapRunRecord[]> {
    const key = scopeKey(validateScope(input)); const db = await open();
    const tx = db.transaction([STORES.bootstrapRuns, STORES.diagnostics], 'readonly'); const completion = transactionDone(tx);
    const values = await cursorPage<BootstrapRunRecord>(tx.objectStore(STORES.bootstrapRuns), scopeRowsRange(key),
      Number.MAX_SAFE_INTEGER);
    const hydrated = await Promise.all(values.map(async value => {
      const row = validateBootstrapRun(key, value, maxRecordBytes);
      return { ...row, ...(row.attention ? { attention: await loadAttentionPages(tx, key, row.attention) } : {}) };
    }));
    await completion; return hydrated;
  }

  async function currentBootstrapMode(input: SyncScope): Promise<BootstrapMode> {
    const runs = await listBootstrapRuns(input);
    const live = [...runs].sort((left, right) => right.updatedAt - left.updatedAt)
      .find((run) => run.phase !== 'completed');
    return live?.bootstrapMode ?? 'merge';
  }

  async function putDeletionJournal(input: SyncScope, row: Omit<DeletionJournalRecord, 'scopeKey'>): Promise<DeletionJournalRecord> {
    assertWritable(); const key = scopeKey(validateScope(input));
    const record = validateDeletionJournal(key, row, maxRecordBytes);
    const db = await writableDatabase();
    await runTransaction(db, [STORES.scopes, STORES.deletionJournal], 'readwrite', async (tx) => {
      await requireActiveScope(tx, key);
      tx.objectStore(STORES.deletionJournal).put(record);
    });
    return clone(record);
  }

  async function listDeletionJournal(input: SyncScope, nativeId?: string): Promise<DeletionJournalRecord[]> {
    const key = scopeKey(validateScope(input)); const db = await open();
    const tx = db.transaction(STORES.deletionJournal, 'readonly'); const completion = transactionDone(tx);
    const range = nativeId
      ? IDBKeyRange.bound([key, boundedString(nativeId, 'nativeId')], [key, nativeId, []])
      : scopeRowsRange(key);
    const values = await cursorPage<DeletionJournalRecord>(tx.objectStore(STORES.deletionJournal), range,
      Number.MAX_SAFE_INTEGER); await completion;
    return values.map((value) => clone(validateDeletionJournal(key, value, maxRecordBytes)));
  }

  async function bumpBoundaryVersion(input: SyncScope): Promise<string> {
    assertWritable(); const key = scopeKey(validateScope(input));
    const db = await writableDatabase(); let next = '1';
    await runTransaction(db, [STORES.scopes], 'readwrite', async (tx) => {
      const scope = await requireActiveScope(tx, key);
      const current = Number.parseInt(scope.boundaryVersion ?? '0', 10);
      next = String(Number.isFinite(current) ? current + 1 : 1);
      tx.objectStore(STORES.scopes).put({ ...scope, boundaryVersion: next });
    });
    return next;
  }

  async function setFirstRun(input: SyncScope, firstRun: NonNullable<import('./types.js').ScopeRecord['firstRun']>): Promise<void> {
    assertWritable(); const key = scopeKey(validateScope(input));
    const db = await writableDatabase();
    await runTransaction(db, [STORES.scopes], 'readwrite', async (tx) => {
      const scope = await requireActiveScope(tx, key);
      // A stale Later click cannot undo an admission or completion in another page.
      if (firstRun === 'deferred' && (scope.firstRun === 'running' || scope.firstRun === 'completed')) return;
      tx.objectStore(STORES.scopes).put({ ...scope, firstRun });
    });
  }

  async function hasActiveMounts(input: SyncScope): Promise<boolean> {
    const mounts = await listMountBindings(input);
    return mounts.some((mount) => mount.status !== 'detached');
  }

  return { putMountBinding, replaceMountBindings, listMountBindings, getMountBinding, detachMount, rejoinMount,
    putMountPauseBaseline,
    planRemoteDelete, isMountActive, hasActiveMounts, putScopePreview, getScopePreview, putBootstrapRun, listBootstrapRuns,
    currentBootstrapMode, putDeletionJournal, listDeletionJournal, bumpBoundaryVersion, setFirstRun };
}

export function mountsFromPlan(scopeKeyValue: string, plan: readonly PlannedMount[], boundaryVersion: string,
  status: MountBindingStatus = 'pending'): Omit<MountBindingRecord, 'scopeKey'>[] {
  return plan.filter((mount) => mount.writable).map((mount) => ({
    mountId: crypto.randomUUID(), nativeRootId: mount.nativeRootId, remoteMountNodeId: null,
    boundaryVersion, materialized: mount.materialized, status,
    ...(mount.rootRole ? { rootRole: mount.rootRole } : {}),
    ...(mount.customSourceKey ? { customSourceKey: mount.customSourceKey } : {}),
  }));
}

export { PREVIEW_TTL_MS };

export function validateMountBinding(key: string, input: unknown, maxBytes: number): MountBindingRecord {
  const value = strictObject(clone(input), ['scopeKey', 'mountId', 'nativeRootId', 'remoteMountNodeId',
    'boundaryVersion', 'materialized', 'status', 'rootRole', 'customSourceKey', 'lastReconcile',
    'pendingRemoteDelete', 'pendingShift', 'pauseBaseline'], 'mount binding',
    ['scopeKey', 'rootRole', 'customSourceKey', 'lastReconcile', 'pendingRemoteDelete', 'pendingShift',
      'pauseBaseline']);
  if (value.scopeKey !== undefined && value.scopeKey !== key) throw new SyncStateError('mount_scope_invalid');
  const status = String(value.status);
  if (!['pending', 'active', 'detached'].includes(status)) throw new SyncStateError('mount_status_invalid');
  const rootRole = value.rootRole === undefined ? undefined : String(value.rootRole);
  if (rootRole !== undefined && !SPECIAL_ROLES.has(rootRole)) throw new SyncStateError('root_role_invalid');
  if (rootRole && value.customSourceKey !== undefined) throw new SyncStateError('mount_role_invalid');
  if (!rootRole && typeof value.customSourceKey !== 'string') throw new SyncStateError('mount_role_invalid');
  const record: MountBindingRecord = { scopeKey: key, mountId: boundedString(value.mountId, 'mountId'),
    nativeRootId: boundedString(value.nativeRootId, 'nativeRootId'),
    remoteMountNodeId: value.remoteMountNodeId === null ? null : boundedString(value.remoteMountNodeId, 'remoteMountNodeId'),
    boundaryVersion: boundedString(value.boundaryVersion, 'boundaryVersion', 64),
    materialized: value.materialized === true, status: status as MountBindingStatus,
    ...(rootRole ? { rootRole: rootRole as SpecialFolderRole } : {}),
    ...(value.customSourceKey === undefined ? {} : { customSourceKey: boundedString(value.customSourceKey, 'customSourceKey') }),
    ...(value.lastReconcile === undefined ? {} : { lastReconcile: validateLastReconcile(value.lastReconcile) }),
    ...(value.pendingRemoteDelete === undefined ? {} : {
      pendingRemoteDelete: validatePendingRemoteDelete(value.pendingRemoteDelete) }),
    ...(value.pendingShift === undefined ? {} : { pendingShift: validatePendingShift(value.pendingShift) }),
    ...(value.pauseBaseline === undefined ? {} : { pauseBaseline: validateMountPauseBaseline(value.pauseBaseline) }) };
  validateRecord(record, maxBytes); return record;
}

function validateLastReconcile(value: unknown): NonNullable<MountBindingRecord['lastReconcile']> {
  const row = strictObject(clone(value), ['treeDigest', 'at'], 'lastReconcile');
  return { treeDigest: boundedString(row.treeDigest, 'treeDigest'), at: safeInteger(row.at, 'at') };
}

function validatePendingRemoteDelete(value: unknown): NonNullable<MountBindingRecord['pendingRemoteDelete']> {
  const row = strictObject(clone(value), ['confirmation', 'affectedCount', 'opId'], 'pendingRemoteDelete', ['opId']);
  return { confirmation: boundedString(row.confirmation, 'confirmation', 256),
    affectedCount: safeInteger(row.affectedCount, 'affectedCount'),
    ...(row.opId === undefined ? {} : { opId: boundedString(row.opId, 'opId') }) };
}

function validatePendingShift(value: unknown): NonNullable<MountBindingRecord['pendingShift']> {
  const row = strictObject(clone(value), ['colpId', 'fromParentNativeId', 'toParentNativeId'], 'pendingShift',
    ['fromParentNativeId', 'toParentNativeId']);
  return { colpId: boundedString(row.colpId, 'colpId'),
    ...(row.fromParentNativeId === undefined ? {} : {
      fromParentNativeId: boundedString(row.fromParentNativeId, 'fromParentNativeId') }),
    ...(row.toParentNativeId === undefined ? {} : {
      toParentNativeId: boundedString(row.toParentNativeId, 'toParentNativeId') }) };
}

function validateScopePreview(key: string, input: unknown, maxBytes: number): ScopePreviewRecord {
  const value = strictObject(clone(input), ['scopeKey', 'previewId', 'boundaryVersion', 'treeDigest',
    'bookmarkCount', 'folderCount', 'skippedCount', 'expiresAt', 'warnings', 'boundary', 'kind',
    'consumedAt', 'consumedBy', 'boundaryDigest', 'addedNativeIds', 'removedNativeIds', 'privateNativeIds',
    'shiftNativeIds', 'remoteDeleteEvidence'], 'scope preview',
    ['scopeKey', 'kind', 'consumedAt', 'consumedBy', 'boundaryDigest', 'addedNativeIds', 'removedNativeIds',
      'privateNativeIds', 'shiftNativeIds', 'remoteDeleteEvidence']);
  if (value.scopeKey !== undefined && value.scopeKey !== key) throw new SyncStateError('preview_scope_invalid');
  if (previewHasTitlesOrUrls(value)) throw new SyncStateError('preview_content_forbidden');
  const boundary = strictObject(value.boundary, ['selectedNativeIds', 'excludedNativeIds', 'mounts'], 'preview boundary');
  if (!Array.isArray(boundary.selectedNativeIds) || !Array.isArray(boundary.excludedNativeIds)
      || !Array.isArray(boundary.mounts)) throw new SyncStateError('preview_boundary_invalid');
  const warnings = Array.isArray(value.warnings) ? value.warnings.map((item) => {
    const row = strictObject(clone(item), ['code', 'count'], 'preview warning', ['count']);
    return { code: boundedString(row.code, 'warning.code', 128),
      ...(row.count === undefined ? {} : { count: safeInteger(row.count, 'warning.count', 1) }) };
  }) : [];
  if (value.kind !== undefined && value.kind !== 'range') throw new SyncStateError('preview_kind_invalid');
  const ids = (input: unknown, label: string) => Array.isArray(input)
    ? input.map((id) => boundedString(id, label)) : undefined;
  const record: ScopePreviewRecord = { scopeKey: key, previewId: boundedString(value.previewId, 'previewId'),
    boundaryVersion: boundedString(value.boundaryVersion, 'boundaryVersion', 64),
    treeDigest: boundedString(value.treeDigest, 'treeDigest'),
    bookmarkCount: safeInteger(value.bookmarkCount, 'bookmarkCount'),
    folderCount: safeInteger(value.folderCount, 'folderCount'),
    skippedCount: safeInteger(value.skippedCount, 'skippedCount'),
    expiresAt: safeInteger(value.expiresAt, 'expiresAt', 1), warnings,
    boundary: { selectedNativeIds: boundary.selectedNativeIds.map((id) => boundedString(id, 'selectedNativeId')),
      excludedNativeIds: boundary.excludedNativeIds.map((id) => boundedString(id, 'excludedNativeId')),
      mounts: boundary.mounts.map((mount) => validatePreviewMount(mount)) },
    ...(value.kind === 'range' ? { kind: 'range' as const } : {}),
    ...(value.consumedAt === undefined ? {} : { consumedAt: safeInteger(value.consumedAt, 'consumedAt') }),
    ...(value.consumedBy === undefined ? {} : { consumedBy: boundedString(value.consumedBy, 'consumedBy') }),
    ...(value.boundaryDigest === undefined ? {} : { boundaryDigest: boundedString(value.boundaryDigest, 'boundaryDigest') }),
    ...(ids(value.addedNativeIds, 'addedNativeId') ? { addedNativeIds: ids(value.addedNativeIds, 'addedNativeId') } : {}),
    ...(ids(value.removedNativeIds, 'removedNativeId') ? { removedNativeIds: ids(value.removedNativeIds, 'removedNativeId') } : {}),
    ...(ids(value.privateNativeIds, 'privateNativeId') ? { privateNativeIds: ids(value.privateNativeIds, 'privateNativeId') } : {}),
    ...(ids(value.shiftNativeIds, 'shiftNativeId') ? { shiftNativeIds: ids(value.shiftNativeIds, 'shiftNativeId') } : {}),
    ...(value.remoteDeleteEvidence === undefined ? {}
      : { remoteDeleteEvidence: validateRemoteDeleteEvidence(value.remoteDeleteEvidence) }) };
  validateRecord(record, maxBytes); return record;
}

function validateRemoteDeleteEvidence(input: unknown): NonNullable<ScopePreviewRecord['remoteDeleteEvidence']> {
  if (!Array.isArray(input)) throw new SyncStateError('preview_remote_evidence_invalid');
  return input.map((item) => {
    const row = strictObject(clone(item),
      ['nativeRootId', 'mountId', 'remoteMountNodeId', 'affectedCount', 'boundaryVersion', 'subtreeSource', 'contentDeletes'],
      'preview remote evidence', ['subtreeSource', 'contentDeletes']);
    return {
      nativeRootId: boundedString(row.nativeRootId, 'nativeRootId'),
      mountId: boundedString(row.mountId, 'mountId'),
      remoteMountNodeId: boundedString(row.remoteMountNodeId, 'remoteMountNodeId'),
      affectedCount: safeInteger(row.affectedCount, 'affectedCount'),
      boundaryVersion: boundedString(row.boundaryVersion, 'boundaryVersion', 64),
      ...(row.contentDeletes === undefined ? {} : { contentDeletes: validateContentDeletes(row.contentDeletes) }),
      ...(row.subtreeSource === undefined ? {} : { subtreeSource: clone(row.subtreeSource) as import('./types.js').JsonObject }),
    };
  });
}

function validatePreviewMount(input: unknown): ScopePreviewRecord['boundary']['mounts'][number] {
  const value = strictObject(clone(input), ['nativeRootId', 'writable', 'materialized', 'rootRole', 'customSourceKey'],
    'preview mount', ['rootRole', 'customSourceKey']);
  return { nativeRootId: boundedString(value.nativeRootId, 'nativeRootId'), writable: value.writable === true,
    materialized: value.materialized === true,
    ...(value.rootRole === undefined ? {} : { rootRole: boundedString(value.rootRole, 'rootRole') as SpecialFolderRole }),
    ...(value.customSourceKey === undefined ? {} : { customSourceKey: boundedString(value.customSourceKey, 'customSourceKey') }) };
}

function validateBootstrapRun(key: string, input: unknown, maxBytes: number): BootstrapRunRecord {
  const value = strictObject(clone(input), ['scopeKey', 'runId', 'phase', 'bootstrapMode', 'confirmationId',
    'updatedAt', 'reportDigest', 'snapshotCursor', 'resumeCursor', 'confirmationVersion', 'previewId',
    'treeDigest', 'libraryId', 'retryReason', 'mountResolveRequest', 'previewOnly', 'destructiveConfirmed',
    'attention'],
  'bootstrap run', ['scopeKey', 'reportDigest', 'snapshotCursor', 'resumeCursor', 'confirmationVersion',
    'previewId', 'treeDigest', 'libraryId', 'retryReason', 'mountResolveRequest', 'previewOnly',
    'destructiveConfirmed', 'attention']);
  if (value.scopeKey !== undefined && value.scopeKey !== key) throw new SyncStateError('bootstrap_scope_invalid');
  const phase = String(value.phase);
  if (!['draft', 'confirmed', 'scanning', 'matching', 'syncing', 'completed', 'needs_attention'].includes(phase)) {
    throw new SyncStateError('bootstrap_phase_invalid');
  }
  const bootstrapMode = String(value.bootstrapMode);
  if (!['download', 'upload', 'merge', 'mirror'].includes(bootstrapMode)) throw new SyncStateError('bootstrap_mode_invalid');
  const record: BootstrapRunRecord = { scopeKey: key, runId: boundedString(value.runId, 'runId'),
    phase: phase as BootstrapRunRecord['phase'], bootstrapMode: bootstrapMode as BootstrapMode,
    confirmationId: boundedString(value.confirmationId, 'confirmationId'),
    updatedAt: safeInteger(value.updatedAt, 'updatedAt', 1),
    ...(value.reportDigest === undefined ? {} : { reportDigest: boundedString(value.reportDigest, 'reportDigest') }),
    ...(value.snapshotCursor === undefined ? {} : { snapshotCursor: boundedString(value.snapshotCursor, 'snapshotCursor') }),
    ...(value.resumeCursor === undefined ? {} : { resumeCursor: boundedString(value.resumeCursor, 'resumeCursor') }),
    ...(value.confirmationVersion === undefined ? {} : {
      confirmationVersion: boundedString(value.confirmationVersion, 'confirmationVersion', 64) }),
    ...(value.previewId === undefined ? {} : { previewId: boundedString(value.previewId, 'previewId') }),
    ...(value.treeDigest === undefined ? {} : { treeDigest: boundedString(value.treeDigest, 'treeDigest') }),
    ...(value.libraryId === undefined ? {} : { libraryId: boundedString(value.libraryId, 'libraryId') }),
    ...(value.retryReason === undefined ? {} : { retryReason: boundedString(value.retryReason, 'retryReason', 128) }),
    ...(value.mountResolveRequest === undefined ? {} : {
      mountResolveRequest: boundedString(value.mountResolveRequest, 'mountResolveRequest', 256) }),
    ...(value.previewOnly === true ? { previewOnly: true } : {}),
    ...(value.destructiveConfirmed === true ? { destructiveConfirmed: true } : {}),
    ...(value.attention === undefined ? {} : { attention: validateAttention(value.attention) }) };
  validateRecord(record, maxBytes); return record;
}

function validateAttention(input: unknown): BootstrapRunRecord['attention'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SyncStateError('bootstrap_attention_invalid');
  const value = input as Record<string, unknown>;
  if (value.version !== 1 || typeof value.reportId !== 'string' || !Array.isArray(value.items)) {
    throw new SyncStateError('bootstrap_attention_invalid');
  }
  const items = value.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new SyncStateError('bootstrap_attention_invalid');
    const row = item as Record<string, unknown>;
    if (typeof row.itemId !== 'string' || (row.kind !== 'duplicate_candidate' && row.kind !== 'conflict' && row.kind !== 'local_difference')
        || (row.decision !== 'open' && row.decision !== 'keep_both')) {
      throw new SyncStateError('bootstrap_attention_invalid');
    }
    return {
      itemId: boundedString(row.itemId, 'itemId'),
      ...(Array.isArray(row.parentRefs) ? { parentRefs: row.parentRefs.slice(0, 2).map(ref => boundedString(ref, 'parentRef')) } : {}),
      ...(typeof row.evidenceDigest === 'string' ? { evidenceDigest: boundedString(row.evidenceDigest, 'evidenceDigest') } : {}),
      ...(Array.isArray(row.resolutionOpIds) ? { resolutionOpIds: row.resolutionOpIds.map(id => boundedString(id, 'opId')) } : {}),
      ...(Array.isArray(row.nodeRefs) ? { nodeRefs: row.nodeRefs.map(ref => boundedString(ref, 'nodeRef')) } : {}),
      kind: row.kind as 'duplicate_candidate' | 'local_difference' | 'conflict',
      locationCount: safeInteger(row.locationCount, 'locationCount', 1),
      decision: row.decision as 'open' | 'keep_both',
    };
  });
  return {
    reportId: boundedString(value.reportId, 'reportId'), version: 1,
    candidateCount: safeInteger(value.candidateCount, 'candidateCount'),
    conflictCount: safeInteger(value.conflictCount, 'conflictCount'),
    localOnlyCount: safeInteger(value.localOnlyCount, 'localOnlyCount'),
    remoteOnlyCount: safeInteger(value.remoteOnlyCount, 'remoteOnlyCount'),
    matchedCount: safeInteger(value.matchedCount, 'matchedCount'),
    ...(value.pageCount === undefined ? {} : { pageCount: safeInteger(value.pageCount, 'pageCount') }),
    items, createdAt: safeInteger(value.createdAt, 'createdAt', 1),
  };
}

function validateDeletionJournal(key: string, input: unknown, maxBytes: number): DeletionJournalRecord {
  const value = strictObject(clone(input), ['scopeKey', 'nativeId', 'ordinal', 'kind', 'parentNativeId', 'position',
    'mountId', 'contentDigest'], 'deletion journal',
    ['scopeKey', 'parentNativeId', 'position', 'mountId', 'contentDigest']);
  if (value.scopeKey !== undefined && value.scopeKey !== key) throw new SyncStateError('journal_scope_invalid');
  const kind = String(value.kind);
  if (!['folder', 'bookmark', 'separator'].includes(kind)) throw new SyncStateError('journal_kind_invalid');
  const record: DeletionJournalRecord = { scopeKey: key, nativeId: boundedString(value.nativeId, 'nativeId'),
    ordinal: safeInteger(value.ordinal, 'ordinal', 1), kind: kind as DeletionJournalRecord['kind'],
    ...(value.parentNativeId === undefined ? {} : { parentNativeId: boundedString(value.parentNativeId, 'parentNativeId') }),
    ...(value.position === undefined ? {} : { position: safeInteger(value.position, 'position') }),
    ...(value.mountId === undefined ? {} : { mountId: boundedString(value.mountId, 'mountId') }),
    ...(value.contentDigest === undefined ? {} : { contentDigest: boundedString(value.contentDigest, 'contentDigest') }) };
  validateJson(record as never, 'deletion journal'); validateRecord(record, maxBytes); return record;
}

function validateContentDeletes(input: unknown): NonNullable<import('./types.js').RemoteDeleteFreezeEntry['contentDeletes']> {
  if (!Array.isArray(input)) throw new SyncStateError('preview_remote_evidence_invalid');
  return input.map(item => {
    const row = strictObject(clone(item), ['targetId', 'kind', 'baseRevision', 'source'], 'content delete');
    if (!['folder', 'bookmark', 'separator'].includes(String(row.kind))) throw new SyncStateError('preview_remote_evidence_invalid');
    return { targetId: boundedString(row.targetId, 'targetId'), kind: row.kind as 'folder' | 'bookmark' | 'separator',
      baseRevision: boundedString(row.baseRevision, 'baseRevision'), source: clone(row.source) as import('./types.js').JsonObject };
  });
}
