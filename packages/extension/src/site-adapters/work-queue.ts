import { cursorPage } from '../sync-state/idb.js';
import { get, put, sourceKey, type SourceDatabase } from './source-db.js';
import type { StoredSavePlan } from './planned-types.js';
export interface SourceWork { id: string; dueAt: number; attempts: number; connectionId?: string; reason?: string }
/** Derived active index. Deleting a completed entry never deletes its plan, command or receipt. */
export async function enqueueSourcePlan(tx: IDBTransaction, id: string, connectionId?: string) {
  if (!await get(tx, 'work', id)) put(tx, 'work', id, { id, dueAt: 0, attempts: 0, ...(connectionId ? { connectionId } : {}) } satisfies SourceWork);
}
export function createSourceWorkQueue(db: SourceDatabase, ports: {
  execute(planId: string, effectId: string): Promise<{ status: string; reason?: string }>;
  schedule(at: number): void; now?(): number;
}) {
  const now = ports.now ?? Date.now;
  return async () => {
    const batch = await db.transaction(['work'], 'readwrite', async tx => {
      const ready = await cursorPage<SourceWork>(tx.objectStore('work').index('dueAt'), IDBKeyRange.upperBound(now()), 20);
      for (const row of ready) put(tx, 'work', row.id, { ...row, dueAt: now() + 30000 });
      return ready;
    });
    // Persist a wake before the first effect: termination must not strand a claimed batch.
    if (batch.length) ports.schedule(now() + 30000);
    let budget = 20;
    for (const work of batch) {
      let complete = true, recoveringStarted = false, reason: string | undefined;
      try {
        const row = await db.read<StoredSavePlan>('savePlans', work.id);
        if (row && row.state !== 'draft' && !await db.read('meta', `evidence-plan:${work.id}`)) {
          const ordered = new Map<string, typeof row.plan.effects[number]>(), visiting = new Set<string>();
          const visit = (id: string) => {
            if (ordered.has(id)) return;
            if (visiting.has(id)) throw new Error('invalidPlan');
            const effect = row.plan.effects.find(e => e.effectId === id); if (!effect) throw new Error('invalidPlan');
            visiting.add(id); for (const parent of effect.dependsOn) visit(parent); visiting.delete(id); ordered.set(id, effect);
          };
          for (const effect of row.plan.effects) visit(effect.effectId);
          for (const effect of ordered.values()) {
            const state = await db.read<{ state: string; commandId?: string }>('effects', sourceKey(work.id, effect.effectId));
            let commandId = state?.commandId ?? effect.commandId;
            if (!state?.commandId && effect.kind === 'ensureSourceFolder') {
              const folder = await db.transaction(['folderReservations'], 'readonly', tx => new Promise<{ commandId: string } | undefined>((resolve, reject) => {
                const r = tx.objectStore('folderReservations').index('id').get(effect.reservationId); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
              }));
              commandId = folder?.commandId ?? commandId;
            }
            const outbox = commandId ? await db.read<{ executorAcknowledged?: boolean; state?: string }>('outbox', commandId) : undefined;
            if (state?.state === 'confirmed' && (!outbox || outbox.executorAcknowledged)) continue;
            recoveringStarted ||= !!outbox && outbox.state !== 'reserved';
            if (!budget) { complete = false; break; }
            budget--;
            const result = await ports.execute(work.id, effect.effectId);
            if (result.status !== 'confirmed') { complete = false; reason = result.reason ?? 'executionUnavailable'; break; }
          }
        }
      } catch (error) { complete = false; reason = error instanceof Error ? error.message : 'executionUnavailable'; }
      await db.transaction(['work'], 'readwrite', async tx => {
        if (complete) tx.objectStore('work').delete(work.id);
        else put(tx, 'work', work.id, { ...work, attempts: work.attempts + 1, dueAt: reason && !recoveringStarted && ['sourceAuthorizationChanged', 'rulesChanged', 'sourcePolicyChanged', 'mountChanged', 'sourceFactsChanged', 'consumerCancelled',
          'invalidPlan', 'sourceCopySuppressed', 'sourceCopyDetached', 'nativeIdentityChanged'].includes(reason) ? Number.MAX_SAFE_INTEGER : reason ? now() + 30000 : 0, ...(reason ? { reason } : {}) });
      });
    }
    const next = await db.transaction(['work'], 'readonly', async tx => (await cursorPage<SourceWork>(tx.objectStore('work').index('dueAt'), null, 1))[0]);
    if (next && next.dueAt < Number.MAX_SAFE_INTEGER) ports.schedule(Math.max(now() + 50, next.dueAt));
  };
}
