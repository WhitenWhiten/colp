import type { AdapterMessage, SiteObservation, SiteCollection } from '../contracts.js';
import { aidFromItem, decimal, validBilibiliItem } from './identity.js';
const collections = (values: readonly string[]) => values.every(x => !!decimal(x));
const collection = (c: SiteCollection) => c.identity === 'siteId' && !!decimal(c.id) && c.parentId === null;
function observation(o: SiteObservation): boolean {
  if (o.type === 'catalog.upsert') return (!o.items || o.items.every(validBilibiliItem)) && (!o.collections || o.collections.every(collection));
  if (o.type === 'favorite.uncertain') return !!aidFromItem(o.itemId);
  return validBilibiliItem(o.item) && (o.memberships.mode === 'delta'
    ? collections([...o.memberships.added, ...o.memberships.removed]) : collections(o.memberships.collectionIds));
}
/** Registry-specific semantics supplement the generic closed v1 schema. */
export function validBilibiliMessage(m: AdapterMessage): boolean {
  if (m.operation === 'connect') return true;
  if (m.operation === 'membership.hint') return !!aidFromItem(m.hint.itemId) && collections([...m.hint.added, ...m.hint.removed]);
  if (m.operation === 'read') return false;
  if (m.operation === 'emit') return observation(m.data);
  if (m.operation === 'capture') return validBilibiliItem(m.data.item);
  if (m.operation === 'item.result') return m.result.status !== 'resolved' || validBilibiliItem(m.result.item);
  if (m.operation === 'membership.result') return m.result.status !== 'ok'
    || !!aidFromItem(m.result.itemId) && m.result.edges.every(x => !!decimal(x.collectionId) && x.state !== 'absent'); // unverified negative evidence remains unavailable
  if (m.result.status === 'failed') return true;
  return m.result.kind === 'collections' ? m.result.page.items.every(collection)
    : !!decimal(m.result.collectionId) && m.result.page.items.every(x => validBilibiliItem(x.item));
}
