import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  AUTHORITY_GENERATION_KEY, AuthorityFencedError, createExtensionWorkCoordinator,
} from '../src/authority-fence.js';
import { MemoryStorageArea, createCredentialStore } from '../src/credential-store.js';
import type { StoredCredential, StoredSession } from '../src/types.js';
import { readServiceWorkerGraph } from './service-worker-graph.js';

const NOW = 1_785_139_200_000;

function credential(generationLabel = 'a'): StoredCredential {
  return {
    accessToken: `token-${generationLabel}`, tokenType: 'Bearer', expiresAt: NOW + 300_000,
    scope: ['known.sync'], issuer: 'https://known.example', audience: 'https://known.example',
    clientId: 'extension', serverOrigin: 'https://known.example', subject: `account-${generationLabel}`,
  };
}

function session(generationLabel = 'a'): StoredSession {
  return {
    sessionId: `session-${generationLabel}`, expiresAt: new Date(NOW + 300_000).toISOString(),
    credentialAuthorityDigest: 'a'.repeat(64), scope: 'collection',
    collection: { collectionId: 'collection-1', serverCursor: 'cursor-1', serverRevision: 'revision-1' },
    snapshotRequired: false,
    replicaLease: { leaseId: 'lease-1', generation: '1', state: 'active',
      expiresAt: new Date(NOW + 600_000).toISOString() },
  };
}

describe('SYNC-Q-015 authority generation fence', () => {
  test('profile-owned native work survives queued account switches without reading account storage', async () => {
    const storage = new MemoryStorageArea(), store = createCredentialStore(storage);
    const coordinator = createExtensionWorkCoordinator(store.fence);
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let signal: AbortSignal | undefined;
    const held = coordinator.run('native-bookmark', async context => {
      signal = context.signal; entered(); await new Promise<void>(resolve => { release = resolve; });
    });
    await started;
    const queued = coordinator.run('native-bookmark', async () => 'native');
    await store.revokeAuthority(); await store.activateAuthority();
    storage.get = async () => { throw new Error('account_storage_unavailable'); };
    release(); await held;
    assert.equal(await queued, 'native'); assert.equal(signal?.aborted, false);
    assert.equal(await coordinator.run('native-bookmark', async () => 'offline'), 'offline');
  });
  test('signed-out local bookmark work remains isolated from revoked sync lanes and later login generations', async () => {
    const store = createCredentialStore(new MemoryStorageArea());
    const coordinator = createExtensionWorkCoordinator(store.fence);
    await store.revokeAuthority();
    assert.equal(await coordinator.run('local-bookmark', async () => 'local'), 'local');
    await assert.rejects(() => coordinator.run('bookmark', async () => undefined), AuthorityFencedError);
    await assert.rejects(() => coordinator.run('engine', async () => undefined), AuthorityFencedError);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = coordinator.run('local-bookmark', async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
    });
    await started;
    let mutated = false;
    const queued = coordinator.run('local-bookmark', async () => { mutated = true; });
    const rejected = assert.rejects(() => queued, AuthorityFencedError);
    await store.activateAuthority();
    release();
    await held; await rejected;
    assert.equal(mutated, false);
  });
  test('local classification uses the user\'s own provider, so sign-out and sign-in neither fence nor abort it', async () => {
    const store = createCredentialStore(new MemoryStorageArea());
    const coordinator = createExtensionWorkCoordinator(store.fence);
    await store.revokeAuthority();
    await assert.rejects(() => coordinator.run('classification', async () => undefined), AuthorityFencedError);
    assert.equal(await coordinator.run('local-classification', async () => 'filed'), 'filed');
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let signal: AbortSignal | undefined;
    const held = coordinator.run('local-classification', async context => {
      signal = context.signal; entered(); await new Promise<void>(resolve => { release = resolve; });
    });
    await started;
    const queued = coordinator.run('local-classification', async () => 'queued');
    await store.activateAuthority();
    release();
    await held;
    assert.equal(await queued, 'queued');
    assert.equal(signal?.aborted, false);
  });

  test('missing generation record is writable generation 0 and clearAuthority keeps the marker', async () => {
    const storage = new MemoryStorageArea();
    const store = createCredentialStore(storage);
    assert.deepEqual(await store.fence.read(), { generation: 0, revoked: false });
    await store.saveCredential(credential());
    await store.revokeAuthority();
    await store.clearAuthority();
    assert.equal(await store.loadCredential(), null);
    assert.equal((await storage.get(AUTHORITY_GENERATION_KEY))[AUTHORITY_GENERATION_KEY] !== undefined, true);
    assert.equal((await store.fence.read()).revoked, true);
    const restarted = createCredentialStore(storage);
    assert.equal((await restarted.fence.read()).revoked, true);
    await assert.rejects(() => restarted.saveCredential(credential()), (error: unknown) => (
      error instanceof AuthorityFencedError && error.code === 'authority_fenced'
    ));
  });

  test('save after revoke does not resurrect and load hides leftover blobs', async () => {
    const store = createCredentialStore(new MemoryStorageArea());
    await store.saveCredential(credential());
    await store.saveSession(session());
    await store.revokeAuthority();
    await assert.rejects(() => store.saveSession(session()), (error: unknown) => error instanceof AuthorityFencedError);
    await assert.rejects(() => store.saveCredential(credential()), (error: unknown) => error instanceof AuthorityFencedError);
    assert.equal(await store.loadCredential(), null);
    assert.equal(await store.loadSession(), null);
  });

  for (const delayMs of [1_000, 5_000, 15_000]) {
    test(`logout at simulated ${delayMs}ms then delayed session resolve does not resurrect`, async () => {
      const store = createCredentialStore(new MemoryStorageArea());
      await store.activateAuthority();
      await store.saveCredential(credential());
      let release!: (value: StoredSession) => void;
      const delayed = new Promise<StoredSession>((resolveSession) => { release = resolveSession; });
      const expected = (await store.fence.read()).generation;
      const write = delayed.then((value) => store.saveSession(value, expected));
      await store.revokeAuthority();
      release(session());
      await assert.rejects(write, (error: unknown) => error instanceof AuthorityFencedError);
      assert.equal(await store.loadSession(), null);
      assert.equal(await store.loadCredential(), null);
    });
  }

  test('delayed credential refresh after revoke cannot resurrect', async () => {
    const store = createCredentialStore(new MemoryStorageArea());
    await store.activateAuthority();
    await store.saveCredential(credential('a'));
    let release!: (value: StoredCredential) => void;
    const delayed = new Promise<StoredCredential>((resolveCredential) => { release = resolveCredential; });
    const expected = (await store.fence.read()).generation;
    const write = delayed.then((value) => store.saveCredential(value, expected));
    await store.revokeAuthority();
    release(credential('stale'));
    await assert.rejects(write, (error: unknown) => error instanceof AuthorityFencedError);
    assert.equal(await store.loadCredential(), null);
  });

  test('delayed binding creation is fenced by logout generation', async () => {
    const backing = new MemoryStorageArea();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const storage = {
      get: (keys: string | string[] | null) => backing.get(keys),
      set: async (items: Record<string, unknown>) => {
        if ('known.auth.binding.v1' in items) await gate;
        await backing.set(items);
      },
      remove: (keys: string | string[]) => backing.remove(keys),
    };
    const store = createCredentialStore(storage);
    const live = await store.fence.activate();
    const pending = store.getOrCreateBinding(live.generation);
    await store.revokeAuthority();
    release();
    await assert.rejects(pending, (error: unknown) => error instanceof AuthorityFencedError);
    assert.equal(await store.loadBinding(), null);
  });

  test('account A delayed write cannot stamp account B generation', async () => {
    const store = createCredentialStore(new MemoryStorageArea());
    const first = await store.activateAuthority();
    await store.saveCredential(credential('a'), first.generation);
    let release!: (value: StoredSession) => void;
    const delayed = new Promise<StoredSession>((resolveSession) => { release = resolveSession; });
    const staleWrite = delayed.then((value) => store.saveSession(value, first.generation));
    await store.revokeAuthority();
    const second = await store.activateAuthority();
    await store.saveCredential(credential('b'), second.generation);
    release(session('a'));
    await assert.rejects(staleWrite, (error: unknown) => error instanceof AuthorityFencedError);
    assert.equal((await store.loadCredential())?.subject, 'account-b');
    assert.equal(await store.loadSession(), null);
  });

  test('worker restart fence from storage still blocks a live writer that ignored AbortSignal', async () => {
    const storage = new MemoryStorageArea();
    const live = createCredentialStore(storage);
    const started = await live.activateAuthority();
    await live.saveCredential(credential(), started.generation);
    const restarted = createCredentialStore(storage);
    await restarted.revokeAuthority();
    await assert.rejects(() => live.saveSession(session(), started.generation), (error: unknown) => (
      error instanceof AuthorityFencedError
    ));
    assert.equal(await restarted.loadCredential(), null);
    assert.equal(await live.loadCredential(), null);
  });

  test('coordinator tracks in-flight work and drain does not increment generation twice', async () => {
    const store = createCredentialStore(new MemoryStorageArea());
    const coordinator = createExtensionWorkCoordinator(store.fence);
    await store.activateAuthority();
    let release!: () => void;
    const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked; });
    const task = coordinator.run('session', async (context) => {
      await blocked;
      await store.saveSession(session(), context.generation);
    });
    assert.equal(coordinator.hasInFlight('session'), true);
    await store.revokeAuthority();
    release();
    await coordinator.drain();
    await assert.rejects(task, (error: unknown) => error instanceof AuthorityFencedError);
    assert.equal((await store.fence.read()).generation, 2);
    assert.equal(coordinator.hasInFlight(), false);
    await store.activateAuthority();
    assert.equal(await coordinator.run('auth', async () => 'login-ok'), 'login-ok');
  });

  test('login after logout can write a new generation while queued writes stay fenced', async () => {
    const store = createCredentialStore(new MemoryStorageArea());
    const coordinator = createExtensionWorkCoordinator(store.fence);
    await store.activateAuthority();
    let release!: () => void;
    const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked; });
    const inflight = coordinator.run('engine', async (context) => {
      await blocked;
      await store.saveSession(session('stale'), context.generation);
      return 'inflight';
    });
    const queued = coordinator.run('engine', async (context) => {
      await store.saveSession(session('queued'), context.generation);
      return 'stale-engine';
    });
    await store.revokeAuthority();
    await coordinator.run('auth', async () => store.activateAuthority());
    const login = await store.fence.capture();
    await store.saveCredential(credential('b'), login.generation);
    release();
    await assert.rejects(inflight, (error: unknown) => error instanceof AuthorityFencedError);
    await assert.rejects(queued, (error: unknown) => error instanceof AuthorityFencedError);
    assert.equal((await store.loadCredential())?.subject, 'account-b');
    assert.equal(await store.loadSession(), null);
    assert.equal((await store.fence.read()).revoked, false);
  });
});

describe('SYNC-Q-015 service worker logout barrier', () => {
  test('replaces the 5s logout Promise.race with generation fence and drain', async () => {
    const worker = await readServiceWorkerGraph();
    const fence = await readFile(resolve('src/authority-fence.ts'), 'utf8');
    const credentials = await readFile(resolve('src/credential-store.ts'), 'utf8');
    assert.match(worker, /createExtensionWorkCoordinator/);
    assert.match(worker, /workCoordinator\.drain\('auth'\)/);
    assert.match(worker, /auth\.logout\(\)/);
    assert.doesNotMatch(worker, /setTimeout\(settle, 5_000\)/);
    assert.doesNotMatch(worker, /Promise\.race\(\[\s*syncEngineWakeQueue/);
    assert.doesNotMatch(worker, /sessionAuthorityQueue|syncEngineWakeQueue|bookmarkEventRequestQueue|authorityRequestPending|syncEngineWakePending/);
    assert.doesNotMatch(worker, /requestQueue = /);
    assert.match(fence, /authority_fenced/);
    assert.match(credentials, /AUTHORITY_GENERATION_KEY/);
    assert.match(credentials, /clearAuthority: \(\) => storage\.remove\(\[TRANSACTION, CREDENTIAL, SESSION, BINDING\]\)/);
  });

  test('LANE-CAPTURE-ENGINE-RACE: engine and bookmark work overlap by design', async () => {
    // The audit recorded this as a structural gap rather than a reproduced
    // failure: the coordinator serializes work WITHIN a lane, and the switch is
    // the only thing that orders ACROSS lanes, so a Pull (engine lane) and a
    // bookmark capture (bookmark lane) can rewrite the same tree at once. Nothing
    // in the lanes prevents that overlap; what keeps both writes honest is the
    // optimistic concurrency below them (`baseRevision` / position validation),
    // which turns a lost update into a rejected write rather than a corrupt tree.
    //
    // This pins the FIRST half of that claim — the overlap is real — so that a
    // later change which assumes mutual exclusion has to confront it. It does not
    // claim the overlap is harmless; it records that ordering across lanes is not
    // what makes it safe.
    const store = createCredentialStore(new MemoryStorageArea());
    const coordinator = createExtensionWorkCoordinator(store.fence);
    await store.activateAuthority();

    const events: string[] = [];
    let releaseEngine!: () => void;
    const engineHolds = new Promise<void>((resolveHold) => { releaseEngine = resolveHold; });
    const engine = coordinator.run('engine', async () => {
      events.push('engine:start');
      await engineHolds;
      events.push('engine:end');
      return 'pull-applied';
    });
    // Let the engine lane reach its await before the bookmark lane starts.
    await Promise.resolve();
    const capture = coordinator.run('bookmark', async () => {
      events.push('bookmark:start');
      return 'capture-staged';
    });

    // The bookmark lane completes while the engine lane is still inside its
    // critical section: two lanes are in flight against the same tree.
    assert.equal(await capture, 'capture-staged');
    assert.equal(coordinator.hasInFlight('engine'), true);
    assert.equal(coordinator.hasInFlight('bookmark'), false);
    assert.deepEqual(events, ['engine:start', 'bookmark:start']);

    releaseEngine();
    assert.equal(await engine, 'pull-applied');
    assert.deepEqual(events, ['engine:start', 'bookmark:start', 'engine:end']);

    // And within one lane the ordering IS enforced, which is why the overlap
    // above is the cross-lane case and not a general lack of serialization.
    const ordered: string[] = [];
    const first = coordinator.run('bookmark', async () => { ordered.push('first'); return 1; });
    const second = coordinator.run('bookmark', async () => { ordered.push('second'); return 2; });
    assert.deepEqual([await first, await second], [1, 2]);
    assert.deepEqual(ordered, ['first', 'second']);
  });
});
