import type { CaptureScope } from '../capture/contracts.js';
import type { ContentIdentity } from './contracts.js';
import type { ManagedContent } from './copy-identity.js';
import { destinationScopeId } from './destination-scope.js';
/** Resolving a library is local metadata work; it never requires a server request. */
export const semanticScopeId = (scope: CaptureScope, deviceId: string) => destinationScopeId(scope, deviceId);
export const managedContent = (identity: ContentIdentity): ManagedContent => ({ site: identity.siteKey, identityVersion: identity.identityVersion, itemId: identity.itemId, accountId: identity.accountId ?? null });
export const captureContent = (identity: ManagedContent): ContentIdentity => ({ siteKey: identity.site, identityVersion: identity.identityVersion, itemId: identity.itemId, ...(identity.accountId ? { accountId: identity.accountId } : {}) });
