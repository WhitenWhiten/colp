import { bilibiliSourceIdentity } from './sites/bilibili.js';
export interface SourceSiteIdentity {
  site: string; identityVersion: number;
  account(id: string): boolean; collection(id: string): boolean; item(id: string, url: string): boolean;
}
/** Audited server identities. Adding support does not alter transactions or reservation semantics. */
export const sourceSiteIdentities: readonly SourceSiteIdentity[] = [bilibiliSourceIdentity];
export const legacySourceIdentity = bilibiliSourceIdentity;
export const sourceSiteIdentity = (site: unknown, version: unknown) => sourceSiteIdentities.find(s => s.site === site && s.identityVersion === version);
export interface SourceLocator { site: string; identityVersion: number; sourceAccount: string }
/** Preserve all existing v1 receipt/reservation keys. Other namespaces cannot collide with decimal legacy IDs. */
export function sourceConnectionKey(source: SourceLocator): string {
  return source.site === legacySourceIdentity.site && source.identityVersion === legacySourceIdentity.identityVersion
    ? source.sourceAccount : JSON.stringify([source.site, source.identityVersion, source.sourceAccount]);
}
