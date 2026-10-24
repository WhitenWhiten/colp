import { adapterBrowserSupport } from './browser-support.js';
import { communityStore, communityScopeDigest, fenceCommunity, type CommunityOrigin } from './community-state.js';
import { siteLedger } from './source-runtime.js';
import type { SourceAuthority } from './ledger-types.js';
import type { SourcePolicyRecord } from './layout.js';
import { communityRegistrationMatches } from './community-registration.js';
export const COMMUNITY_GRANTS = { permissions: ['userScripts', 'webNavigation'], origins: ['https://www.bilibili.com/*'] };
export async function communityApiAvailable() {
  if (!adapterBrowserSupport(navigator.userAgent).supported) throw new Error('communityBrowserUnsupported');
  if (!await chrome.permissions.contains(COMMUNITY_GRANTS)) throw new Error('communityPermissionRequired');
  try { return await chrome.userScripts.getScripts(); } catch {
    await communityStore.mutate(rows => { for (const r of rows) if (r.enabled) { fenceCommunity(r); r.error = 'communityToggleRequired'; } });
    throw new Error('communityToggleRequired');
  }
}
/** Rechecked at confirmation and immediately before each native dispatch; installed code has no spending API. */
export async function assertCommunityArchive(origin: CommunityOrigin, input: { connectionId: string; collectionIds: readonly string[]; rootNativeId?: string }) {
  const scripts = await communityApiAvailable();
  const row = (await communityStore.read()).find(r => r.id === origin.installationId), scope = row?.archive;
  if (!row?.enabled || row.hostVersion !== chrome.runtime.getManifest().version || !communityRegistrationMatches(row, scripts) || row.generation !== origin.generation || row.approved.digest !== origin.packageDigest || !scope || scope.digest !== origin.scopeDigest
    || communityScopeDigest(scopePayload(scope)) !== scope.digest || scope.connectionId !== input.connectionId
    || input.collectionIds.some(id => !scope.collectionIds.includes(id)) || input.rootNativeId && scope.rootNativeId !== input.rootNativeId) throw new Error('communityArchiveRevoked');
  const a = await siteLedger.db.read<SourceAuthority>('authorities', 'bundled.bilibili');
  const policy = await siteLedger.db.read<SourcePolicyRecord>('meta', `policy:${scope.connectionId}`);
  if (!a?.enabled || a.connectionId !== scope.connectionId || a.installationGeneration !== scope.installationGeneration
    || a.sourceSessionGeneration !== scope.sourceSessionGeneration || !policy?.enabled || !policy.liveArchive || policy.policy.revision !== scope.policyRevision) throw new Error('communityArchiveScopeChanged');
}
function scopePayload(scope: NonNullable<Awaited<ReturnType<typeof communityStore.read>>[number]['archive']>) {
  const { digest: _digest, ...payload } = scope; return payload;
}
