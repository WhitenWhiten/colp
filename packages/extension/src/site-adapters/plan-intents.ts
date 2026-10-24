import type { RepresentationKey, SavePlan } from './contracts.js';
import { get, put, sourceDigest, sourceKey, type SourceDatabase } from './source-db.js';
export interface SourcePlanIntent {
  id: string; trigger: SavePlan['trigger']; representation: RepresentationKey; commandId: string;
  folder: { mountId: string; collectionId: string }; state: 'active' | 'cancelled';
}
export const planIntentKey = (id: string) => sourceKey('sourcePlanIntent', id);
/** Persist the owner before reserving resources, so a crash never leaves an untraceable draft. */
export async function beginSourcePlan(db: SourceDatabase, intent: SourcePlanIntent) {
  await db.transaction(['meta'], 'readwrite', async tx => {
    const previous = await get<SourcePlanIntent>(tx, 'meta', planIntentKey(intent.id));
    if (previous?.state === 'cancelled') throw new Error('planCancelled');
    if (previous && sourceDigest(previous) !== sourceDigest(intent)) throw new Error('conflict');
    if (!previous) put(tx, 'meta', planIntentKey(intent.id), intent);
  });
}
export async function assertPlanIntentActive(tx: IDBTransaction, planId: string) {
  if ((await get<SourcePlanIntent>(tx, 'meta', planIntentKey(planId)))?.state === 'cancelled') throw new Error('planCancelled');
}
