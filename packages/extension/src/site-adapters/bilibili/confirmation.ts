import type { SiteObservation } from '../contracts.js';
import type { BilibiliReader } from './reader.js';
import type { FavoriteHint } from './probe-wire.js';
import type { HttpContext } from './http.js';
/** Called by a host-issued paced read, never an independent page fetch loop.
 * Probe success plus fresh membership is state evidence, not proof of a human action. */
export async function confirmHint(reader: BilibiliReader, hint: FavoriteHint, context: HttpContext): Promise<SiteObservation> {
  const uncertain = (): SiteObservation => ({ type: 'favorite.uncertain', interactionId: hint.interactionId, itemId: hint.itemId, reason: 'ambiguousState' });
  if (hint.code !== 0 || !hint.added.length) return uncertain();
  const result = await reader.readMemberships({ itemId: hint.itemId, collectionIds: hint.added }, context);
  if (result.status !== 'ok' || result.edges.some(x => x.state !== 'present')) return uncertain();
  const item = await reader.readItem(hint.itemId, context);
  return item ? { type: 'membership.observed', item, memberships: { mode: 'delta', added: hint.added, removed: [] } } : uncertain();
}
