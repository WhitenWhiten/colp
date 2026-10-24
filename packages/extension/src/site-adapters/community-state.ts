import type { StorageArea } from '../credential-store.js';
import { createLane } from '../automation/lane.js';
import type { PackagePreview } from './community-package.js';
import { sourceDigest } from './source-db.js';
export const COMMUNITY_STATE = 'known.siteAdapters.community.v1';
export interface CommunityOrigin { installationId: string; generation: number; scopeDigest: string; packageDigest: string }
export interface CommunityArchiveScope { connectionId: string; rootNativeId: string; collectionIds: readonly string[];
  installationGeneration: number; sourceSessionGeneration: number; policyRevision: number }
export interface CommunityLease { id: string; capability: string; tabId: number; documentId: string; url: string; routeEpoch: number; expiresAt: number }
export interface CommunityInstallation { id: string; generation: number; credential: string; hostVersion: string; enabled: boolean; approved: PackagePreview; previous: PackagePreview[];
  archive: (CommunityArchiveScope & { digest: string }) | null; leases: CommunityLease[]; routes: Record<string, number>;
  rate: { at: number; count: number }; lastReport: { at: number; mode: string; itemId: string } | null; error: string | null }
export function createCommunityStore(area: StorageArea) {
  const lane = createLane();
  const read = async () => {
    const raw = (await area.get(COMMUNITY_STATE))[COMMUNITY_STATE] as { version: number; installations: CommunityInstallation[] } | undefined;
    if (raw && (raw.version !== 1 || !Array.isArray(raw.installations) || raw.installations.length > 8)) throw new Error('communitySchemaIncompatible');
    return raw?.installations ?? [];
  };
  return { read, mutate: <T>(work: (rows: CommunityInstallation[]) => Promise<T> | T) => lane(async () => {
    const rows = await read(), result = await work(rows);
    if (new TextEncoder().encode(JSON.stringify(rows)).byteLength > 16 * 1024 * 1024) throw new Error('communityCapacity');
    await area.set({ [COMMUNITY_STATE]: { version: 1, installations: rows } }); return result;
  }) };
}
export const communityStore = createCommunityStore({ get: keys => chrome.storage.local.get(keys), set: values => chrome.storage.local.set(values), remove: keys => chrome.storage.local.remove(keys) });
export function fenceCommunity(row: CommunityInstallation, enabled = false) {
  row.generation++; row.credential = crypto.randomUUID() + crypto.randomUUID(); row.enabled = enabled; row.leases = []; row.archive = null;
}
export const communityScriptId = (row: Pick<CommunityInstallation, 'id'>) => `colp-user-${row.id}`;
export const communityWorldId = (row: Pick<CommunityInstallation, 'id' | 'generation'>) => `colp-user-${row.id}-${row.generation}`;
export const communityScopeDigest = (scope: CommunityArchiveScope) => sourceDigest(scope);
