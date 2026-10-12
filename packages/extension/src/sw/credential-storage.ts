import type { StorageArea } from '../credential-store.js';
import { credentialAreaReady } from './runtime.js';

/**
 * The credential store's storage layout.
 *
 * `chrome.storage.session` is the only area whose contents can be kept away from
 * the extension's own pages (via `TRUSTED_CONTEXTS` keeping out content scripts)
 * *and* cleared with the browser session, which is what a bearer credential
 * wants. But the store also holds the durable replica identity — `replicaId`,
 * `browserProfileId` and the authority-generation marker — which must NOT be
 * session-scoped: the scope key and every durable row derived from it include
 * `replicaId`, so regenerating the identity on each browser restart orphans the
 * outbound queue, the native mappings and the archives of the previous
 * incarnation, and mints a new server replica every restart.
 *
 * So the keys are split by sensitivity:
 * - secrets (credential, session, OAuth transaction) read and write `session`
 * - identity (binding, authority generation) read and write `local`
 *
 * Both areas are still reachable from an extension page; the split does not
 * change that. What it fixes is the identity churn, and it keeps the durable
 * rows alive across a restart.
 */
const SESSION_KEYS = new Set([
  'known.auth.credential.v1',
  'known.auth.session.v1',
  'known.auth.transaction.v1',
]);

/**
 * Keys the pre-split store left in `chrome.storage.local`.
 *
 * SECRETS ONLY. Before the split everything lived in `local`, so the three secret
 * keys still there are stale plaintext that nothing reads and that must not
 * linger — that is what the purge is for.
 *
 * The identity keys must NOT be in this list. After the split `binding` and
 * `authority-generation` are still routed to `local` (they are durable, and
 * `SESSION_KEYS` deliberately excludes them), so purging them deletes LIVE state
 * on every worker boot:
 *   - the replica identity is re-minted, so `scopeKey()` changes and every queued
 *     operation, mapping and archive is orphaned against a scope that no longer
 *     exists;
 *   - the authority fence resets to generation 0, revoked false, so a credential
 *     fenced out by `revokeAuthority()` becomes readable and writable again —
 *     a sign-out that silently un-revokes itself.
 * A pre-split profile cannot be told from a post-split one by key name, because
 * the identity keys are the same either way, so there is nothing to distinguish
 * and nothing safe to delete.
 */
const LEGACY_LOCAL_KEYS = [
  'known.auth.credential.v1',
  'known.auth.session.v1',
  'known.auth.transaction.v1',
];

export function createSplitCredentialStorage(local: StorageArea): StorageArea {
  const isSessionKey = (key: string): boolean => SESSION_KEYS.has(key);
  const session = async (): Promise<StorageArea> => credentialAreaReady;
  return {
    async get(keys) {
      const requested = keys === null ? null : typeof keys === 'string' ? [keys] : keys;
      const sessionKeys = requested === null ? null : requested.filter(isSessionKey);
      const localKeys = requested === null ? null : requested.filter((key) => !isSessionKey(key));
      const result: Record<string, unknown> = {};
      // Only touch an area when it is actually addressed, so a store that never
      // sees a secret does not wait on the session pin.
      if (sessionKeys === null || sessionKeys.length > 0) {
        Object.assign(result, await (await session()).get(sessionKeys));
      }
      if (localKeys === null || localKeys.length > 0) {
        Object.assign(result, await local.get(localKeys));
      }
      return result;
    },
    async set(items) {
      const sessionItems: Record<string, unknown> = {};
      const localItems: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(items)) {
        (isSessionKey(key) ? sessionItems : localItems)[key] = value;
      }
      if (Object.keys(sessionItems).length > 0) await (await session()).set(sessionItems);
      if (Object.keys(localItems).length > 0) await local.set(localItems);
    },
    async remove(keys) {
      const requested = typeof keys === 'string' ? [keys] : keys;
      const sessionKeys = requested.filter(isSessionKey);
      const localKeys = requested.filter((key) => !isSessionKey(key));
      if (sessionKeys.length > 0) await (await session()).remove(sessionKeys);
      if (localKeys.length > 0) await local.remove(localKeys);
    },
  };
}

/**
 * Deletes the pre-split store's keys from `chrome.storage.local`.
 *
 * Before the split the whole store lived in `local`, so an upgraded profile
 * still holds the plaintext bearer at the old address even though nothing reads
 * it any more. Leaving it there would keep exactly the exposure the move was
 * meant to end.
 */
export async function purgeLegacyLocalAuthority(local: StorageArea): Promise<void> {
  await local.remove(LEGACY_LOCAL_KEYS);
}
