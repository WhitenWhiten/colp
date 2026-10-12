import assert from 'node:assert/strict';
import { test } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createMetadataSyncPolicyStore } from '../src/metadata-sync-policy.js';
import { createPersonalSyncPolicyStore, PERSONAL_SYNC_PREFIX } from '../src/personal-sync-policy.js';
import { configurePersonalSyncTransport } from '../src/personal-sync-fetch.js';
import { metadataSyncFetch } from '../src/metadata-sync-fetch.js';
import { createNoteProductTransport } from '../src/note-product-transport.js';

test('opt-out during personal-policy admission prevents the actual note PATCH', async () => {
  const scope = { serverOrigin: 'https://known.test', accountId: 'owner', collectionId: 'one' };
  const storage = new MemoryStorageArea(), metadata = createMetadataSyncPolicyStore(storage);
  const personal = createPersonalSyncPolicyStore(storage);
  configurePersonalSyncTransport(personal);
  await personal.write(scope, 'enabled'); await metadata.write(scope, true);
  const consent = await metadata.capture(scope);
  let mutationGuardReached = false, revoked = false, sentWhileOff = false, patches = 0;
  const originalGet = storage.get.bind(storage);
  storage.get = async keys => {
    if (mutationGuardReached && typeof keys === 'string' && keys.startsWith(PERSONAL_SYNC_PREFIX) && !revoked) {
      revoked = true; await metadata.write(scope, false);
    }
    return originalGet(keys);
  };
  const fetcher: typeof fetch = async (input, init) => {
    if (init?.method === 'PATCH') {
      patches++; sentWhileOff = (await metadata.read(scope)).mode === 'local-only';
      assert.equal(JSON.parse(String(init.body)).value, 'private-note-probe');
      return new Response('{}', { headers: { 'Known-Annotation-Session': 'session' } });
    }
    return new Response(JSON.stringify(String(input).endsWith('/api/v1/session')
      ? { authenticated: true, csrfToken: 'csrf' } : { user: { id: scope.accountId }, session: { id: 'session' } }));
  };
  const transport = createNoteProductTransport({ ...scope, assertCurrent: consent,
    fetch: metadataSyncFetch(scope, fetcher, metadata) });
  await assert.rejects(transport.request('/api/v1/collections/one/annotations/note', { method: 'PATCH',
    body: { value: 'private-note-probe' }, command: { commandId: crypto.randomUUID(), revision: 'r1' },
    guard: async () => { mutationGuardReached = true; } }), /metadata_sync_disabled/);
  assert.equal(revoked, true); assert.equal(patches, 0); assert.equal(sentWhileOff, false);
});
test('reaffirming consent cannot revive a metadata fetch created under the old choice', async () => {
  const scope = { serverOrigin: 'https://known.test', accountId: 'reaffirmed-owner', collectionId: 'one' };
  const metadata = createMetadataSyncPolicyStore(new MemoryStorageArea());
  await metadata.write(scope, true);
  let calls = 0;
  const old = metadataSyncFetch(scope, async () => { calls++; return new Response('{}'); }, metadata);
  // Let the original capability finish acquisition before changing the choice.
  await metadata.capture(scope);
  await metadata.write(scope, false); await metadata.write(scope, true);
  await assert.rejects(old('https://known.test/api/v1/collections/one/annotations'), /metadata_sync_disabled/);
  assert.equal(calls, 0);
  const fresh = metadataSyncFetch(scope, async () => { calls++; return new Response('{}'); }, metadata);
  assert.equal((await fresh('https://known.test/api/v1/collections/one/annotations')).ok, true);
  assert.equal(calls, 1);
});
