import { legacySite, type SiteDefinition } from './registry.js';
import { exportSourceDiagnostic, diagnosticSummary } from './repair.js';
import { siteLedger } from './source-runtime.js';
import { createSourceRebinder, type RestoredSources } from './portable.js';
import { literal, object, str, integer, jsonBytes } from './schema.js';
import { cursorPage } from '../sync-state/idb.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { assertPersonalNativeAllowed } from '../bookmark-subscriptions/guards.js';
import { wakePlannedSaves } from './planned-runtime.js';
import { retrySourceObservations } from './local-source-problems.js';
import { scheduleSourceAlarm } from './wake-scheduler.js';
import { installationKey } from './installation.js';
import { SITE_RECOVERY_ALARM } from './source-runtime.js';
import type { SourceAuthority } from './ledger-types.js';
import type { SourceMount } from './layout.js';
import { captureStore } from '../sw/capture.js';
import { adoptPlannedFolder, retryPlannedFolder } from '../sw/planned-capture.js';
import { currentCaptureScope } from '../sw/capture-native.js';
import { managedLibraryKey } from './copy-identity.js';
import { get, put, rows, sourceDigest } from './source-db.js';
import type { SourceOutbox } from './planned-types.js';
import type { SourceWork } from './work-queue.js';
const status = object({ kind: literal('known.siteAdapters.repair.status', 'known.siteAdapters.repair.export', 'known.siteAdapters.repair.recover') });
const rebind = object({ kind: literal('known.siteAdapters.repair.preview', 'known.siteAdapters.repair.approve'), restoreId: str(256),
  connectionRef: str(256), mountRef: str(256), digest: v => v === undefined || str(128)(v) });
const blockedReview = object({ kind: literal('known.siteAdapters.repair.reviewBlocked', 'known.siteAdapters.repair.retainBlocked'), restoreId: str(256),
  connectionRef: str(256), digest: v => v === undefined || str(128)(v) });
const retryFolder = object({ kind: literal('known.siteAdapters.repair.retryFolder'), commandId: str(256) });
const adoptFolder = object({ kind: literal('known.siteAdapters.repair.adoptFolder'), commandId: str(256), nativeId: str(256), dateAdded: integer });
export const validRepairRequest = (raw: unknown) => jsonBytes(raw, 16384) && (status(raw) || rebind(raw) || blockedReview(raw) || adoptFolder(raw) || retryFolder(raw));
const db = siteLedger.db;
const rebinderFor = (definition: SiteDefinition) => createSourceRebinder(db, {
  authority: () => db.read<SourceAuthority>('authorities', definition.adapterId),
  async mount() {
    const a = await db.read<SourceAuthority>('authorities', definition.adapterId);
    const config = a?.connectionId ? await db.read<{ ruleId: string }>('meta', `archiveConfig:${a.connectionId}`) : undefined;
    return config && a?.connectionId ? db.read<SourceMount>('mounts', JSON.stringify([a.connectionId, config.ruleId])) : undefined;
  }, deviceId: captureDeviceId,
  async lookup(id) { await assertPersonalNativeAllowed(id); return (await chrome.bookmarks.get(id).catch(() => []))[0] ?? null; },
}, definition);
export async function handleRepairRequest(raw: unknown, definition: SiteDefinition = legacySite) {
  const rebinder = rebinderFor(definition);
  if (!validRepairRequest(raw)) throw new Error('invalid');
  const r = raw as { kind: string; restoreId: string; connectionRef: string; mountRef: string; digest?: string };
  if (adoptFolder(raw) || retryFolder(raw)) {
    const request = raw as { commandId: string; nativeId: string; dateAdded: number };
    const outbox = await db.read<SourceOutbox>('outbox', request.commandId);
    const authority = await db.read<SourceAuthority>('authorities', definition.adapterId);
    if (!outbox || !authority?.enabled || authority.connectionId !== outbox.command.connectionId || outbox.command.kind !== 'folder'
      || outbox.command.managed || outbox.command.local?.reuse || outbox.digest !== sourceDigest(outbox.command)) throw new Error('nativeOutcomeNotUnknown');
    const owner = outbox.command.local?.owner, scope = await currentCaptureScope();
    if (owner && (!scope.accountId || !scope.collectionId || managedLibraryKey(owner) !== managedLibraryKey({ serverOrigin: scope.serverOrigin, accountId: scope.accountId, collectionId: scope.collectionId }))) throw new Error('sourceSyncOwnerChanged');
    if (retryFolder(raw)) await retryPlannedFolder(outbox.command, outbox.digest);
    else {
      const claimKey = `folderRecoveryClaim:${request.nativeId}`;
      await db.transaction(['folderReservations', 'meta'], 'readwrite', async tx => {
        const conflicts = await new Promise<import('./contracts.js').SourceFolderReservation[]>((resolve, reject) => {
          const lookup = tx.objectStore('folderReservations').index('nativeId').getAll(IDBKeyRange.only(request.nativeId));
          lookup.onsuccess = () => resolve(lookup.result); lookup.onerror = () => reject(lookup.error);
        });
        const claim = await get<{ commandId: string; dateAdded: number }>(tx, 'meta', claimKey);
        if (conflicts.some(folder => folder.id !== outbox.command.ownerId) || claim && (claim.commandId !== request.commandId || claim.dateAdded !== request.dateAdded))
          throw new Error('nativeIdentityChanged');
        put(tx, 'meta', claimKey, { commandId: request.commandId, dateAdded: request.dateAdded });
      });
      try { await adoptPlannedFolder(outbox.command, outbox.digest, request.nativeId, request.dateAdded); }
      catch (error) {
        const record = await captureStore.plannedCommand(request.commandId);
        if (!record?.recovery || record.recovery.native.nativeId !== request.nativeId || record.recovery.native.dateAdded !== request.dateAdded)
          await db.transaction(['meta'], 'readwrite', async tx => {
            const claim = await get<{ commandId: string; dateAdded: number }>(tx, 'meta', claimKey);
            if (claim?.commandId === request.commandId && claim.dateAdded === request.dateAdded) tx.objectStore('meta').delete(claimKey);
          });
        throw error;
      }
    }
    await db.transaction(['outbox', 'folderConsumers', 'work'], 'readwrite', async tx => {
      const current = await get<SourceOutbox>(tx, 'outbox', request.commandId);
      if (!current || current.digest !== outbox.digest) throw new Error('capture_command_reused');
      const consumers = await rows<{ planId: string; active: boolean }>(tx, 'folderConsumers', outbox.command.ownerId);
      for (const consumer of consumers) if (consumer.active) {
        const old = await get<SourceWork>(tx, 'work', consumer.planId);
        put(tx, 'work', consumer.planId, { id: consumer.planId, dueAt: Date.now(), attempts: old?.attempts ?? 0, connectionId: outbox.command.connectionId });
      }
    });
    scheduleSourceAlarm(Date.now() + 50, installationKey(SITE_RECOVERY_ALARM, definition));
    await wakePlannedSaves();
    return { ok: true };
  }
  if (r.kind.endsWith('.export')) return { ok: true, diagnostic: await exportSourceDiagnostic() };
  if (r.kind.endsWith('.preview')) return { ok: true, preview: await rebinder.preview(r.restoreId, r.connectionRef, r.mountRef) };
  if (r.kind.endsWith('.reviewBlocked')) return { ok: true, preview: await rebinder.reviewBlocked(r.restoreId, r.connectionRef) };
  if (r.kind.endsWith('.retainBlocked')) {
    if (!r.digest) throw new Error('sourceRestorePreviewRequired');
    return { ok: true, result: await rebinder.retainBlocked(r.restoreId, r.connectionRef, r.digest) };
  }
  if (r.kind.endsWith('.approve')) {
    if (!r.digest) throw new Error('sourceRestorePreviewRequired');
    return { ok: true, result: await rebinder.approve(r.restoreId, r.connectionRef, r.mountRef, r.digest) };
  }
  if (r.kind.endsWith('.recover')) {
    const authority = await db.read<SourceAuthority>('authorities', definition.adapterId);
    if (authority?.enabled && authority.connectionId) await retrySourceObservations(db, authority.connectionId);
    scheduleSourceAlarm(Date.now() + 50, installationKey(SITE_RECOVERY_ALARM, definition));
    await wakePlannedSaves();
  }
  const diagnostic = await exportSourceDiagnostic(), summary = diagnosticSummary(diagnostic);
  // A future or unknown schema stays inspectable from the raw diagnostic; only a supported ledger is read through.
  const readable = summary.supportedSchema && !!summary.schemaVersion;
  const authority = readable ? await db.read<SourceAuthority>('authorities', definition.adapterId) : undefined;
  const folderRecovery: { commandId: string; title: string; parentId: string }[] = [];
  if (authority?.enabled && authority.connectionId) for (const row of diagnostic.stores.find(store => store.name === 'outbox')?.records ?? []) {
    const outbox = row.value as SourceOutbox;
    if (!outbox?.command || outbox.command.kind !== 'folder' || outbox.command.connectionId !== authority.connectionId || outbox.command.managed
      || outbox.command.local?.reuse || !['submitted', 'unknown'].includes(outbox.state) || outbox.digest !== sourceDigest(outbox.command)) continue;
    const record = await captureStore.plannedCommand(outbox.command.commandId);
    if (record?.kind === 'folder' && record.digest === outbox.digest && (['submitted', 'unknown'].includes(record.state) || !!record.recovery || record.state === 'reserved' && !!record.retryDecisions?.length))
      folderRecovery.push({ commandId: outbox.command.commandId, title: outbox.command.title, parentId: outbox.command.parent.nativeId });
  }
  let restored: RestoredSources[] = [];
  if (readable) restored = await db.transaction(['meta'], 'readonly', async tx => {
    const records = await cursorPage<unknown>(tx.objectStore('meta'), IDBKeyRange.bound('restoredSources:', 'restoredSources:\uffff'), 101);
    if (records.length > 100) throw new Error('sourceRestoreListLimit');
    return records as RestoredSources[];
  });
  return { ok: true, ...summary, folderRecovery, restored: restored.map(r => ({ id: r.id, state: r.state, connections: r.data.connections.map(c => ({ ref: c.ref,
    accountId: c.accountId, retainedBlocked: r.reviewed.includes(JSON.stringify([c.ref, '__blocked__'])), mounts: c.mounts.map(m => ({ ref: m.ref, rootCandidate: m.rootSourceId && r.nativeIds[m.rootSourceId] || null,
      reviewed: r.reviewed.includes(JSON.stringify([c.ref, m.ref])) })), associations: c.associations.length })) })) };
}
