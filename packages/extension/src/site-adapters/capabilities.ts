import type { SiteDefinition } from './registry-types.js';
/** Operation support and product features are distinct. Observation does not imply enumeration. */
export function siteFeatures(definition: Pick<SiteDefinition, 'capabilities' | 'defaultCollection'>) {
  const has = (capability: SiteDefinition['capabilities'][number]) => definition.capabilities.includes(capability);
  const observe = has('observeFavorites'), collections = has('enumerateCollections'), items = has('enumerateItems'), resolve = has('resolveItem');
  return { observe, collections, items, resolve, confirmation: observe && has('readMemberships') && resolve,
    import: (collections || !!definition.defaultCollection) && items, liveArchive: observe, archive: observe || (collections || !!definition.defaultCollection) && items };
}
export type SiteFeatures = ReturnType<typeof siteFeatures>;

/** Rechecking is not mirroring: negative authority must be qualified independently. */
export function reconciliationCapability(definition: Pick<SiteDefinition, 'collectionSnapshot' | 'negativeReadback'>) {
  return definition.collectionSnapshot === 'pointInTime' ? 'snapshotAbsence' as const
    : definition.negativeReadback ? 'scopedAbsence' as const : 'positiveOnly' as const;
}
