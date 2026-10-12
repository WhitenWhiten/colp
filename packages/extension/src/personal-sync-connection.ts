import { personalSyncKey, type PersonalSyncIdentity, type PersonalSyncStorage } from './personal-sync-policy.js';
export interface RememberedSyncConnection {
  readonly version: 1;
  readonly collectionId: string;
  readonly binding: { readonly replicaId: string; readonly browserProfileId: string; readonly generation: string };
}
export const CONNECTION_PREFIX = 'known.personal-sync-connection.v1:';
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048;
export function connectionKey(identity: PersonalSyncIdentity): string {
  return CONNECTION_PREFIX + personalSyncKey(identity);
}
export function parseRememberedConnection(raw: unknown): RememberedSyncConnection | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).length !== 3 || row.version !== 1 || !text(row.collectionId)
    || !row.binding || typeof row.binding !== 'object' || Array.isArray(row.binding)) return null;
  const binding = row.binding as Record<string, unknown>;
  if (Object.keys(binding).length !== 3 || !text(binding.replicaId) || !text(binding.browserProfileId)
    || typeof binding.generation !== 'string' || !/^[1-9][0-9]{0,14}$/u.test(binding.generation)) return null;
  return { version: 1, collectionId: row.collectionId,
    binding: { replicaId: binding.replicaId, browserProfileId: binding.browserProfileId, generation: binding.generation } };
}
/** Contains only non-secret replica identity; restoring still requires a verified matching account. */
export function createRememberedConnectionStore(storage: PersonalSyncStorage) {
  return Object.freeze({
    async read(identity: PersonalSyncIdentity) { return parseRememberedConnection((await storage.get(connectionKey(identity)))[connectionKey(identity)]); },
    async write(identity: PersonalSyncIdentity, connection: RememberedSyncConnection | null) {
      const parsed = connection === null ? null : parseRememberedConnection(connection);
      if (connection !== null && (!parsed || identity.collectionId !== parsed.collectionId)) throw new Error('connection_invalid');
      await storage.set({ [connectionKey(identity)]: parsed });
    },
  });
}
