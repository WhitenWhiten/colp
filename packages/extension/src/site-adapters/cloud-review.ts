import { sourceKey, sourceDigest } from './source-db.js';
import type { SiteDefinition } from './registry-types.js';
/** Approval previews never share an installation, source connection or cloud owner. Legacy unscoped previews expire inertly. */
export function cloudReviewKey(definition: Pick<SiteDefinition, 'adapterId' | 'siteKey' | 'identityVersion'>,
  owner: { serverOrigin: string; accountId: string; collectionId: string; replicaId: string; generation: number }, connectionId: string) {
  return sourceKey('sourceCloudReview:v2', definition.adapterId, definition.siteKey, definition.identityVersion, sourceDigest(owner), connectionId);
}
