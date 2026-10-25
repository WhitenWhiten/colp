import type { CaptureScope } from '../capture/contracts.js';
import type { ContentIdentity } from './contracts.js';
import type { ManagedContent } from './copy-identity.js';
import { managedLibraryKey } from './copy-identity.js';
export const semanticScopeId = (scope: CaptureScope, deviceId: string) => scope.accountId && scope.collectionId
  ? managedLibraryKey({ serverOrigin: scope.serverOrigin, accountId: scope.accountId, collectionId: scope.collectionId }) : JSON.stringify(['local', deviceId]);
export const managedContent = (identity: ContentIdentity): ManagedContent => ({ site: identity.siteKey, identityVersion: identity.identityVersion, itemId: identity.itemId, accountId: identity.accountId ?? null });
export const captureContent = (identity: ManagedContent): ContentIdentity => ({ siteKey: identity.site, identityVersion: identity.identityVersion, itemId: identity.itemId, ...(identity.accountId ? { accountId: identity.accountId } : {}) });
