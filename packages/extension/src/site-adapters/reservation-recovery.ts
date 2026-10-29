import { get, put, sourcePrefixRange, sourceKey } from './source-db.js';
import { iterateCursor } from '../sync-state/idb.js';
import { planIntentKey, type SourcePlanIntent } from './plan-intents.js';
import type { SourceOutbox, StoredSavePlan } from './planned-types.js';
import type { ItemReservation } from './reservations.js';

/** Only live plans whose bookmark command has never been submitted may be replaced. */
export async function supersedeUnsubmittedSourcePlans(tx: IDBTransaction, reservation: ItemReservation, nextPlanId: string) {
  const outbox = await get<SourceOutbox>(tx, 'outbox', reservation.commandId);
  if (reservation.state !== 'reserved' || outbox && (outbox.state !== 'reserved' || outbox.native)) throw new Error('conflict');
  const intents: SourcePlanIntent[] = [];
  await iterateCursor(tx.objectStore('meta'), sourcePrefixRange('sourcePlanIntent'), value => {
    const intent = value as SourcePlanIntent;
    if (intent.commandId === reservation.commandId && intent.id !== nextPlanId && intent.state !== 'cancelled') intents.push(intent);
  });
  const plans: StoredSavePlan[] = [];
  await new Promise<void>((resolve, reject) => {
    const request = tx.objectStore('savePlans').openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result; if (!cursor) { resolve(); return; }
      const row = cursor.value as StoredSavePlan;
      if (row.plan.id !== nextPlanId && row.state !== 'cancelled'
        && row.plan.effects.some(effect => effect.kind === 'createBookmark' && effect.commandId === reservation.commandId)) plans.push(row);
      cursor.continue();
    };
  });
  // Import approvals pin immutable previews. They must be cancelled by their own owner.
  if (!intents.length && !plans.length || intents.some(intent => intent.trigger.kind !== 'observation')
    || plans.some(row => row.plan.trigger.kind !== 'observation')) throw new Error('conflict');
  if (outbox) tx.objectStore('outbox').delete(reservation.commandId);
  const ids = new Set([...intents.map(intent => intent.id), ...plans.map(row => row.plan.id)]);
  for (const intent of intents) put(tx, 'meta', planIntentKey(intent.id), { ...intent, state: 'cancelled' });
  for (const row of plans) put(tx, 'savePlans', row.plan.id, { ...row, state: 'cancelled' });
  for (const id of ids) tx.objectStore('work').delete(id);
  for (const row of plans) for (const effect of row.plan.effects) if (effect.kind === 'ensureSourceFolder') {
    const key = sourceKey(effect.reservationId, row.plan.id, effect.effectId);
    const consumer = await get<Record<string, unknown>>(tx, 'folderConsumers', key);
    if (consumer) put(tx, 'folderConsumers', key, { ...consumer, active: false });
  }
}
