import { retryableSourceDependency } from './retry-policy.js';
import { get, put } from './source-db.js';
import { legacySite, type SiteDefinition } from './registry.js';
import { createLane } from '../automation/lane.js';
import { cursorPage } from '../sync-state/idb.js';
import { settleSourceObservation } from './ledger.js';
import type { ObservationRow, SourceAuthority } from './ledger-types.js';
import type { SourceDatabase } from './source-db.js';
import type { createSourceLayout, SourcePolicyRecord } from './layout.js';
/** Independent of import admission: scanning never discards or substitutes a live observation. */
export function createLiveSourcePlanner(db: SourceDatabase, layout: ReturnType<typeof createSourceLayout>, alarm: (delay?: number) => void, definition: SiteDefinition = legacySite) {
  const lane = createLane();
  return { wake: () => lane(async () => {
    const authority = await db.read<SourceAuthority>('authorities', definition.adapterId); if (!authority?.enabled || !authority.connectionId) return;
    const policy = await db.read<SourcePolicyRecord>('meta', `policy:${authority.connectionId}`); if (!policy?.enabled || !policy.liveArchive) return;
    const batch = await db.transaction(['observations'], 'readonly', tx => cursorPage<ObservationRow>(tx.objectStore('observations').index('installationReady'), IDBKeyRange.bound([definition.adapterId, 'pending', 0], [definition.adapterId, 'pending', Date.now(), Number.MAX_SAFE_INTEGER]), 20));
    for (const row of batch) {
      if (row.state === 'settled') continue;
      const plans: string[] = [], edges: { collectionId: string; status: string }[] = []; let reason = 'noPositiveMembership', deferred = false, failed = false; let deferredReason: string | undefined, failureReason: string | undefined;
      if (row.context.connectionId !== authority.connectionId || row.context.installationGeneration !== authority.installationGeneration || row.context.sourceSessionGeneration !== authority.sourceSessionGeneration) reason = 'sourceAuthorizationChanged';
      else if (row.ordinal <= (policy.admittedAfterOrdinal ?? 0)) reason = 'beforeSourceActivation';
      else if (row.observation.type === 'membership.observed' || row.observation.type === 'favorite.confirmed') {
        const o = row.observation, ids = o.memberships.mode === 'delta' ? o.memberships.added : o.memberships.collectionIds;
        for (const id of ids) {
          try {
            const result = await layout.plan({ context: row.context, itemId: o.item.id, collectionId: id, entry: row.cause,
              trigger: { kind: 'observation', observationId: row.id } });
            reason = result.status; edges.push({ collectionId: id, status: result.status }); if (result.status === 'planned') plans.push(result.plan.id);
          } catch (e) {
            reason = e instanceof Error ? e.message : 'sourceNeedsReview';
            if (retryableSourceDependency(reason)) { deferred = true; deferredReason ??= reason; alarm(30000); continue; }
            failed = true; failureReason ??= reason; edges.push({ collectionId: id, status: reason });
          }
        }
      }
      if (deferred) await db.transaction(['observations'], 'readwrite', async tx => {
        const current = await get<ObservationRow>(tx, 'observations', row.id);
        if (current?.state === 'pending') put(tx, 'observations', row.id, { ...current, readyAt: Date.now() + 30000, retryReason: deferredReason ?? reason });
      });
      else await settleSourceObservation(db, row.id, { reason, planIds: plans, edges, ...(failed ? { problem: failureReason ?? reason } : {}) });
      if (plans.length) alarm();
    }
    const next = await db.transaction(['observations'], 'readonly', async tx => (await cursorPage<ObservationRow>(tx.objectStore('observations').index('installationReady'),
      IDBKeyRange.bound([definition.adapterId, 'pending', 0], [definition.adapterId, 'pending', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]), 1))[0]);
    if (next) alarm(Math.max(50, (next.readyAt ?? 0) - Date.now()));
  }) };
}
