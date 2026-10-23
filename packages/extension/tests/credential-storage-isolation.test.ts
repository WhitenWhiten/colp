import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, test, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryStorageArea } from '../src/credential-store.js';

/**
 * Secrets live in session storage; durable identity stays in local storage.
 *
 * A session cookie is a bearer credential, so it moved out of
 * `chrome.storage.local` into `chrome.storage.session` with the access level
 * pinned to `TRUSTED_CONTEXTS`. That excludes CONTENT SCRIPTS; it does not
 * exclude the extension's own pages, which Chromium also counts as trusted
 * contexts, and these tests do not claim otherwise.
 *
 * The identity keys (`binding`, authority generation) must NOT be session
 * scoped. The scope key and every durable row derived from it include
 * `replicaId`, so clearing the identity on browser exit orphans the previous
 * incarnation's queue, mappings and archives and mints a new server replica on
 * every restart.
 */

const SECRET_KEYS = ['known.auth.credential.v1', 'known.auth.session.v1',
  'known.auth.transaction.v1'];
const IDENTITY_KEYS = ['known.auth.binding.v1', 'known.auth.authority-generation.v1'];
const CREDENTIAL_KEYS = [...SECRET_KEYS, ...IDENTITY_KEYS];

let local: MemoryStorageArea;
let session: MemoryStorageArea & { setAccessLevel: (options: { accessLevel: string }) => Promise<void> };
let accessLevels: string[];

beforeEach(() => {
  vi.resetModules();
  local = new MemoryStorageArea();
  session = new MemoryStorageArea() as typeof session;
  accessLevels = [];
  session.setAccessLevel = vi.fn(async (options: { accessLevel: string }) => { accessLevels.push(options.accessLevel); });
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('chrome', {
    storage: { local, session },
    runtime: { id: 'pplpnpegpnghcddhmpgkbfkdfadjiaen' },
  });
});

describe('credential storage is not readable from extension pages', () => {
  test('the credential area is pinned to trusted contexts before the first read', async () => {
    const runtime = await import('../src/sw/runtime.js');
    await runtime.store.saveCredential({
      accessToken: 'session-cookie-value', tokenType: 'Bearer', subject: 'subject-1',
      accountLabel: 'Subject', expiresAt: Date.now() + 3_600_000, scope: [], serverOrigin: 'https://known.example',
      issuer: 'https://issuer.example', audience: 'known-extension', clientId: 'client-1',
    } as never);
    assert.deepEqual(accessLevels, ['TRUSTED_CONTEXTS'],
      'the access level must be set exactly once, before any credential is written');
    // The pin is applied through the same area the store reads and writes.
    assert.equal((session.setAccessLevel as unknown as { mock: { calls: unknown[] } }).mock.calls.length, 1);
  });

  test('no credential material is written to local storage', async () => {
    const runtime = await import('../src/sw/runtime.js');
    await runtime.store.saveCredential({
      accessToken: 'session-cookie-value', tokenType: 'Bearer', subject: 'subject-1',
      accountLabel: 'Subject', expiresAt: Date.now() + 3_600_000, scope: [], serverOrigin: 'https://known.example',
      issuer: 'https://issuer.example', audience: 'known-extension', clientId: 'client-1',
    } as never);
    const inLocal = await local.get(null);
    for (const key of CREDENTIAL_KEYS) {
      assert.equal(key in inLocal, false, `${key} must not be in chrome.storage.local`);
    }
    assert.equal(JSON.stringify(inLocal).includes('session-cookie-value'), false,
      'the access token must never reach local storage');
    assert.equal((inLocal['known.auth.identity.v1'] as { subject?: string })?.subject, 'subject-1',
      'the non-secret account pin must survive a browser-session reset');
    const inSession = await session.get(null);
    assert.equal(inSession['known.auth.identity.v1'], undefined);
    assert.equal(JSON.stringify(inSession).includes('session-cookie-value'), true,
      'the credential is expected in the session area');
  });

  test('the durable replica identity stays in local storage across a restart', async () => {
    // Identity keys are not secret and must outlive the browser session. If they
    // were session-scoped, this restart would mint a new replicaId and every
    // scope-keyed row would be orphaned.
    const first = await import('../src/sw/runtime.js');
    const binding = await first.store.getOrCreateBinding(0);
    const inSession = await session.get(null);
    for (const key of IDENTITY_KEYS) {
      assert.equal(key in inSession, false, `${key} must not be session-scoped`);
    }
    const persisted = await local.get(null);
    assert.equal((persisted['known.auth.binding.v1'] as { replicaId?: string } | undefined)?.replicaId,
      binding.replicaId, 'the binding must be readable from local storage');

    // Restart: session storage is cleared, local storage is not.
    vi.resetModules();
    session = new MemoryStorageArea() as typeof session;
    session.setAccessLevel = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', {
      storage: { local, session },
      runtime: { id: 'pplpnpegpnghcddhmpgkbfkdfadjiaen' },
    });
    const second = await import('../src/sw/runtime.js');
    assert.equal((await second.store.loadCredential()), null, 'secrets do not survive a restart');
    assert.equal((await second.store.getOrCreateBinding(0)).replicaId, binding.replicaId,
      'the replica identity must survive a restart');
  });

  test('a profile upgraded from the pre-split layout has its SECRETS removed', async () => {
    // Before the split the whole store lived in `local`, so the plaintext bearer
    // is still at the old address. Nothing reads it, but it must not stay there.
    //
    // This test used to assert that the IDENTITY keys were cleared here too, and
    // that expectation was a bug: after the split `binding` and
    // authority-generation are STILL routed to local, so clearing them deleted
    // live state on every service-worker boot — the replica identity was re-minted
    // (orphaning every queue row, mapping and archive) and the authority fence
    // reset, so a revoked credential became readable again. Secrets are legacy;
    // identity is live. Only the former may be purged.
    await local.set({
      'known.auth.credential.v1': { accessToken: 'legacy-plaintext-bearer' },
      'known.auth.session.v1': { id: 'legacy-session' },
      'known.auth.binding.v1': { replicaId: 'replica-legacy', browserProfileId: 'profile-legacy', generation: '1' },
      'known.auth.authority-generation.v1': { generation: 1, revoked: false },
    });
    const { purgeLegacyLocalAuthority } = await import('../src/sw/credential-storage.js');
    await purgeLegacyLocalAuthority(local);
    const remaining = await local.get(null);
    assert.equal(JSON.stringify(remaining).includes('legacy-plaintext-bearer'), false,
      'the pre-split bearer must not remain in local storage');
    for (const key of SECRET_KEYS) {
      assert.equal(key in remaining, false, `${key} must be cleared from local storage`);
    }
    for (const key of IDENTITY_KEYS) {
      assert.equal(key in remaining, true,
        `${key} is live local state and must survive the boot purge`);
    }
  });

  test('the boot purge leaves the live local identity and fence in place', async () => {
    // REGRESSION, found by an independent reviewer and reproduced here. The purge
    // ran on EVERY worker boot against keys the split store still routes to local,
    // so it destroyed live state at every wake rather than once on upgrade. Two
    // harms: the replica identity is re-minted (scopeKey changes, orphaning every
    // queue row, mapping and archive) and the authority fence resets to
    // generation 0 / revoked false, so a credential fenced out by revokeAuthority
    // becomes readable and writable again.
    //
    // Asserted at the storage layer because that is where the damage happened: the
    // keys must simply still be there after a boot purge.
    const { createCredentialStore } = await import('../src/credential-store.js');
    const { createSplitCredentialStorage, purgeLegacyLocalAuthority } =
      await import('../src/sw/credential-storage.js');
    const store = createCredentialStore(createSplitCredentialStorage(local));
    await store.activateAuthority();
    const generation = (await store.fence.read()).generation;
    const binding = await store.getOrCreateBinding(generation);

    const persistedBefore = await local.get(IDENTITY_KEYS) as Record<string, unknown>;
    assert.equal(persistedBefore['known.auth.binding.v1'] !== undefined, true,
      'the live identity is persisted to local before the purge');

    // Exactly what service-worker.ts does on every wake.
    await purgeLegacyLocalAuthority(local);

    const persistedAfter = await local.get(IDENTITY_KEYS) as Record<string, unknown>;
    assert.notEqual(persistedAfter['known.auth.binding.v1'], undefined,
      'the boot purge must not delete the live replica identity');
    assert.equal(
      (persistedAfter['known.auth.binding.v1'] as { replicaId?: string }).replicaId,
      binding.replicaId, 'the persisted replicaId must be unchanged');
    assert.notEqual(persistedAfter['known.auth.authority-generation.v1'], undefined,
      'the boot purge must not delete the live authority fence');
    // A revoked fence written through the store must also survive, since the key
    // it lives under is the one that was being deleted.
    await store.fence.revoke();
    const revokedPersisted = await local.get('known.auth.authority-generation.v1') as
      { generation?: number; revoked?: boolean } | undefined;
    await purgeLegacyLocalAuthority(local);
    const revokedAfter = await local.get('known.auth.authority-generation.v1') as
      { generation?: number; revoked?: boolean } | undefined;
    assert.deepEqual(revokedAfter, revokedPersisted,
      'a revocation must not be lifted or rewritten by a boot purge');
  });

  test('the service worker refuses to use an area it cannot pin', async () => {
    // Without `setAccessLevel` the area would stay readable from pages, so the
    // worker must fail closed rather than silently keep the old exposure.
    vi.resetModules();
    const area = new MemoryStorageArea();
    vi.stubGlobal('chrome', { storage: { local, session: area }, runtime: { id: 'x' } });
    const runtime = await import('../src/sw/runtime.js');
    await assert.rejects(
      () => runtime.store.loadCredential(),
      /credential_storage_requires_set_access_level/u,
    );
  });

  test('the credential area is session storage, not local storage', () => {
    // Pin the source of truth for the decision above: a future edit that moves
    // the store back to `chrome.storage.local` must fail here.
    const source = readFileSync(new URL('../src/sw/runtime.ts', import.meta.url), 'utf8');
    assert.match(source, /createCredentialStore\(createSplitCredentialStorage\(chrome\.storage\.local\)\)/u);
    assert.match(source, /chrome\.storage\.session/u);
    assert.doesNotMatch(source, /createCredentialStore\(chrome\.storage\.local\)/u);
    const split = readFileSync(new URL('../src/sw/credential-storage.ts', import.meta.url), 'utf8');
    for (const key of SECRET_KEYS) {
      assert.match(split, new RegExp(key.replaceAll('.', '\\.'), 'u'),
        `${key} must be classified as a session key`);
    }
  });
});
