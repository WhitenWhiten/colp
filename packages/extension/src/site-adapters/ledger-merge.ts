import { legacySite } from './registry.js';
import type { SiteCollection, SiteItem, SiteObservation } from './contracts.js';
import type { LedgerEdge, SourceContext } from './ledger-types.js';
import { get, put, rows, sourceKey } from './source-db.js';
export async function mergeEntity(tx: IDBTransaction, kind: 'items' | 'collections', connectionId: string,
  entity: SiteItem | SiteCollection, ordinal: number, baseline?: number, context?: SourceContext) {
  const key = sourceKey(connectionId, entity.id);
  const current = await get<{ entity: typeof entity; ordinal: number }>(tx, kind, key);
  if (baseline !== undefined && current && current.ordinal > baseline) return;
  put(tx, kind, key, { entity, ordinal, ...(kind === 'collections' && context ? { source: { installationId: context.installationId ?? legacySite.adapterId, installationGeneration: context.installationGeneration, sourceSessionGeneration: context.sourceSessionGeneration } } : {}) });
}
export async function mergeEdge(tx: IDBTransaction, ctx: SourceContext, itemId: string, collectionId: string,
  state: 'present' | 'absent', ordinal: number, observationId: string, baseline?: number) {
  const key = sourceKey(ctx.connectionId, itemId, collectionId), old = await get<LedgerEdge>(tx, 'memberships', key);
  if (baseline !== undefined && old && old.liveOrdinal > baseline) return;
  // Independent live reports have no comparable source revision. Keep both on contradiction.
  const contradiction = baseline === undefined && old && old.evidence !== 'import' && (old.state === 'unresolved' || old.state !== state);
  const conflicts = contradiction ? [...new Set([...old.conflicts, old.observationId, observationId])] : [];
  if (conflicts.length > 64) throw new Error('capacity');
  put(tx, 'memberships', key, { connectionId: ctx.connectionId, itemId, collectionId,
    state: contradiction ? 'unresolved' : state, ordinal, liveOrdinal: baseline === undefined ? ordinal : old?.liveOrdinal ?? 0,
    evidence: baseline === undefined ? 'live' : 'import', observationId, conflicts } satisfies LedgerEdge);
}
export async function mergeObservation(tx: IDBTransaction, ctx: SourceContext, o: SiteObservation, ordinal: number, observationId: string) {
  if (o.type === 'favorite.uncertain') return;
  if (o.type === 'catalog.upsert') {
    for (const c of o.collections ?? []) await mergeEntity(tx, 'collections', ctx.connectionId, c, ordinal, undefined, ctx);
    for (const i of o.items ?? []) await mergeEntity(tx, 'items', ctx.connectionId, i, ordinal);
    return;
  }
  await mergeEntity(tx, 'items', ctx.connectionId, o.item, ordinal);
  if (o.memberships.mode === 'delta') {
    for (const id of o.memberships.added) await mergeEdge(tx, ctx, o.item.id, id, 'present', ordinal, observationId);
    for (const id of o.memberships.removed) await mergeEdge(tx, ctx, o.item.id, id, 'absent', ordinal, observationId);
  } else {
    const requested = new Set(o.memberships.collectionIds);
    // Complete means this item's complete memberships, never unrelated edges.
    const edges = await rows<LedgerEdge>(tx, 'memberships', ctx.connectionId, o.item.id);
    for (const id of new Set([...requested, ...edges.map(e => e.collectionId)]))
      await mergeEdge(tx, ctx, o.item.id, id, requested.has(id) ? 'present' : 'absent', ordinal, observationId);
  }
}

/** Fresh scoped reads replace only facts at/before their dispatch baseline. Preserve later observations and import overlays. */
export async function mergeReadEdges(tx: IDBTransaction, ctx: SourceContext, itemId: string,
  memberships: { added: readonly string[]; removed: readonly string[] }, baseline: number, ordinal: number, observationId: string) {
  const applied: { added: string[]; removed: string[] } = { added: [], removed: [] };
  for (const kind of ['added', 'removed'] as const) for (const collectionId of memberships[kind]) {
    const key = sourceKey(ctx.connectionId, itemId, collectionId), old = await get<LedgerEdge>(tx, 'memberships', key);
    if (old && old.ordinal > baseline) continue;
    put(tx, 'memberships', key, { connectionId: ctx.connectionId, itemId, collectionId, state: kind === 'added' ? 'present' : 'absent',
      ordinal, liveOrdinal: ordinal, evidence: 'read', observationId, conflicts: [] } satisfies LedgerEdge);
    applied[kind].push(collectionId);
  }
  return applied;
}
