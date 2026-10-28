import type { CaptureScope } from '../capture/contracts.js';
import type { ContentIdentity } from './contracts.js';
import type { ManagedContent } from './copy-identity.js';
import { localSourceScopeId } from './local-identity.js';
export const semanticScopeId = (_scope: CaptureScope, deviceId: string) => localSourceScopeId(deviceId);
export const managedContent = (identity: ContentIdentity): ManagedContent => ({ site: identity.siteKey, identityVersion: identity.identityVersion, itemId: identity.itemId, accountId: identity.accountId ?? null });
export const captureContent = (identity: ManagedContent): ContentIdentity => ({ siteKey: identity.site, identityVersion: identity.identityVersion, itemId: identity.itemId, ...(identity.accountId ? { accountId: identity.accountId } : {}) });
