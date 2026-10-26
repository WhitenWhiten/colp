import type { SiteDefinition } from '../registry-types.js';
import { BILIBILI, decimal, validBilibiliItem, resolveAvUrl, resolveBvUrl, itemId, aidFromItem } from './identity.js';
import { validBilibiliMessage } from './wire.js';
export const bilibiliDefinition: SiteDefinition = Object.freeze<SiteDefinition>({
  ...BILIBILI, label: 'Bilibili', collectionHierarchy: 'flat', collectionSnapshot: 'positiveOnly', membershipModel: 'set', readScope: 'account', contentIdScope: 'site', negativeReadback: false, importResume: 'restartAndDeduplicate',
  capabilities: ['observeFavorites', 'resolveItem', 'readMemberships', 'enumerateCollections', 'enumerateItems'],
  community: { connectOrigins: ['https://api.bilibili.com'] },
  scripts: { adapter: 'site-adapter.js', probe: 'site-probe.js' },
  validateAccount: (id: unknown) => typeof id === 'string' && !!decimal(id),
  validateCollection: (id: unknown) => typeof id === 'string' && !!decimal(id),
  validateItem: validBilibiliItem, validateMessage: validBilibiliMessage,
  contentIdentity(url: string) { const aid = resolveAvUrl(url); return aid ? { siteKey: BILIBILI.siteKey, identityVersion: BILIBILI.identityVersion, itemId: itemId(aid) } : null; },
  itemUrl(id: string) { const aid = aidFromItem(id); return aid ? `${BILIBILI.origin}/video/av${aid}` : null; },
  sameResolutionTarget(a: string, b: string) { const id = resolveBvUrl(a); return !!id && id === resolveBvUrl(b); },
});
