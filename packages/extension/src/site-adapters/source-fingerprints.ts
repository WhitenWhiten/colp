import type { Representation } from './contracts.js';
import type { LedgerEdge } from './ledger-types.js';
import type { ItemReservation } from './reservations.js';
import { rows, sourceDigest, sourceKey, type SourceDatabase } from './source-db.js';

export const sourceMembershipValue = (edge: LedgerEdge | undefined) => edge ? {
  connectionId: edge.connectionId, itemId: edge.itemId, collectionId: edge.collectionId, state: edge.state, conflicts: edge.conflicts,
} : null;

/** One consistent read for approving a large import; receipt ordinals are not content changes. */
export async function readSourceFingerprintSnapshot(db: SourceDatabase, connectionId: string) {
  const snapshot = await db.transaction(['items', 'collections', 'memberships', 'representations', 'itemReservations'], 'readonly', async tx => ({
    items: await rows<{ entity: { id: string } }>(tx, 'items', connectionId),
    collections: await rows<{ entity: { id: string } }>(tx, 'collections', connectionId),
    memberships: await rows<LedgerEdge>(tx, 'memberships', connectionId),
    representations: await rows<Representation>(tx, 'representations', connectionId),
    reservations: await rows<ItemReservation>(tx, 'itemReservations', connectionId),
  }));
  const items = new Map(snapshot.items.map(r => [r.entity.id, r.entity])), collections = new Map(snapshot.collections.map(r => [r.entity.id, r.entity]));
  const memberships = new Map(snapshot.memberships.map(r => [sourceKey(r.itemId, r.collectionId), r]));
  const representations = new Map<string, Representation[]>(), reservations = new Map<string, ItemReservation[]>();
  for (const row of snapshot.representations) if (row.purpose === 'sourceArchive') {
    const key = sourceKey(row.itemId, row.sourceCollectionId), group = representations.get(key) ?? []; group.push(row); representations.set(key, group);
  }
  for (const row of snapshot.reservations) if (row.representation.purpose === 'sourceArchive') {
    const key = sourceKey(row.representation.itemId, row.representation.sourceCollectionId), group = reservations.get(key) ?? []; group.push(row); reservations.set(key, group);
  }
  return (edge: { itemId: string; collectionId: string }) => {
    const key = sourceKey(edge.itemId, edge.collectionId);
    return sourceDigest({ item: items.get(edge.itemId) ?? null, collection: collections.get(edge.collectionId) ?? null,
      membership: sourceMembershipValue(memberships.get(key)), representations: representations.get(key) ?? [], reservations: reservations.get(key) ?? [] });
  };
}
