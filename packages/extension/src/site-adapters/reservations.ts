import { destinationScopeId } from './destination-scope.js';
import type { SourceMount } from './layout.js';
import { assertPlanIntentActive, type SourcePlanIntent } from './plan-intents.js';
import type { NativeBinding, Representation, RepresentationKey, SourceFolderReservation } from './contracts.js';
import { get, put, rows, sourceDigest, sourceKey, type SourceDatabase } from './source-db.js';
export const representationKey = (r: RepresentationKey) => sourceKey(r.connectionId, r.itemId, r.purpose, r.sourceCollectionId, r.mountId,
  ...r.purpose === 'semantic' && r.scopeId ? [r.scopeId] : []);
export interface ItemReservation { id: string; representation: RepresentationKey; commandId: string; payloadDigest: string;
  state: 'reserved' | 'submitted' | 'unknown' | 'confirmed' | 'blocked' }
const validTransition = (from: ItemReservation['state'], to: ItemReservation['state']) => from === to
  || ({ reserved: ['submitted', 'blocked'], submitted: ['unknown', 'confirmed', 'blocked'], unknown: ['confirmed', 'blocked'], confirmed: ['blocked'], blocked: [] }[from] as readonly string[]).includes(to);
const compatibleProof = (b: NativeBinding) => !!b.bindingId && !!b.nativeId && !!b.deviceId && b.dateAdded !== null && Number.isFinite(b.dateAdded) && b.dateAdded > 0 && !!b.proof.id;
/** Host-only primitives; reservations never grant approval or browser API authority. */
export function createSourceReservations(db: SourceDatabase, random = () => crypto.randomUUID()) {
  return {
    async reserveItem(representation: RepresentationKey, payload: unknown, policy: 'sourceAndSemantic' | 'singlePreferSemantic' | 'singleKeepExisting', commandId?: string, planId?: string) {
      return db.transaction(['itemReservations', 'representations', 'meta'], 'readwrite', async tx => {
        if (planId) await assertPlanIntentActive(tx, planId);
        const key = representationKey(representation), digest = sourceDigest(payload);
        const bound = await get<Representation>(tx, 'representations', key);
        if (bound) return { status: bound.state === 'active' ? 'bound' : 'blocked', representation: bound } as const;
        const old = await get<ItemReservation>(tx, 'itemReservations', key);
        if (old) {
          if (old.payloadDigest !== digest) throw new Error('conflict');
          return { status: 'reserved', reservation: old } as const;
        }
        if (policy !== 'sourceAndSemantic') {
          const existing = await rows<ItemReservation>(tx, 'itemReservations', representation.connectionId, representation.itemId);
          const copies = await rows<Representation>(tx, 'representations', representation.connectionId, representation.itemId);
          if (copies.length) return { status: 'existingCopy', representation: copies[0]! } as const;
          // Unknown/pending/confirmed historic copies remain dependencies; no blind replacement.
          if (existing.length) return { status: 'dependency', reservation: existing[0]! } as const;
        }
        const row: ItemReservation = { id: random(), representation, commandId: commandId ?? random(), payloadDigest: digest, state: 'reserved' };
        put(tx, 'itemReservations', key, row); return { status: 'reserved', reservation: row } as const;
      });
    },
    async setItemState(key: RepresentationKey, expected: ItemReservation['state'], next: ItemReservation['state']) {
      return db.transaction(['itemReservations'], 'readwrite', async tx => {
        const id = representationKey(key), row = await get<ItemReservation>(tx, 'itemReservations', id);
        if (!row || row.state !== expected || !validTransition(expected, next)) throw new Error('conflict');
        put(tx, 'itemReservations', id, { ...row, state: next });
      });
    },
    async reserveFolder(input: Omit<SourceFolderReservation, 'id' | 'commandId' | 'payloadDigest' | 'state' | 'native'>, consumer: { planId: string; effectId: string }, source?: { connectionId: string; scopeId: string }) {
      return db.transaction(['folderReservations', 'folderConsumers', 'meta', 'mounts'], 'readwrite', async tx => {
        await assertPlanIntentActive(tx, consumer.planId);
        if (source) for (const mount of await rows<SourceMount>(tx, 'mounts', source.connectionId)) {
          if (mount.id !== input.mountId && destinationScopeId(mount.destination, mount.root.deviceId) === source.scopeId
            && await get(tx, 'folderReservations', sourceKey(mount.id, input.collectionId))) throw new Error('sourceMappingMigrationRequired');
        }
        const key = sourceKey(input.mountId, input.collectionId), digest = sourceDigest(input);
        let row = await get<SourceFolderReservation>(tx, 'folderReservations', key);
        if (row && row.payloadDigest !== digest) throw new Error('conflict');
        if (!row) {
          // v1 only creates below proven native roots. Nested folders need a validated DAG first.
          if (input.parent.kind !== 'native' || !compatibleProof(input.parent.binding) || input.parent.binding.kind !== 'folder') throw new Error('unprovenParent');
          row = { ...input, id: random(), commandId: random(), payloadDigest: digest, state: 'reserved', native: null };
          put(tx, 'folderReservations', key, row);
        }
        put(tx, 'folderConsumers', sourceKey(row.id, consumer.planId, consumer.effectId), { reservationId: row.id, ...consumer, active: true });
        return row;
      });
    },
    async cancelConsumer(reservationId: string, planId: string, effectId: string) {
      return db.transaction(['folderConsumers'], 'readwrite', async tx => {
        const key = sourceKey(reservationId, planId, effectId), row = await get<Record<string, unknown>>(tx, 'folderConsumers', key);
        if (row) put(tx, 'folderConsumers', key, { ...row, active: false });
      });
    },
    async setFolderState(mountId: string, collectionId: string, expected: SourceFolderReservation['state'], next: SourceFolderReservation['state'], native?: NativeBinding<'folder'>) {
      return db.transaction(['folderReservations'], 'readwrite', async tx => {
        const key = sourceKey(mountId, collectionId), row = await get<SourceFolderReservation>(tx, 'folderReservations', key);
        if (!row || row.state !== expected || !validTransition(expected, next)
          || next === 'confirmed' && (!native || !compatibleProof(native))) throw new Error('conflict');
        put(tx, 'folderReservations', key, { ...row, state: next, native: native ?? row.native });
      });
    },
    async bindRepresentation(representation: Representation) {
      if (!compatibleProof(representation.native)) throw new Error('unprovenNative');
      return db.transaction(['representations'], 'readwrite', async tx => {
        const key = representationKey(representation), old = await get<Representation>(tx, 'representations', key);
        if (old && (old.native.bindingId !== representation.native.bindingId || old.state !== 'active')) throw new Error('reviewRequired');
        put(tx, 'representations', key, representation);
      });
    },
    async manualChange(key: RepresentationKey, state: 'detached' | 'suppressed') {
      return db.transaction(['representations'], 'readwrite', async tx => {
        const id = representationKey(key), old = await get<Representation>(tx, 'representations', id);
        if (!old) throw new Error('unboundNative');
        put(tx, 'representations', id, { ...old, state, manualRevision: old.manualRevision + 1 });
      });
    },
  };
}

/** Call inside the cancellation transaction. Only never-submitted, unconsumed work is reclaimable. */
export async function releaseUnsubmittedReservations(tx: IDBTransaction, plans: readonly import('./contracts.js').SavePlan[], intents: readonly SourcePlanIntent[] = []) {
  const items = [...plans.flatMap(p => p.effects.filter(e => e.kind === 'createBookmark')), ...intents];
  const commands = new Set(items.map(e => e.commandId));
  const used = new Set((await rows<SourcePlanIntent>(tx, 'meta', 'sourcePlanIntent')).filter(i => i.state !== 'cancelled').map(i => i.commandId));
  await new Promise<void>((resolve, reject) => {
    const request = tx.objectStore('savePlans').openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result; if (!cursor) { resolve(); return; }
      const row = cursor.value as import('./planned-types.js').StoredSavePlan;
      if (row.state !== 'cancelled') for (const effect of row.plan.effects) if (commands.has(effect.commandId)) used.add(effect.commandId);
      cursor.continue();
    };
  });
  for (const effect of items) {
    const key = representationKey(effect.representation), reservation = await get<ItemReservation>(tx, 'itemReservations', key);
    if (reservation?.state === 'reserved' && reservation.commandId === effect.commandId && !used.has(effect.commandId)
      && !await get(tx, 'outbox', effect.commandId) && !await get(tx, 'representations', key)) tx.objectStore('itemReservations').delete(key);
  }
  for (const plan of plans) for (const effect of plan.effects) if (effect.kind === 'ensureSourceFolder' && plan.mount) {
    const folders = await rows<SourceFolderReservation>(tx, 'folderReservations', plan.mount.id);
    const folder = folders.find(f => f.id === effect.reservationId);
    if (!folder || folder.state !== 'reserved' || folder.native || await get(tx, 'outbox', folder.commandId)) continue;
    const consumers = await rows<{ active: boolean }>(tx, 'folderConsumers', folder.id);
    if (!consumers.some(c => c.active)) tx.objectStore('folderReservations').delete(sourceKey(folder.mountId, folder.collectionId));
  }
}
