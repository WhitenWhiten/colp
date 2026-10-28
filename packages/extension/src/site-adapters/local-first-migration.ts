import { requestValue } from '../sync-state/idb.js';
import { get, put, sourceKey, sourceDigest, type SourceDatabase } from './source-db.js';
import { enqueueSourcePlan } from './work-queue.js';
import { authorityForConnection } from './ledger.js';
import { retryableSourceDependency } from './retry-policy.js';
import { localSourceScopeId } from './local-identity.js';
import type { SourcePolicyRecord } from './layout.js';
import type { ObservationRow } from './ledger-types.js';
import type { StoredSavePlan, SourceOutbox } from './planned-types.js';
import { representationKey, type ItemReservation } from './reservations.js';
import type { Representation } from './contracts.js';
import type { SourceMount } from './layout.js';
import type { ContentBindingRow } from './content-bindings.js';
interface Progress { stage: 'plans' | 'observations' | 'copies' | 'reservations' | 'bindings' | 'done'; after?: IDBValidKey }
const progressKey = 'localFirstMigration:v2';
async function page(tx: IDBTransaction, store: string, after?: IDBValidKey) {
  return new Promise<{ key: IDBValidKey; value: unknown }[]>((resolve, reject) => {
    const rows: { key: IDBValidKey; value: unknown }[] = [], r = tx.objectStore(store).openCursor(after === undefined ? null : IDBKeyRange.lowerBound(after, true));
    r.onerror = () => reject(r.error); r.onsuccess = () => { const c = r.result;
      if (!c || rows.length === 50) return resolve(rows); rows.push({ key: c.key, value: c.value }); c.continue(); };
  });
}
/** Restartable derived-index migration; immutable commands, native receipts and old associations are retained. */
export async function migrateLocalFirstBatch(db: SourceDatabase, ports: {
  deviceId: string;
  lookup(id: string): Promise<{ dateAdded?: number; title: string; parentId?: string; url?: string } | null>;
}) {
  const progress = await db.read<Progress>('meta', progressKey) ?? { stage: 'plans' as const };
  if (progress.stage === 'done') return false;
  const store = progress.stage === 'plans' ? 'savePlans' : progress.stage === 'observations' ? 'observations' : progress.stage === 'copies' ? 'representations' : progress.stage === 'reservations' ? 'itemReservations' : 'contentBindings';
  const batch = await db.transaction([store], 'readonly', tx => page(tx, store, progress.after));
  const natives = new Map<string, Awaited<ReturnType<typeof ports.lookup>>>();
  if (progress.stage === 'bindings') for (const entry of batch) {
    const b = entry.value as ContentBindingRow;
    if (b.native?.deviceId === ports.deviceId) natives.set(b.native.nativeId, await ports.lookup(b.native.nativeId));
  }
  await db.transaction(['meta', 'work', 'savePlans', 'observations', 'authorities', 'effects', 'outbox', 'contentBindings', 'representations', 'itemReservations', 'mounts', 'folderReservations'], 'readwrite', async tx => {
    for (const entry of batch) {
      if (progress.stage === 'plans') {
        const row = await get<StoredSavePlan>(tx, 'savePlans', entry.key);
        if (!row || row.state === 'draft' || await get(tx, 'meta', `evidence-plan:${row.plan.id}`)) continue;
        const authority = row.plan.connectionId ? await authorityForConnection(tx, row.plan.connectionId) : undefined;
        const authorized = row.state === 'approved' && authority?.enabled && authority.installationGeneration === row.plan.installationGeneration
          && authority.sourceSessionGeneration === row.plan.sourceSessionGeneration;
        let pending = false, lateReceipt = false;
        for (const effect of row.plan.effects) {
          const state = await get<{ state: string; commandId?: string }>(tx, 'effects', sourceKey(row.plan.id, effect.effectId));
          let command = state?.commandId ?? effect.commandId;
          if (!state?.commandId && effect.kind === 'ensureSourceFolder') {
            const r = tx.objectStore('folderReservations').index('id').get(effect.reservationId);
            const folder = await new Promise<{ commandId: string } | undefined>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
            command = folder?.commandId ?? command;
          }
          const outbox = command ? await get<SourceOutbox>(tx, 'outbox', command) : undefined;
          if (row.state === 'cancelled' && (!outbox || outbox.state === 'reserved')) continue;
          if (state?.state !== 'confirmed' || outbox && !outbox.executorAcknowledged) {
            pending = true; lateReceipt ||= !!outbox && outbox.state !== 'reserved';
          }
        }
        if (pending && (authorized || lateReceipt)) { await enqueueSourcePlan(tx, row.plan.id, row.plan.connectionId);
          if (row.plan.trigger.kind === 'import') put(tx, 'work', row.plan.id, { id: row.plan.id, dueAt: Date.now(), attempts: 0, connectionId: row.plan.connectionId }); }
      } else if (progress.stage === 'observations') {
        const row = await get<ObservationRow & { planning?: { reason: string; planIds: string[] } }>(tx, 'observations', entry.key);
        if (!row || row.state !== 'settled' || !row.planning || row.planning.planIds.length || !retryableSourceDependency(row.planning.reason)) continue;
        const a = await authorityForConnection(tx, row.context.connectionId), policy = await get<SourcePolicyRecord>(tx, 'meta', `policy:${row.context.connectionId}`);
        if (!a?.enabled || !policy?.enabled || !policy.liveArchive || a.installationGeneration !== row.context.installationGeneration
          || a.sourceSessionGeneration !== row.context.sourceSessionGeneration || row.ordinal <= (policy.admittedAfterOrdinal ?? 0)) continue;
        put(tx, 'meta', `localFirstRecovered:${row.id}`, { planning: row.planning, recoveredAt: Date.now() });
        put(tx, 'observations', entry.key, { ...row, state: 'pending', readyAt: 0, retryReason: row.planning.reason });
      } else if (progress.stage === 'copies') {
        const r = await get<Representation>(tx, 'representations', entry.key);
        if (r?.native.deviceId === ports.deviceId && r.scopeId !== localSourceScopeId(ports.deviceId)) {
          const scoped = { ...r, scopeId: localSourceScopeId(ports.deviceId) };
          put(tx, 'representations', representationKey(scoped), scoped);
        }
      } else if (progress.stage === 'reservations') {
        const r = await get<ItemReservation>(tx, 'itemReservations', entry.key); if (!r) continue;
        const command = await get<SourceOutbox>(tx, 'outbox', r.commandId);
        let device = command?.command.deviceId;
        if (!device && r.representation.mountId) {
          const request = tx.objectStore('mounts').index('id').get(r.representation.mountId);
          const mount = await new Promise<SourceMount | undefined>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
          device = mount?.root.deviceId;
        }
        if (device === ports.deviceId) put(tx, 'itemReservations', entry.key, { ...r,
          representation: { ...r.representation, scopeId: localSourceScopeId(ports.deviceId) } });
      } else {
        const b = entry.value as ContentBindingRow, current = await get<ContentBindingRow>(tx, 'contentBindings', entry.key);
        if (!current || sourceDigest(current) !== sourceDigest(b) || b.native?.deviceId !== ports.deviceId) continue;
        const native = natives.get(b.native.nativeId);
        if (!native || native.dateAdded !== b.native.dateAdded || native.parentId !== b.parentId || native.title !== b.title || native.url !== b.url) continue;
        put(tx, 'contentBindings', entry.key, { ...b, scopeId: localSourceScopeId(ports.deviceId) });
      }
    }
    if (progress.stage === 'observations') put(tx, 'meta', 'pendingObservations', await requestValue(tx.objectStore('observations').index('state').count('pending')));
    const next: Progress = batch.length === 50 ? { ...progress, after: batch.at(-1)!.key }
      : { stage: progress.stage === 'plans' ? 'observations' : progress.stage === 'observations' ? 'copies' : progress.stage === 'copies' ? 'reservations' : progress.stage === 'reservations' ? 'bindings' : 'done' };
    put(tx, 'meta', progressKey, next);
  });
  return true;
}
