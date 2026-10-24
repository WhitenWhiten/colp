import { virtualNativeId } from './projection-native-occupancy.js';
import { isProtocolOpaqueId } from './protocol-id.js';
import { validateScope } from './sync-state/scope-key.js';
import type { MappingFact } from './bootstrap/matcher.js';
import type { StorageArea } from './credential-store.js';
import type { SyncScope, createSyncStateStore } from './sync-state-store.js';

export const REPLICA_REBUILD_IDENTITY = 'known.sync.replica-rebuild-identity.v1';
const OWNER = ['environment', 'serverId', 'serverOrigin', 'accountId', 'browserProfileId', 'collectionId'] as const;
const sameOwner = (a: SyncScope, b: SyncScope) => OWNER.every(key => a[key] === b[key]);

/** Archived identity is evidence for a fresh merge, never authority to replay old work. */
export async function readRebuildIdentityHints(input: {
  readonly scope: SyncScope;
  readonly storage: Pick<StorageArea, 'get'>;
  readonly store: Pick<ReturnType<typeof createSyncStateStore>, 'exportArchive'>;
}): Promise<readonly MappingFact[]> {
  const value = (await input.storage.get(REPLICA_REBUILD_IDENTITY))[REPLICA_REBUILD_IDENTITY];
  if (!value || typeof value !== 'object') return [];
  const record = value as { target?: unknown; source?: unknown };
  let source: SyncScope; let target: SyncScope;
  try { source = validateScope(record.source); target = validateScope(record.target); } catch { return []; }
  if (!sameOwner(source, input.scope) || !sameOwner(target, input.scope) || source.replicaId === target.replicaId) return [];
  const archive = await input.store.exportArchive(source);
  if (archive.reason !== 'user_replica_rebuild' || !Array.isArray(archive.mappings)) return [];
  const rows: MappingFact[] = [];
  const nativeCounts = new Map<string, number>(); const remoteCounts = new Map<string, number>();
  for (const value of archive.mappings) {
    if (!value || typeof value !== 'object') continue;
    const row = value as { nativeId?: unknown; colpId?: unknown; projection?: { revision?: unknown } };
    if (typeof row.nativeId !== 'string' || virtualNativeId(row.nativeId)
        || !isProtocolOpaqueId(row.colpId) || /^(?:pending-|local-|mount:)/u.test(row.colpId)
        || typeof row.projection?.revision !== 'string' || row.projection.revision === 'local-root') continue;
    rows.push({ nativeId: row.nativeId, colpId: row.colpId });
    nativeCounts.set(row.nativeId, (nativeCounts.get(row.nativeId) ?? 0) + 1);
    remoteCounts.set(row.colpId, (remoteCounts.get(row.colpId) ?? 0) + 1);
  }
  return rows.filter(row => nativeCounts.get(row.nativeId) === 1 && remoteCounts.get(row.colpId) === 1);
}
