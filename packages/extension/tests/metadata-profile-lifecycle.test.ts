import { expect, test } from 'vitest';
import { createCredentialStore, MemoryStorageArea } from '../src/credential-store.js';
import { sameMetadataAuthority, observeMetadata } from '../src/local-metadata-state.js';
import { scopeKey } from '../src/sync-state/scope-key.js';
import { scope } from './bookmark-event-queue-harness.js';

test('logout preserves the profile id while retiring the replica identity', async () => {
  const storage = new MemoryStorageArea(), store = createCredentialStore(storage);
  const first = await store.getOrCreateBinding((await store.activateAuthority()).generation);
  await store.revokeAuthority(); await store.clearAuthority();
  const next = await store.getOrCreateBinding((await store.activateAuthority()).generation);
  expect(next.browserProfileId).toBe(first.browserProfileId); expect(next.replicaId).not.toBe(first.replicaId);
});

test('legacy bindings seed durable profile identity before logout', async () => {
  const storage = new MemoryStorageArea(), store = createCredentialStore(storage);
  await storage.set({ 'known.auth.binding.v1': { replicaId: 'legacy', browserProfileId: 'legacy-profile', generation: '1' } });
  await store.getOrCreateBinding(0); await store.clearAuthority();
  expect((await store.getOrCreateBinding(0)).browserProfileId).toBe('legacy-profile');
});

test('already stranded rows accept the same collection after profile-id rotation but reject foreign authority', () => {
  const oldKey = scopeKey(scope), key = scopeKey({ ...scope, browserProfileId: 'rotated-profile', replicaId: 'new-replica' });
  expect(sameMetadataAuthority(oldKey, key)).toBe(true);
  const field = observeMetadata({ value: 'Local draft', version: 2, state: 'dirty', remote: { scopeKey: oldKey, resourceId: 'node', revision: 'r1', value: 'Before' } },
    { scopeKey: key, resourceId: 'node', revision: 'r2', value: 'Cloud change' }, (a, b) => a === b);
  expect(field.remote?.scopeKey).toBe(key); expect(field.value).toBe('Local draft');
  for (const other of [{ ...scope, accountId: 'foreign' }, { ...scope, collectionId: 'foreign' }, { ...scope, serverOrigin: 'https://foreign.test' }])
    expect(sameMetadataAuthority(oldKey, scopeKey(other))).toBe(false);
});
