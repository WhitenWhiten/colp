import type { SiteDefinition } from './registry-types.js';
/** Operation support and product features are distinct. Observation does not imply enumeration. */
export function siteFeatures(definition: Pick<SiteDefinition, 'capabilities'>) {
  const has = (capability: SiteDefinition['capabilities'][number]) => definition.capabilities.includes(capability);
  const observe = has('observeFavorites'), collections = has('enumerateCollections'), items = has('enumerateItems'), resolve = has('resolveItem');
  return { observe, collections, items, resolve, confirmation: observe && has('readMemberships') && resolve,
    import: collections && items, liveArchive: observe, archive: observe || collections && items };
}
export type SiteFeatures = ReturnType<typeof siteFeatures>;
