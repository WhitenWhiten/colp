import type { StorageArea } from '../credential-store.js';
import { createLane } from '../automation/lane.js';
import type { PackagePreview } from './community-package.js';
export const COMMUNITY_STATE = 'known.siteAdapters.community.v1';
/** One installed package: its reviewed bytes, earlier reviewed versions, and the credential of its current USER_SCRIPT world. */
export interface CommunityInstallation { id: string; generation: number; credential: string; hostVersion: string; approved: PackagePreview; previous: PackagePreview[]; error: string | null }
export function createCommunityStore(area: StorageArea) {
  const lane = createLane();
  const read = async () => {
    const raw = (await area.get(COMMUNITY_STATE))[COMMUNITY_STATE] as { version: number; installations: CommunityInstallation[] } | undefined;
    if (raw && (![1, 2].includes(raw.version) || !Array.isArray(raw.installations) || raw.installations.length > 8)) throw new Error('communitySchemaIncompatible');
    // Version 1 rows also carried the removed hint mode's enable flag, leases and archive scope.
    return (raw?.installations ?? []).map(({ id, generation, credential, hostVersion, approved, previous, error }) => ({ id, generation, credential, hostVersion, approved, previous, error }));
  };
  return { read, mutate: <T>(work: (rows: CommunityInstallation[]) => Promise<T> | T) => lane(async () => {
    const rows = await read(), result = await work(rows);
    if (new TextEncoder().encode(JSON.stringify(rows)).byteLength > 16 * 1024 * 1024) throw new Error('communityCapacity');
    await area.set({ [COMMUNITY_STATE]: { version: 2, installations: rows } }); return result;
  }) };
}
export const communityStore = createCommunityStore({ get: keys => chrome.storage.local.get(keys), set: values => chrome.storage.local.set(values), remove: keys => chrome.storage.local.remove(keys) });
/** A new world for new bytes: the old credential and world ID grant nothing afterwards. */
export function fenceCommunity(row: CommunityInstallation) { row.generation++; row.credential = crypto.randomUUID() + crypto.randomUUID(); }
export const communityScriptId = (row: Pick<CommunityInstallation, 'id'>) => `colp-user-${row.id}`;
export const communityWorldId = (row: Pick<CommunityInstallation, 'id' | 'generation'>) => `colp-user-${row.id}-${row.generation}`;
