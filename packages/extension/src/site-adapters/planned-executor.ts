import type { NativeBinding, SavePlan, SaveEffect, SourceFolderReservation, Representation, ImportApproval, ImportPreview } from './contracts.js';
import type { SourceAuthority } from './ledger-types.js';
import type { ItemReservation } from './reservations.js';
import { representationKey } from './reservations.js';
import { get, put, sourceKey, sourceDigest, type SourceDatabase } from './source-db.js';
import type { PlannedNativeCommand, PlannedNativeResult, PlannedExecutionPorts, SourceOutbox, StoredSavePlan } from './planned-types.js';
export function effectDigest(effect: SaveEffect): string { const { payloadDigest: _digest, ...input } = effect; return sourceDigest(input); }
export function planDigest(plan: SavePlan) { const { importApprovalId: _approval, ...input } = plan; return sourceDigest(input); }
/** Host-only plan insertion. Drafts remain inert; this is not exposed on adapter ingress. */
export async function persistSavePlan(db: SourceDatabase, plan: SavePlan, state: StoredSavePlan['state'] = 'draft') {
  if (plan.effects.length > 256 || new Set(plan.effects.map(e => e.effectId)).size !== plan.effects.length) throw new Error('invalidPlan');
  const byId = new Map(plan.effects.map(e => [e.effectId, e]));
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string, depth = 0): boolean => {
    if (visiting.has(id) || depth > 32) return false;
    if (visited.has(id)) return true;
    const e = byId.get(id); if (!e || effectDigest(e) !== e.payloadDigest) return false;
    visiting.add(id); const valid = e.dependsOn.every(d => visit(d, depth + 1)); visiting.delete(id); if (valid) visited.add(id); return valid;
  };
  if (!plan.effects.every(e => visit(e.effectId))) throw new Error('invalidPlan');
  const row: StoredSavePlan = { plan, digest: planDigest(plan), state };
  await db.transaction(['savePlans'], 'readwrite', async tx => {
    const prior = await get<StoredSavePlan>(tx, 'savePlans', plan.id);
    if (prior && (prior.digest !== row.digest || prior.state === 'cancelled' && state !== 'cancelled')) throw new Error('conflict');
    put(tx, 'savePlans', plan.id, row);
  });
}
export function createPlannedSaveExecutor(db: SourceDatabase, ports: PlannedExecutionPorts) {
  const commandLocks = new Map<string, Promise<void>>();
  const running = new Map<string, Promise<PlannedNativeResult>>();
  async function load(planId: string, effectId: string) {
    const row = await db.read<StoredSavePlan>('savePlans', planId), effect = row?.plan.effects.find(e => e.effectId === effectId);
    if (!row || !effect || row.digest !== planDigest(row.plan) || effect.payloadDigest !== effectDigest(effect)) throw new Error('invalidPlan');
    return { row, plan: row.plan, effect };
  }
  async function authorize(planId: string, effectId: string) {
    const { row, plan, effect } = await load(planId, effectId);
    const a = await db.read<SourceAuthority>('authorities', 'bundled.bilibili');
    if (row.state !== 'approved' || !a?.enabled || a.connectionId !== plan.connectionId || a.installationGeneration !== plan.installationGeneration
      || (a.installationGeneration !== plan.collectorGeneration) || a.sourceSessionGeneration !== plan.sourceSessionGeneration) throw new Error('sourceAuthorizationChanged');
    if (plan.purpose !== 'sourceArchive' || plan.classification !== 'disabled') throw new Error('semanticExecutionUnavailable');
    if (plan.trigger.kind === 'import') {
      const approval = plan.importApprovalId && await db.read<ImportApproval>('importApprovals', plan.importApprovalId);
      const preview = approval && await db.read<ImportPreview>('importPreviews', approval.previewId);
      if (!approval || approval.state === 'cancelled' || !preview || approval.importRunId !== plan.trigger.importRunId || approval.previewId !== plan.trigger.previewId
        || approval.previewDigest !== preview.digest || approval.previewRevision !== preview.revision || !preview.planIds.includes(plan.id)) throw new Error('importApprovalRequired');
    }
    for (const id of effect.dependsOn) {
      const prior = await db.read<{ state: string }>('effects', sourceKey(planId, id)); if (prior?.state !== 'confirmed') throw new Error('dependencyPending');
    }
    if (effect.kind === 'ensureSourceFolder') {
      const consumer = await db.read<{ active: boolean }>('folderConsumers', sourceKey(effect.reservationId, plan.id, effect.effectId));
      if (!consumer?.active) throw new Error('consumerCancelled');
    }
    await ports.authorize(plan, effect);
  }
  async function owner(plan: SavePlan, effect: SaveEffect) {
    if (effect.kind === 'ensureSourceFolder') {
      if (!plan.mount) throw new Error('mountRequired');
      const candidates = await db.transaction(['folderReservations'], 'readonly', async tx => {
        const r = tx.objectStore('folderReservations').openCursor(); return new Promise<SourceFolderReservation | undefined>((resolve, reject) => {
          r.onerror = () => reject(r.error); r.onsuccess = () => { const c = r.result; if (!c) return resolve(undefined);
            if (c.value.id === effect.reservationId && c.value.mountId === plan.mount!.id) return resolve(c.value); c.continue(); };
        });
      });
      if (!candidates || effect.folderReservationDigest !== candidates.payloadDigest || candidates.mountRevision !== plan.mount.revision) throw new Error('mountChanged');
      return { commandId: candidates.commandId, logicalDigest: candidates.payloadDigest, folder: candidates };
    }
    if (effect.kind === 'createBookmark') {
      const reservation = await db.read<ItemReservation>('itemReservations', representationKey(effect.representation));
      if (!reservation || reservation.commandId !== effect.commandId || reservation.payloadDigest !== effect.payloadDigest) throw new Error('reservationRequired');
      const existing = await db.read<Representation>('representations', representationKey(effect.representation));
      return { commandId: reservation.commandId, logicalDigest: effect.payloadDigest, existing };
    }
    throw new Error(effect.kind === 'review' ? 'reviewRequired' : 'effectUnavailable');
  }
  async function parent(effect: SaveEffect, folder?: SourceFolderReservation): Promise<NativeBinding<'folder'>> {
    const target = folder?.parent ?? (effect.kind === 'createBookmark' ? effect.parent : null);
    if (!target) throw new Error('parentRequired');
    if (target.kind === 'native') return target.binding;
    const all = await db.transaction(['folderReservations'], 'readonly', async tx => new Promise<SourceFolderReservation | undefined>((resolve, reject) => {
      const r = tx.objectStore('folderReservations').openCursor(); r.onerror = () => reject(r.error); r.onsuccess = () => { const c = r.result;
        if (!c) return resolve(undefined); if (c.value.id === target.reservationId) return resolve(c.value); c.continue(); };
    }));
    if (all?.payloadDigest !== effect.folderReservationDigest) throw new Error('folderPayloadChanged');
    if (all?.state !== 'confirmed' || !all.native) throw new Error('dependencyUnknown'); return all.native;
  }
  async function finish(plan: SavePlan, effect: SaveEffect, outbox: SourceOutbox, native: NativeBinding, folder?: SourceFolderReservation) {
    if (native.kind !== outbox.command.kind || native.deviceId !== outbox.command.deviceId || native.dateAdded === null) throw new Error('unprovenReceipt');
    await db.transaction(['outbox', 'effects', 'folderReservations', 'representations', 'itemReservations'], 'readwrite', async tx => {
      const current = await get<SourceOutbox>(tx, 'outbox', outbox.command.commandId);
      if (!current || current.digest !== outbox.digest || current.native && current.native.bindingId !== native.bindingId) throw new Error('conflict');
      if (folder) { const key = sourceKey(folder.mountId, folder.collectionId), latest = await get<SourceFolderReservation>(tx, 'folderReservations', key);
        if (!latest || latest.payloadDigest !== folder.payloadDigest) throw new Error('conflict');
        put(tx, 'folderReservations', key, { ...latest, state: latest.state === 'blocked' ? 'blocked' : 'confirmed', native }); }
      else if (effect.kind === 'createBookmark') {
        const key = representationKey(effect.representation), existing = await get<Representation>(tx, 'representations', key);
        if (existing && existing.native.bindingId !== native.bindingId) throw new Error('representationConflict');
        put(tx, 'representations', key, existing ?? { ...effect.representation, native, state: 'active', manualRevision: 0,
          lastWritten: { title: outbox.command.title, parentId: outbox.command.parent.nativeId } });
        const reserved = await get<ItemReservation>(tx, 'itemReservations', key);
        if (reserved) put(tx, 'itemReservations', key, { ...reserved, state: 'confirmed' });
      }
      put(tx, 'effects', sourceKey(plan.id, effect.effectId), { state: 'confirmed', native, commandId: outbox.command.commandId });
      put(tx, 'outbox', outbox.command.commandId, { ...current, state: 'acknowledged', native });
    });
    if (!outbox.executorAcknowledged) {
      await ports.acknowledge(outbox.command, outbox.digest);
      await db.transaction(['outbox'], 'readwrite', async tx => {
        const current = await get<SourceOutbox>(tx, 'outbox', outbox.command.commandId);
        if (!current || current.digest !== outbox.digest || current.state !== 'acknowledged') throw new Error('conflict');
        put(tx, 'outbox', outbox.command.commandId, { ...current, executorAcknowledged: true });
      });
    }
    return { status: 'confirmed', native } as const;
  }
  async function execute(planId: string, effectId: string): Promise<PlannedNativeResult> {
    const { plan, effect } = await load(planId, effectId), who = await owner(plan, effect);
    let outbox = await db.read<SourceOutbox>('outbox', who.commandId);
    if (who.existing && !outbox) throw new Error('alreadyRepresented');
    if (!outbox && who.folder?.state === 'confirmed' && who.folder.native) {
      await authorize(planId, effectId); await ports.assertNative(who.folder.native);
      await db.transaction(['effects'], 'readwrite', async tx => { put(tx, 'effects', sourceKey(plan.id, effect.effectId), { state: 'confirmed', native: who.folder!.native }); });
      return { status: 'confirmed', native: who.folder.native };
    }
    if (outbox) {
      if (outbox.command.logicalDigest !== who.logicalDigest || outbox.digest !== sourceDigest(outbox.command)) throw new Error('conflict');
      if (outbox.native) return finish(plan, effect, outbox, outbox.native, who.folder);
      // Recover existing commands before checking current approval; revoked work may have late receipts.
      const recovered = await ports.recover(outbox.command, outbox.digest);
      if (recovered?.status === 'confirmed') return finish(plan, effect, outbox, recovered.native, who.folder);
    }
    await authorize(planId, effectId);
    if (!outbox) {
      const binding = await parent(effect, who.folder); await ports.assertNative(binding);
      const observation = plan.trigger.kind === 'observation' ? await db.read<{ cause: string }>('observations', plan.trigger.observationId) : undefined;
      const command: PlannedNativeCommand = { commandId: who.commandId, kind: who.folder ? 'folder' : 'bookmark', ownerId: who.folder?.id ?? sourceKey(plan.id, effectId),
        logicalDigest: who.logicalDigest, connectionId: plan.connectionId, parent: binding,
        title: who.folder?.title ?? (effect.kind === 'createBookmark' ? effect.item.title : ''), deviceId: await ports.deviceId(),
        ...(effect.kind === 'createBookmark' ? { bookmark: { planId, effectId, representation: effect.representation, url: effect.item.url, scope: await ports.scope(),
          source: plan.trigger.kind === 'import' ? 'site-import' as const : observation?.cause === 'siteFavorite' ? 'site-favorite' as const : 'site-reconcile' as const } } : {}) };
      outbox = { command, digest: sourceDigest(command), state: 'reserved' };
      await db.transaction(['outbox'], 'readwrite', async tx => {
        const old = await get<SourceOutbox>(tx, 'outbox', who.commandId);
        if (old && old.digest !== outbox!.digest) throw new Error('conflict'); if (!old) put(tx, 'outbox', who.commandId, outbox);
      });
    }
    const command = outbox.command;
    await authorize(planId, effectId); await ports.assertNative(command.parent);
    await db.transaction(['outbox', 'folderReservations', 'itemReservations'], 'readwrite', async tx => {
      const row = await get<SourceOutbox>(tx, 'outbox', command.commandId); if (!row || row.digest !== outbox!.digest) throw new Error('conflict');
      put(tx, 'outbox', command.commandId, { ...row, state: 'submitted' });
      if (who.folder) put(tx, 'folderReservations', sourceKey(who.folder.mountId, who.folder.collectionId), { ...who.folder, state: 'submitted' });
      else if (effect.kind === 'createBookmark') { const key = representationKey(effect.representation), r = await get<ItemReservation>(tx, 'itemReservations', key); if (r) put(tx, 'itemReservations', key, { ...r, state: 'submitted' }); }
    });
    await ports.beforeSubmit?.(command);
    const result = await ports.execute(command, outbox.digest, () => authorize(planId, effectId));
    if (result.status === 'confirmed') { await ports.beforeSourceCommit?.(command); return finish(plan, effect, outbox, result.native, who.folder); }
    await db.transaction(['outbox', 'effects', 'folderReservations', 'itemReservations'], 'readwrite', async tx => {
      const row = await get<SourceOutbox>(tx, 'outbox', command.commandId); if (!row || row.digest !== outbox!.digest) throw new Error('conflict');
      put(tx, 'outbox', command.commandId, { ...row, state: 'unknown' });
      put(tx, 'effects', sourceKey(plan.id, effectId), { state: 'unknown', reason: result.reason });
      if (who.folder) put(tx, 'folderReservations', sourceKey(who.folder.mountId, who.folder.collectionId), { ...who.folder, state: 'unknown' });
      else if (effect.kind === 'createBookmark') { const key = representationKey(effect.representation), r = await get<ItemReservation>(tx, 'itemReservations', key); if (r) put(tx, 'itemReservations', key, { ...r, state: 'unknown' }); }
    });
    return result;
  }
  return { authorize, execute(planId: string, effectId: string) {
    const key = sourceKey(planId, effectId), old = running.get(key); if (old) return old;
    const serialized = async () => {
      const { plan, effect } = await load(planId, effectId), key = (await owner(plan, effect)).commandId;
      const previous = commandLocks.get(key) ?? Promise.resolve(); let release!: () => void;
      const current = new Promise<void>(resolve => { release = resolve; }); commandLocks.set(key, current);
      await previous;
      try { return await execute(planId, effectId); } finally { release(); if (commandLocks.get(key) === current) commandLocks.delete(key); }
    };
    const result = serialized().catch(e => ({ status: 'blocked' as const, reason: e instanceof Error ? e.message : 'executionUnavailable' }))
      .finally(() => running.delete(key)); running.set(key, result); return result;
  } };
}
