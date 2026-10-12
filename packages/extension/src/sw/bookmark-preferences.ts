import { readCaptureControl, updateCaptureControl } from '../capture/control.js';
import { accountDefaultsDiffer, devicePreferencePatch, effectiveDevicePreferences } from '../device-bookmark-preferences.js';
import {
  BOOKMARK_PREFERENCES_CACHE, BOOKMARK_PREFERENCE_KEYS, bookmarkPreferencesScopeKey, canonicalServerOrigin,
  defaultBookmarkPreferencesRecord, normalizeBookmarkPreferences, parseBookmarkPreferencesCache,
  preferencesEtag, type BookmarkPreferences, type BookmarkPreferencesCacheRecord,
} from '../bookmark-preferences.js';
import { BookmarkPreferencesProductError, createBookmarkPreferencesProductClient } from '../bookmark-preferences-product-client.js';
import type { BookmarkPreferencesRequest, BookmarkPreferencesResponse } from '../types.js';
import { store } from './runtime.js';
import { loadConfig } from './scope.js';

type CacheMap = Record<string, unknown>;
interface PreferenceIdentity {
  readonly origin: string;
  readonly subject: string | null;
  readonly generation: number;
  readonly revoked: boolean;
  readonly manualStopToken?: string;
}
let preferenceLane: Promise<void> = Promise.resolve();
let syncing: Promise<void> | undefined;
let syncRequested = false;

export function handleBookmarkPreferencesRequest(request: BookmarkPreferencesRequest): Promise<BookmarkPreferencesResponse> {
  // Read-only callers must not queue behind Product HTTP or write a default
  // record concurrently with a pending mutation's read/modify/write cycle.
  if (request.kind === 'known.bookmark.preferences.local') return localPreferencesResponse();
  const captured = (async () => {
    const identity = await preferenceIdentity();
    if (request.kind === 'known.bookmark.preferences.update' && request.captureMode === 'manual') {
      await assertCurrent(identity);
      await updateCaptureControl({ serverOrigin: identity.origin, accountId: identity.subject, authorityGeneration: identity.generation, collectionId: null },
        control => ({ ...control, manualOverride: true, manualStopToken: crypto.randomUUID(), generation: control.generation + 1 }));
    }
    const control = await readCaptureControl({ serverOrigin: identity.origin, accountId: identity.subject, authorityGeneration: identity.generation, collectionId: null });
    return { ...identity, manualStopToken: control.manualStopToken };
  })();
  // Observe capture failures immediately even while an earlier HTTP call owns the lane.
  void captured.catch(() => undefined);
  return serial(async () => {
    const identity = await captured;
    await assertCurrent(identity);
    const result = await handleRequest(request, identity);
    if (result.ok && result.preferences.captureMode === 'automatic' && (request.kind === 'known.bookmark.preferences.update' && request.captureMode === 'automatic'
      || request.kind === 'known.bookmark.preferences.resolve')) {
      await updateCaptureControl({ serverOrigin: identity.origin, accountId: identity.subject, authorityGeneration: identity.generation, collectionId: null },
        control => !control.manualOverride || control.manualStopToken !== identity.manualStopToken ? control : { ...control, manualOverride: false, generation: control.generation + 1 });
    }
    await assertCurrent(identity);
    return result;
  });
}

async function handleRequest(request: Exclude<BookmarkPreferencesRequest,
  { readonly kind: 'known.bookmark.preferences.local' }>, identity: PreferenceIdentity): Promise<BookmarkPreferencesResponse> {
  let record = await readRecord(identity.origin, identity.subject);
  if (!record) {
    record = defaultBookmarkPreferencesRecord(identity.origin, identity.subject, 0);
    await writeRecord(record, identity);
  }
  if (identity.subject && !await readRecord(identity.origin, null)) {
    const device = defaultBookmarkPreferencesRecord(identity.origin, null, Date.now());
    await writeRecord({ ...device, value: effectiveDevicePreferences(device.value, record.value) }, identity);
  }
  if (request.kind === 'known.bookmark.preferences.get') {
    requestSync(identity);
    return response(record, record.updatedAt === 0 ? 'default' : 'cache', identity.subject ? 'account' : 'device');
  }
  if (request.kind === 'known.bookmark.preferences.resolve') {
    const conflict = record.conflict;
    if (!conflict) {
      if (identity.subject && request.choice === 'server') await writeRecord(record, identity, record.value);
      return response(record, 'cache', identity.subject ? 'account' : 'device');
    }
    if (request.choice === 'server') {
      record = { ...record, value: conflict.remote, revision: conflict.remoteRevision,
        etag: conflict.remoteEtag, conflict: undefined, pending: undefined, updatedAt: Date.now() };
      await writeRecord(record, identity, conflict.remote);
    } else {
      const patch = conflict.patch ?? Object.fromEntries(BOOKMARK_PREFERENCE_KEYS
        .filter(key => conflict.local[key] !== undefined && conflict.local[key] !== conflict.remote[key])
        .map(key => [key, conflict.local[key]]));
      const value = normalizeBookmarkPreferences({ ...conflict.remote, ...patch });
      if (!value) return { ok: false, error: 'preferences_unavailable' };
      record = { ...record, value, revision: conflict.remoteRevision,
        etag: conflict.remoteEtag, conflict: undefined,
        pending: { commandId: crypto.randomUUID().toLowerCase(), value, patch,
          ifMatch: conflict.remoteEtag, baseRevision: conflict.remoteRevision, updatedAt: Date.now() },
        updatedAt: Date.now() };
      await writeRecord(record, identity, patch);
      requestSync(identity);
    }
    return response(record, 'cache', identity.subject ? 'account' : 'device');
  }
  const intent = Object.fromEntries(BOOKMARK_PREFERENCE_KEYS.filter(key => Object.hasOwn(request, key))
    .map(key => [key, request[key]])) as Partial<BookmarkPreferences>;
  const next = normalizeBookmarkPreferences({
    ...await effectivePreferences(record),
    captureMode: request.captureMode ?? record.value.captureMode,
    resultPanelAutoDismissMs: request.resultPanelAutoDismissMs ?? record.value.resultPanelAutoDismissMs,
    learnFromCorrections: request.learnFromCorrections ?? record.value.learnFromCorrections,
    resumeClassificationWhenOnline: request.resumeClassificationWhenOnline ?? record.value.resumeClassificationWhenOnline,
    aiTagMode: request.aiTagMode ?? record.value.aiTagMode,
    subscriptionOnUnfollow: request.subscriptionOnUnfollow !== undefined ? request.subscriptionOnUnfollow : record.value.subscriptionOnUnfollow,
    subscriptionOnUnsubscribe: request.subscriptionOnUnsubscribe !== undefined ? request.subscriptionOnUnsubscribe : record.value.subscriptionOnUnsubscribe,
    subscriptionDefaultCheckIntervalMinutes: request.subscriptionDefaultCheckIntervalMinutes !== undefined ? request.subscriptionDefaultCheckIntervalMinutes : record.value.subscriptionDefaultCheckIntervalMinutes,
    subscriptionDefaultDigestMode: request.subscriptionDefaultDigestMode !== undefined ? request.subscriptionDefaultDigestMode : record.value.subscriptionDefaultDigestMode,
    subscriptionDefaultEditionLimit: request.subscriptionDefaultEditionLimit !== undefined ? request.subscriptionDefaultEditionLimit : record.value.subscriptionDefaultEditionLimit,
    bookmarkInsertPosition: request.bookmarkInsertPosition ?? record.value.bookmarkInsertPosition,
    foldersFirst: request.foldersFirst ?? record.value.foldersFirst,
  });
  if (!next) return { ok: false, error: 'preferences_unavailable' };
  if (record.conflict) return response(record, 'cache', 'account');
  if (!identity.subject) {
    const revision = `device-${Date.now().toString(36)}`;
    record = { ...record, value: next, revision, etag: preferencesEtag(revision), pending: undefined, conflict: undefined, updatedAt: Date.now() };
    await writeRecord(record, identity, intent);
    return response(record, 'cache', 'device');
  }
  const commandId = crypto.randomUUID().toLowerCase();
  const base = record;
  record = { ...record, value: next, revision: base.revision, etag: base.etag, conflict: undefined,
    pending: { commandId, value: next, patch: { ...(base.pending?.patch ?? base.pending?.value ?? {}), ...intent }, ifMatch: base.etag, baseRevision: base.revision, updatedAt: Date.now() }, updatedAt: Date.now() };
  await writeRecord(record, identity, intent);
  requestSync(identity);
  return response(record, 'cache', 'account');
}

export function flushBookmarkPreferences(): Promise<void> {
  syncRequested = true;
  return syncing ??= syncPreferences().finally(() => {
    syncing = undefined;
    if (syncRequested) void flushBookmarkPreferences().catch(() => undefined);
  });
}

function requestSync(identity: PreferenceIdentity): void {
  if (identity.subject && online()) void flushBookmarkPreferences().catch(() => undefined);
}

/** Local-only effective read for native save paths; it never waits on Product HTTP. */
export async function readEffectiveBookmarkPreferences(): Promise<BookmarkPreferences> {
  return effectivePreferences(await localPreferencesRecord());
}

/** Backup settings belong to this profile; restoring them creates no account outbox command. */
export function restoreDeviceBookmarkPreferences(patch: Partial<BookmarkPreferences>): Promise<void> {
  return serial(async () => {
    const identity = await preferenceIdentity();
    const current = await readRecord(identity.origin, null) ?? defaultBookmarkPreferencesRecord(identity.origin, null);
    const value = normalizeBookmarkPreferences({ ...current.value, ...devicePreferencePatch(patch) });
    if (!value) throw new Error('backup_invalid');
    await assertCurrent(identity);
    await updateCaptureControl({ serverOrigin: identity.origin, accountId: identity.subject, authorityGeneration: identity.generation, collectionId: null },
      control => ({ ...control, manualOverride: true, manualStopToken: crypto.randomUUID(), generation: control.generation + 1 }));
    await writeRecord({ ...current, value, updatedAt: Date.now() }, identity);
  });
}

async function effectivePreferences(record: BookmarkPreferencesCacheRecord): Promise<BookmarkPreferences> {
  const device = record.subject ? await readRecord(record.serverOrigin, null) : record;
  return effectiveDevicePreferences(record.value, device?.value ?? record.value);
}

async function localPreferencesRecord(): Promise<BookmarkPreferencesCacheRecord> {
  const identity = await preferenceIdentity();
  const record = (await readRecord(identity.origin, identity.subject))
    ?? defaultBookmarkPreferencesRecord(identity.origin, identity.subject, 0);
  await assertCurrent(identity);
  return record;
}

async function localPreferencesResponse(): Promise<BookmarkPreferencesResponse> {
  const record = await localPreferencesRecord();
  return response(record, record.updatedAt === 0 ? 'default' : 'cache', record.subject ? 'account' : 'device');
}

/** Network work never holds the local mutation lane. Receipts merge against the latest local intent. */
async function syncPreferences(): Promise<void> {
  while (syncRequested) {
    syncRequested = false;
    const { identity, record } = await serial(async () => {
      const identity = await preferenceIdentity();
      return { identity, record: await readRecord(identity.origin, identity.subject) };
    });
    if (!identity.subject || !online() || !record || record.conflict) continue;
    try {
      const remote = record.pending
        ? await client(identity).patch(record.pending.patch ?? record.pending.value, record.pending.commandId, record.pending.ifMatch)
        : await client(identity).read();
      await applyRemote(identity, record, remote, false);
    } catch (error) {
      if (record.pending && error instanceof BookmarkPreferencesProductError && error.status === 412) {
        try { await applyRemote(identity, record, await client(identity).read(), true); }
        catch { /* Pending intent survives network failure and authority changes. */ }
      }
    }
  }
}

async function applyRemote(identity: PreferenceIdentity, sent: BookmarkPreferencesCacheRecord,
  remote: { value: BookmarkPreferences; revision: string; etag: string }, conflict: boolean): Promise<void> {
  await serial(async () => {
    await assertCurrent(identity);
    const latest = await readRecord(identity.origin, identity.subject);
    if (!latest || latest.conflict) return;
    const now = Date.now();
    if (conflict && latest.pending) {
      await writeRecord({ ...latest, pending: undefined, updatedAt: now,
        conflict: { local: latest.pending.value, remote: remote.value, patch: latest.pending.patch,
          remoteRevision: remote.revision, remoteEtag: remote.etag, updatedAt: now } }, identity);
      return;
    }
    const settled = latest.pending && sent.pending?.commandId === latest.pending.commandId;
    if (latest.pending && !settled) {
      const patch = latest.pending.patch ?? latest.pending.value;
      const value = normalizeBookmarkPreferences({ ...remote.value, ...patch });
      if (!value) return;
      await writeRecord({ ...latest, value, revision: remote.revision, etag: remote.etag, updatedAt: now,
        pending: { ...latest.pending, value, ifMatch: remote.etag, baseRevision: remote.revision } }, identity);
      syncRequested = true;
      return;
    }
    if (!latest.pending && (latest.revision !== sent.revision || latest.updatedAt !== sent.updatedAt)) return;
    await writeRecord({ ...latest, value: remote.value, revision: remote.revision, etag: remote.etag,
      pending: undefined, conflict: undefined, updatedAt: now }, identity);
  });
}

async function preferenceIdentity(): Promise<PreferenceIdentity> {
  const [config, credential, authority] = await Promise.all([loadConfig(), store.loadCredential(), store.fence.read()]);
  const origin = canonicalServerOrigin(config.serverOrigin);
  return { origin, ...authority,
    subject: credential && canonicalServerOrigin(credential.serverOrigin) === origin && credential.subject ? credential.subject : null };
}

async function assertCurrent(identity: PreferenceIdentity): Promise<void> {
  const current = await preferenceIdentity();
  if (current.origin !== identity.origin || current.subject !== identity.subject
      || current.generation !== identity.generation || current.revoked !== identity.revoked) throw new Error('authority_fenced');
}

function client(identity: PreferenceIdentity) {
  if (!identity.subject) throw new Error('authority_fenced');
  return createBookmarkPreferencesProductClient({ serverOrigin: identity.origin, expectedAuthUserId: identity.subject,
    assertCurrent: () => assertCurrent(identity) });
}

async function readRecord(origin: string, subject: string | null): Promise<BookmarkPreferencesCacheRecord | undefined> {
  const key = bookmarkPreferencesScopeKey(origin, subject);
  const raw = (await chrome.storage.local.get(BOOKMARK_PREFERENCES_CACHE))[BOOKMARK_PREFERENCES_CACHE];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const records = (raw as Record<string, unknown>).records;
  if (!records || typeof records !== 'object' || Array.isArray(records)) return undefined;
  return parseBookmarkPreferencesCache((records as CacheMap)[key], key);
}

async function writeRecord(record: BookmarkPreferencesCacheRecord, identity: PreferenceIdentity,
  deviceChanges: Partial<BookmarkPreferences> = {}): Promise<void> {
  const key = bookmarkPreferencesScopeKey(record.serverOrigin, record.subject);
  const raw = (await chrome.storage.local.get(BOOKMARK_PREFERENCES_CACHE))[BOOKMARK_PREFERENCES_CACHE];
  const records: CacheMap = raw && typeof raw === 'object' && !Array.isArray(raw)
    && (raw as Record<string, unknown>).records && typeof (raw as Record<string, unknown>).records === 'object'
    ? { ...((raw as Record<string, unknown>).records as CacheMap) } : {};
  const deviceKey = bookmarkPreferencesScopeKey(record.serverOrigin, null);
  const priorDevice = parseBookmarkPreferencesCache(records[deviceKey], deviceKey);
  const patch = devicePreferencePatch(deviceChanges);
  records[key] = record;
  if (Object.keys(patch).length) {
    const device = priorDevice ?? defaultBookmarkPreferencesRecord(record.serverOrigin, null, 0);
    const revision = `device-${Date.now().toString(36)}`;
    records[deviceKey] = { ...device, value: { ...device.value, ...patch }, revision, etag: preferencesEtag(revision), updatedAt: Date.now() };
  }
  await assertCurrent(identity);
  const values = { [BOOKMARK_PREFERENCES_CACHE]: { schema: 1, records } };
  if (patch.captureMode === 'manual' || patch.captureMode && priorDevice?.value.captureMode !== patch.captureMode) {
    await updateCaptureControl({ serverOrigin: identity.origin, accountId: identity.subject, authorityGeneration: identity.generation, collectionId: null },
      control => ({ ...control, ...(patch.captureMode === 'manual' && control.manualStopToken === identity.manualStopToken ? { manualOverride: false } : {}),
        generation: control.generation + (priorDevice?.value.captureMode !== patch.captureMode ? 1 : 0) }), values);
  } else await chrome.storage.local.set(values);
}

async function response(record: BookmarkPreferencesCacheRecord, source: 'cache' | 'server' | 'default', scope: 'account' | 'device'): Promise<BookmarkPreferencesResponse> {
  const preferences = await effectivePreferences(record);
  const accountDefaults = record.subject && record.updatedAt > 0 && !record.pending && !record.conflict
    && accountDefaultsDiffer(record.value, preferences) ? record.value : undefined;
  return { ok: true, preferences, scope, source, revision: record.revision, etag: record.etag,
    ...(accountDefaults ? { accountDefaults } : {}),
    pending: record.pending !== undefined, conflict: record.conflict !== undefined,
    ...(record.conflict ? { conflictValues: { local: record.conflict.local, remote: record.conflict.remote } } : {}) };
}

function online(): boolean { return typeof navigator === 'undefined' || navigator.onLine !== false; }

function serial<Result>(work: () => Promise<Result>): Promise<Result> {
  const result = preferenceLane.then(work, work);
  preferenceLane = result.then(() => undefined, () => undefined);
  return result;
}
