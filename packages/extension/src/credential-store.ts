import type { SyncScope } from './sync-state-store.js';
import type { OAuthTransaction, StoredAuthBinding, StoredCredential, StoredSession } from './types.js';
import {
  AUTHORITY_GENERATION_KEY, AuthorityFencedError, createAuthorityFence,
} from './authority-fence.js';

export interface StorageArea { get(keys: string | string[] | null): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(keys: string | string[]): Promise<void>; }
const TRANSACTION = 'known.auth.transaction.v1';
const CREDENTIAL = 'known.auth.credential.v1';
const SESSION = 'known.auth.session.v1';
const REPORT_PROOFS = 'known.sync.report-proofs.v1';
const proofKey = (scope: Pick<SyncScope, 'serverOrigin' | 'accountId' | 'replicaId' | 'browserProfileId' | 'generation'>) =>
  JSON.stringify([scope.serverOrigin, scope.accountId, scope.replicaId, scope.browserProfileId, scope.generation]);
const BINDING = 'known.auth.binding.v1';
const BROWSER_PROFILE = 'known.auth.browser-profile.v1';
const SIGN_OUT_REASON = 'known.auth.signOutReason.v1';

export class MemoryStorageArea implements StorageArea {
  private readonly values = new Map<string, unknown>();
  async get(keys: string | string[] | null) { const result: Record<string, unknown> = {}; for (const key of keys === null ? this.values.keys() : array(keys)) if (this.values.has(key)) result[key] = structuredClone(this.values.get(key)); return result; }
  async set(items: Record<string, unknown>) { for (const [key, value] of Object.entries(items)) this.values.set(key, structuredClone(value)); }
  async remove(keys: string | string[]) { for (const key of array(keys)) this.values.delete(key); }
}

export function createCredentialStore(storage: StorageArea, now: () => number = Date.now) {
  const fence = createAuthorityFence(storage);
  return Object.freeze({
    fence,
    saveTransaction: (value: OAuthTransaction) => storage.set({ [TRANSACTION]: value }),
    async loadTransaction(): Promise<OAuthTransaction | null> { return read<OAuthTransaction>(storage, TRANSACTION); },
    async consumeTransaction(id: string): Promise<OAuthTransaction | null> {
      const value = await read<OAuthTransaction>(storage, TRANSACTION);
      await storage.remove(TRANSACTION);
      return value?.id === id && value.expiresAt > now() ? value : null;
    },
    clearTransaction: () => storage.remove(TRANSACTION),
    async saveCredential(value: StoredCredential, expectedGeneration?: number): Promise<void> {
      const current = await fence.assertWritable(expectedGeneration);
      const generation = expectedGeneration ?? current.generation;
      await storage.set({ [CREDENTIAL]: stamp(value, generation) });
      await reclaimIfFenced(storage, fence, CREDENTIAL, generation);
    },
    async loadCredential(): Promise<StoredCredential | null> {
      return unstamp(await read<Stamped<StoredCredential>>(storage, CREDENTIAL), await fence.read());
    },
    clearCredential: () => storage.remove(CREDENTIAL),
    async saveSession(value: StoredSession, expectedGeneration?: number): Promise<void> {
      const current = await fence.assertWritable(expectedGeneration);
      const generation = expectedGeneration ?? current.generation;
      const credential = unstamp(await read<Stamped<StoredCredential>>(storage, CREDENTIAL), current);
      const binding = await read<StoredAuthBinding>(storage, BINDING);
      if (credential?.subject && binding) {
        const proofs = unstamp(await read<Stamped<Record<string, string>>>(storage, REPORT_PROOFS), current) ?? {};
        const key = proofKey({ serverOrigin: credential.serverOrigin, accountId: credential.subject,
          replicaId: binding.replicaId, browserProfileId: binding.browserProfileId, generation: Number(binding.generation) });
        await storage.set({ [REPORT_PROOFS]: stamp({ ...proofs, [key]: value.sessionId }, generation) });
      }
      await storage.set({ [SESSION]: stamp(value, generation) });
      await reclaimIfFenced(storage, fence, SESSION, generation);
    },
    async loadSession(): Promise<StoredSession | null> {
      return unstamp(await read<Stamped<StoredSession>>(storage, SESSION), await fence.read());
    },
    clearSession: () => storage.remove(SESSION),
    async loadReplicaReportProof(scope: Pick<SyncScope, 'serverOrigin' | 'accountId' | 'replicaId' | 'browserProfileId' | 'generation'>): Promise<string | undefined> {
      const authority = await fence.read(); if (authority.revoked) return undefined;
      const proofs = unstamp(await read<Stamped<Record<string, string>>>(storage, REPORT_PROOFS), authority);
      if (proofs?.[proofKey(scope)]) return proofs[proofKey(scope)];
      // Compatibility with an installation whose last Session predates proof storage.
      const credential = unstamp(await read<Stamped<StoredCredential>>(storage, CREDENTIAL), authority);
      const binding = await read<StoredAuthBinding>(storage, BINDING);
      const session = unstamp(await read<Stamped<StoredSession>>(storage, SESSION), authority);
      if (credential?.subject !== scope.accountId || credential.serverOrigin !== scope.serverOrigin
          || binding?.replicaId !== scope.replicaId || binding.browserProfileId !== scope.browserProfileId
          || Number(binding.generation) !== scope.generation) return undefined;
      if (session) {
        await storage.set({ [REPORT_PROOFS]: stamp({ ...proofs, [proofKey(scope)]: session.sessionId }, authority.generation) });
      }
      return session?.sessionId;
    },
    async getOrCreateBinding(expectedGeneration: number): Promise<StoredAuthBinding> {
      await fence.assertWritable(expectedGeneration);
      const existing = await read<StoredAuthBinding>(storage, BINDING);
      if (existing) {
        await storage.set({ [BROWSER_PROFILE]: existing.browserProfileId });
        await fence.assertWritable(expectedGeneration);
        return existing;
      }
      const profile = await read<string>(storage, BROWSER_PROFILE);
      const created = Object.freeze({ replicaId: `replica-${crypto.randomUUID()}`,
        browserProfileId: profile ?? `profile-${crypto.randomUUID()}`, generation: '1' });
      await storage.set({ [BINDING]: created, [BROWSER_PROFILE]: created.browserProfileId });
      const current = await fence.read();
      if (current.revoked || current.generation !== expectedGeneration) {
        const written = await read<StoredAuthBinding>(storage, BINDING);
        if (written?.replicaId === created.replicaId) await storage.remove(BINDING);
        throw new AuthorityFencedError();
      }
      return created;
    },
    async bumpBindingGeneration(expectedGeneration: number): Promise<StoredAuthBinding> {
      await fence.assertWritable(expectedGeneration);
      const existing = await read<StoredAuthBinding>(storage, BINDING);
      if (!existing) throw new Error('binding_missing');
      const next = String(Number.parseInt(existing.generation, 10) + 1);
      if (!/^[1-9][0-9]*$/u.test(next)) throw new Error('generation_invalid');
      const updated = Object.freeze({ ...existing, generation: next });
      await storage.set({ [BINDING]: updated });
      return updated;
    },
    async replaceBindingForRebuild(expectedGeneration: number, oldReplicaId: string,
      next: StoredAuthBinding): Promise<void> {
      await fence.assertWritable(expectedGeneration);
      const existing = await read<StoredAuthBinding>(storage, BINDING);
      if (existing?.replicaId === next.replicaId) return;
      if (existing?.replicaId !== oldReplicaId || existing.browserProfileId !== next.browserProfileId) {
        throw new Error('stale_ref');
      }
      // One storage write publishes the new identity and invalidates its old Session.
      await storage.set({ [BINDING]: next, [SESSION]: null });
      try { await fence.assertWritable(expectedGeneration); }
      catch (error) {
        if ((await read<StoredAuthBinding>(storage, BINDING))?.replicaId === next.replicaId) {
          await storage.remove([BINDING, SESSION]);
        }
        throw error;
      }
    },
    loadBinding: () => read<StoredAuthBinding>(storage, BINDING),
    clearBinding: () => storage.remove([BINDING, SESSION]),
    async restoreBinding(value: StoredAuthBinding, expectedGeneration: number): Promise<void> {
      await fence.assertWritable(expectedGeneration);
      const profile = await read<string>(storage, BROWSER_PROFILE);
      const existing = await read<StoredAuthBinding>(storage, BINDING);
      if (profile !== value.browserProfileId || existing && existing.replicaId !== value.replicaId) throw new Error('binding_mismatch');
      await storage.set({ [BINDING]: value });
      await fence.assertWritable(expectedGeneration);
    },
    // Why the last forced sign-out happened (e.g. binding_mismatch). Written
    // before authority is cleared so every later status() — not just the first
    // caller — can explain the sign-out. Cleared on login and user logout.
    markSignOutReason: (code: string) => storage.set({ [SIGN_OUT_REASON]: { code } }),
    loadSignOutReason: async (): Promise<string | null> =>
      (await read<{ readonly code?: string }>(storage, SIGN_OUT_REASON))?.code ?? null,
    clearSignOutReason: () => storage.remove(SIGN_OUT_REASON),
    clearAuthority: () => storage.remove([TRANSACTION, CREDENTIAL, SESSION, BINDING, REPORT_PROOFS]),
    activateAuthority: fence.activate,
    revokeAuthority: fence.revoke,
    assertWritable: fence.assertWritable,
  });
}
async function read<T>(storage: StorageArea, key: string): Promise<T | null> { return ((await storage.get(key))[key] as T | undefined) ?? null; }
function array(value: string | string[]): string[] { return typeof value === 'string' ? [value] : value; }

type Stamped<T> = T & { readonly authorityGeneration?: number };

function stamp<T extends object>(value: T, generation: number): Stamped<T> {
  return { ...value, authorityGeneration: generation };
}

function unstamp<T extends object>(value: Stamped<T> | null, fence: { readonly generation: number; readonly revoked: boolean }): T | null {
  if (!value || fence.revoked) return null;
  const generation = typeof value.authorityGeneration === 'number' ? value.authorityGeneration : 0;
  if (generation !== fence.generation) return null;
  const { authorityGeneration: _generation, ...rest } = value;
  return rest as T;
}

async function reclaimIfFenced(
  storage: StorageArea, fence: ReturnType<typeof createAuthorityFence>, key: string, expected: number,
): Promise<void> {
  const after = await fence.read();
  if (!after.revoked && after.generation === expected) return;
  const written = await read<Stamped<object>>(storage, key);
  const stampedGeneration = typeof written?.authorityGeneration === 'number' ? written.authorityGeneration : 0;
  if (stampedGeneration === expected) await storage.remove(key);
  throw new AuthorityFencedError();
}

export { AUTHORITY_GENERATION_KEY, AuthorityFencedError };
