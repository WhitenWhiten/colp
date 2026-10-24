import type { SavePlan, ImportApproval, SourceFolderReservation } from './contracts.js';
import type { StoredSavePlan } from './planned-types.js';
import { get, put, rows, sourceKey, type SourceDatabase } from './source-db.js';
import { planIntentKey, type SourcePlanIntent } from './plan-intents.js';
import { releaseUnsubmittedReservations } from './reservations.js';
/** Cancel both published drafts and preparation interrupted before a plan/page checkpoint existed. */
export async function cancelImportPlans(db: SourceDatabase, runId: string, approvalId: string | null, only?: readonly string[]) {
  await db.transaction(['meta', 'savePlans', 'folderConsumers', 'importApprovals', 'itemReservations', 'representations', 'folderReservations', 'outbox'], 'readwrite', async tx => {
    if (approvalId) {
      const approval = await get<ImportApproval>(tx, 'importApprovals', approvalId);
      if (approval) put(tx, 'importApprovals', approvalId, { ...approval, state: 'cancelled' });
    }
    const cancelled: SavePlan[] = [], ids = new Set(only ?? []);
    const intents = (await rows<SourcePlanIntent>(tx, 'meta', 'sourcePlanIntent')).filter(i => i.trigger.kind === 'import' && i.trigger.importRunId === runId && (!only || ids.has(i.id)));
    for (const intent of intents) { ids.add(intent.id); put(tx, 'meta', planIntentKey(intent.id), { ...intent, state: 'cancelled' }); }
    await new Promise<void>((resolve, reject) => {
      const r = tx.objectStore('savePlans').openCursor(); r.onerror = () => reject(r.error);
      r.onsuccess = () => { const c = r.result; if (!c) { resolve(); return; }
        const row = c.value as StoredSavePlan;
        if (row.plan.trigger.kind === 'import' && row.plan.trigger.importRunId === runId && (!only || ids.has(row.plan.id))) {
          ids.add(row.plan.id); cancelled.push(row.plan); c.update({ ...row, state: 'cancelled' });
        }
        c.continue();
      };
    });
    const folderIds = new Set<string>();
    await new Promise<void>((resolve, reject) => {
      const r = tx.objectStore('folderConsumers').openCursor(); r.onerror = () => reject(r.error);
      r.onsuccess = () => { const c = r.result; if (!c) { resolve(); return; }
        if (ids.has(c.value.planId)) { folderIds.add(c.value.reservationId); c.update({ ...c.value, active: false }); } c.continue();
      };
    });
    await releaseUnsubmittedReservations(tx, cancelled, intents);
    for (const intent of intents) {
      const key = sourceKey(intent.folder.mountId, intent.folder.collectionId), folder = await get<SourceFolderReservation>(tx, 'folderReservations', key);
      if (!folder || !folderIds.has(folder.id) || folder.state !== 'reserved' || folder.native || await get(tx, 'outbox', folder.commandId)) continue;
      if (!(await rows<{ active: boolean }>(tx, 'folderConsumers', folder.id)).some(c => c.active)) tx.objectStore('folderReservations').delete(key);
    }
  });
}
