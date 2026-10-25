import type { ManagedCopy, ManagedLibrary } from './copy-identity.js';
import { readBoundedJson } from '../json-response.js';
import { SOURCE_CLOUD_PATH } from './cloud-client.js';
export type ManagedSlot = { kind: 'bookmark'; copy: ManagedCopy } | { kind: 'folder'; source: {
  site: string; identityVersion: number; sourceAccount: string; sourceCollectionId: string;
} };
export interface ManagedSaveCommand {
  commandId: string; replicaId: string; collectionId: string; parentId: string; parentRevision: string;
  slot: ManagedSlot; title: string; url: string | null;
  semanticClaim?: { ownerId: string; revision: number };
  adopt?: { nodeId: string; revision: string };
}
export interface ManagedNode { nodeId: string; parentId: string; title: string; url: string | null; revision: string; deleted?: boolean }
export interface ManagedSaveReceipt {
  version: 1; commandId: string; digest: string; key: string; node: ManagedNode; disposition: 'created' | 'reused' | 'detached' | 'suppressed';
}
export interface ManagedDestination { library: ManagedLibrary; command: ManagedSaveCommand }
export interface ManagedReference { library: ManagedLibrary; slot: ManagedSlot; nodeId: string }
export interface ManagedBinding { slot: ManagedSlot; collectionId: string; node: ManagedNode; state: 'active' | 'detached' | 'suppressed' }
export interface SemanticClaim { ownerId: string; revision: number }
export type SemanticClaimResult = { status: 'saved'; binding: ManagedBinding } | { status: 'claimed'; claim: SemanticClaim } | { status: 'waiting'; claim: SemanticClaim };
export type ManagedAction = 'managed.save' | 'managed.recover' | 'managed.list' | 'managed.lookup' | 'managed.manual' | 'managed.relocate' | 'managed.semantic.claim' | 'managed.semantic.release';
export function createManagedCopyClient(ports: { origin: string; fetch: typeof fetch; headers(): Promise<Record<string, string>>; assertCurrent(): Promise<void> }) {
  const url = new URL(SOURCE_CLOUD_PATH, ports.origin);
  async function request(action?: string, input?: unknown) {
    await ports.assertCurrent(); const headers = await ports.headers(); await ports.assertCurrent();
    const signal = AbortSignal.timeout(15000);
    const response = await ports.fetch(url, { method: action ? 'POST' : 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
      headers: { ...headers, Accept: 'application/json', ...(action ? { 'Content-Type': 'application/json' } : {}) },
      ...(action ? { body: JSON.stringify({ version: 1, action, input }) } : {}) }).catch(() => { throw new Error('sourceSyncPending'); });
    const data = await readBoundedJson(response, 256 * 1024, 'sourceSyncInvalid', { signal });
    if (!response.ok) {
      const code = (data as { error?: { code?: string } })?.error?.code;
      throw new Error(response.status === 429 || response.status >= 500 || code === 'source_replica_unavailable' ? 'sourceSyncPending' : code ?? 'sourceSyncInvalid');
    }
    await ports.assertCurrent(); return data;
  }
  return {
    async profile() { if ((await request() as { managedCopies?: number })?.managedCopies !== 1) throw new Error('sourceSyncUpgradeRequired'); },
    async semanticProfile() { const profile = await request() as { managedCopies?: number; managedSemantic?: number };
      if (profile?.managedCopies !== 1 || profile.managedSemantic !== 1) throw new Error('sourceSyncUpgradeRequired'); },
    async call<T>(action: ManagedAction, input: unknown): Promise<T> { return await request(action, input) as T; },
  };
}
