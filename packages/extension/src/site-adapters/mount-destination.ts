import type { DestinationOwner } from './copy-identity.js';
import { sameDestinationOwner } from './copy-identity.js';
import type { SourceMount } from './layout.js';
import type { SourcePlanIntent } from './plan-intents.js';
import type { StoredSavePlan, SourceOutbox } from './planned-types.js';
import type { ItemReservation } from './reservations.js';
import type { Representation } from './contracts.js';
import { get, put, rows, sourceDigest, sourceKey, type SourceDatabase } from './source-db.js';

/** Older, unused mappings have no owner snapshot. Establish it before making any drafts. */
export async function initializeMountDestination(db: SourceDatabase, mount: SourceMount, destination: DestinationOwner | null): Promise<SourceMount> {
  if (mount.destination !== undefined || mount.state !== 'active') return mount;
  return db.transaction(['mounts', 'folderReservations', 'representations', 'itemReservations', 'savePlans', 'meta', 'outbox'], 'readwrite', async tx => {
    const key = sourceKey(mount.connectionId, mount.rootRuleId), current = await get<SourceMount>(tx, 'mounts', key);
    if (!current || sourceDigest(current) !== sourceDigest(mount)) throw new Error('sourceDestinationNeedsReview');
    const siblings = await rows<SourceMount>(tx, 'mounts', mount.connectionId);
    if (siblings.some(m => m.id === mount.id && m.destination !== undefined && !sameDestinationOwner(m.destination, destination))) return mount;
    const aliases = siblings.filter(m => m.state === 'active'
      && m.root.nativeId === mount.root.nativeId && m.root.dateAdded === mount.root.dateAdded && m.root.deviceId === mount.root.deviceId
      && m.destination !== undefined && sameDestinationOwner(m.destination, destination));
    const sameIdentity = aliases.find(m => m.id === mount.id);
    if (!sameIdentity) {
      if ((await rows(tx, 'folderReservations', mount.id)).length
        || (await rows<Representation>(tx, 'representations', mount.connectionId)).some(r => r.mountId === mount.id)
        || (await rows<ItemReservation>(tx, 'itemReservations', mount.connectionId)).some(r => r.representation.mountId === mount.id)
        || (await rows<SourcePlanIntent>(tx, 'meta', 'sourcePlanIntent')).some(i => i.state !== 'cancelled' && i.representation.mountId === mount.id)) return mount;
      const plans = await new Promise<StoredSavePlan[]>((resolve, reject) => {
        const request = tx.objectStore('savePlans').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const outbox = await new Promise<SourceOutbox[]>((resolve, reject) => {
        const request = tx.objectStore('outbox').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      if (plans.some(p => p.state !== 'cancelled' && p.plan.mount?.id === mount.id)
        || outbox.some(o => o.command.bookmark?.representation.mountId === mount.id)) return mount;
    }
    if (new Set(aliases.map(m => m.id)).size > 1) throw new Error('sourceMappingMigrationRequired');
    // A configured rule may already name this same root. Keep a single mapping
    // identity so its folders, overview and older rule aliases all agree.
    const canonical = sameIdentity ?? aliases[0];
    const next: SourceMount = canonical ? { ...canonical, rootRuleId: mount.rootRuleId,
      aiDestination: canonical.aiDestination === 'excluded' || mount.aiDestination === 'excluded' ? 'excluded' : 'allowed' }
      : { ...mount, destination, revision: mount.revision + 1 };
    put(tx, 'mounts', key, next); return next;
  });
}
