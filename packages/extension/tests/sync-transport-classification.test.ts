import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, test, vi } from 'vitest';
import { canonicalAuthoritativeEffectPageDigest } from '@know-n/colp/sync/canonical';
import { downloadAuthoritativeEffectPages } from '../src/effect-page-download.js';
import { httpFailure, snapshotFailure } from '../src/durable-sync-engine-errors.js';
import { readBoundedJson } from '../src/json-response.js';
import { fetchSyncEndpoints } from '../src/manifest-client.js';
import { createSyncSession, SessionRequestError } from '../src/session-client.js';
import { persistSnapshotOpenConflicts } from '../src/snapshot-conflict-recovery.js';
import { authorityCodeForStatus, classifyHttpStatus, ResponseStreamError, statusFailure } from '../src/sync-transport-failure.js';
import { classifySyncFailure, freezesPullApply, normalizeSyncFailureCode, persistentLocalSyncFailure,
  refreshesAuthority, refreshesReplicaIntegrity } from '../src/sync-failure-class.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import type { BuildConfig, StoredCredential } from '../src/types.js';
import { ack, emptyPullPage, json, problem, pullEventsPage, scope as engineScope, setup } from './durable-sync-engine-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

// Rule A / S2 (sync resilience audit): a transport fault must not become a semantic code at the throw site.
// HTTP >= 500 or 408 and a body that stopped arriving are transient; 401/403/404/410 renew authority; only a
// COMPLETE, parseable 2xx body that fails its checks is an integrity verdict.

const html = (status: number) => new Response('<html>gateway</html>', { status, headers: { 'Content-Type': 'text/html' } });
const reset = (status = 200, contentType = 'application/json') => new Response(new ReadableStream({
  start(controller) { controller.enqueue(new TextEncoder().encode('{"events":[')); controller.error(new TypeError('network error')); },
}), { status, headers: { 'Content-Type': contentType } });

describe('the status classifier', () => {
  test('sorts every status into transient, rate limited, authority or other', () => {
    for (const status of [500, 502, 503, 504, 408, 599]) assert.equal(classifyHttpStatus(status), 'transient', String(status));
    assert.equal(classifyHttpStatus(429), 'rate_limited');
    for (const status of [401, 403, 404, 410]) assert.equal(classifyHttpStatus(status), 'authority', String(status));
    for (const status of [200, 400, 405, 409, 413, 422]) assert.equal(classifyHttpStatus(status), 'other', String(status));
    assert.deepEqual([401, 403, 404, 410, 400].map(authorityCodeForStatus),
      ['authentication_required', 'insufficient_scope', 'resource_not_found', 'stale_replica', undefined]);
  });

  test('statusFailure keeps Retry-After and never turns a transient status into the caller code', () => {
    assert.equal(statusFailure(html(503), { other: 'x_invalid' }, 0).message, 'server_unavailable');
    assert.equal(statusFailure(html(408), { other: 'x_invalid' }, 0).message, 'server_unavailable');
    const limited = statusFailure(new Response('', { status: 429, headers: { 'Retry-After': '7' } }), { other: 'x' }, 0);
    assert.equal(limited.message, 'rate_limited');
    assert.equal((limited as { retryAfterMilliseconds?: number }).retryAfterMilliseconds, 7_000);
    assert.equal(statusFailure(html(404), { authority: 'effect_page_transport_unavailable', other: 'x' }, 0).message,
      'effect_page_transport_unavailable');
    assert.equal(statusFailure(html(404), { other: 'x' }, 0).message, 'resource_not_found');
    assert.equal(statusFailure(html(422), { other: 'x_invalid' }, 0).message, 'x_invalid');
  });

  test('httpFailure replaces a generic fallback with the denial the status implies and keeps a named code', () => {
    assert.equal(httpFailure(html(404), 'pull_failed', 0).message, 'resource_not_found');
    assert.equal(httpFailure(html(401), 'ack_failed', 0).message, 'authentication_required');
    assert.equal(httpFailure(html(404), 'replica_retired', 0).message, 'replica_retired');
    assert.equal(httpFailure(html(503), 'replica_retired', 0).message, 'server_unavailable');
    assert.equal(httpFailure(html(400), 'pull_failed', 0).message, 'pull_failed');
  });

  test('a stream error is a ResponseStreamError (network_unavailable); a bad complete body keeps the caller code', async () => {
    await assert.rejects(readBoundedJson(reset(), 1024, 'pull_invalid'), (error: unknown) => {
      assert.ok(error instanceof ResponseStreamError);
      assert.equal((error as ResponseStreamError).code, 'network_unavailable');
      return true;
    });
    await assert.rejects(readBoundedJson(new Response('{not json', { status: 200 }), 1024, 'pull_invalid'), /^Error: pull_invalid$/u);
    await assert.rejects(readBoundedJson(new Response('x'.repeat(2048), { status: 200 }), 1024, 'pull_invalid'), /^Error: pull_invalid$/u);
    await assert.rejects(readBoundedJson(new Response('{}', { status: 200, headers: { 'Content-Length': '99999' } }), 1024,
      'pull_invalid'), /^Error: pull_invalid$/u);
  });

  test('the registered policy matches the rule', () => {
    for (const code of ['server_unavailable', 'service_unavailable', 'internal_error', 'network_unavailable']) {
      assert.equal(classifySyncFailure(code)?.class, 'transient', code);
      assert.equal(freezesPullApply(code), false, code);
      assert.equal(persistentLocalSyncFailure(code), false, code);
    }
    for (const code of ['authentication_required', 'credential_revoked', 'insufficient_scope', 'resource_not_found',
      'stale_replica', 'session_invalid', 'effect_page_transport_unavailable']) {
      assert.equal(refreshesAuthority(code), true, code);
    }
    for (const code of ['replica_retired', 'origin_not_allowed', 'invalid_query', 'idempotency_key_reused', 'manifest_unavailable']) {
      assert.equal(persistentLocalSyncFailure(code), true, code);
    }
    assert.equal(refreshesReplicaIntegrity('effect_page_failed'), true, 'integrity codes stay integrity codes');
  });

  test('Snapshot-wrapped denials keep the policy of the code inside', () => {
    for (const [wrapped, inner] of [['snapshot_410_replica_retired', 'replica_retired'],
      ['snapshot_404_resource_not_found', 'resource_not_found'], ['snapshot_401_authentication_required', 'authentication_required'],
      ['snapshot_403_origin_not_allowed', 'origin_not_allowed'], ['snapshot_410_stale_replica', 'stale_replica'],
      ['snapshot_410_sync_cursor_expired', 'sync_cursor_expired'], ['snapshot_http_404', 'resource_not_found'],
      ['snapshot_http_401', 'authentication_required'], ['snapshot_http_408', 'server_unavailable']] as const) {
      assert.equal(normalizeSyncFailureCode(wrapped), inner, wrapped);
      assert.deepEqual(classifySyncFailure(wrapped), classifySyncFailure(inner), wrapped);
    }
    assert.equal(classifySyncFailure('snapshot_http_400'), undefined);
    assert.equal(classifySyncFailure('snapshot_409_idempotency_in_progress'), undefined);
  });

  test('snapshotFailure reports a gateway hiccup as server_unavailable and a denial with its endpoint wrapper', async () => {
    assert.equal(await snapshotFailure(html(503)), 'server_unavailable');
    assert.equal(await snapshotFailure(html(408)), 'server_unavailable');
    assert.equal(await snapshotFailure(html(404)), 'snapshot_http_404');
    assert.equal(await snapshotFailure(problem(410, 'replica_retired', {})), 'snapshot_410_replica_retired');
  });
});

describe('effect pages (B-01)', () => {
  const effectScope: SyncScope = { environment: 'development', serverId: 'server-download', serverOrigin: 'https://known.example',
    accountId: 'account-download', browserProfileId: 'profile-download', collectionId: 'collection-download',
    replicaId: 'replica-download', generation: 1 };
  const page = () => {
    const raw = { effectId: 'effect-1', pageNumber: 1, pageCount: 1, members: ['m1'], memberCount: 1,
      pageDigest: '', previousPageDigest: null };
    return { ...raw, pageDigest: canonicalAuthoritativeEffectPageDigest(raw) };
  };

  async function download(response: () => Response | Promise<Response>) {
    const store = createSyncStateStore({ indexedDB: new IDBFactory() });
    await store.registerScope({ ...effectScope, lifecycle: 'active', selectedRoots: [], checkpoint: { serverRevision: 'r1', cursor: 'c0' },
      lease: { leaseId: 'lease-download', expiresAt: Date.parse('2099-01-01T00:00:00Z') } });
    try {
      return await downloadAuthoritativeEffectPages({ scope: effectScope, store,
        refs: [{ effectId: 'effect-1', pageCount: 1, memberCount: 1 }],
        template: 'https://known.example/effects/{effectId}/pages/{pageNumber}', authority: 'https://known.example',
        headers: {}, remainingBytes: 1_000_000, fetch: (async () => response()) as typeof fetch, now: () => 1_000 });
    } finally { store.close(); }
  }
  const failure = async (response: () => Response | Promise<Response>) => {
    try { await download(response); return 'resolved'; } catch (error) { return (error as Error).message; }
  };

  test('a transient status is never an integrity code and never freezes Pull', async () => {
    for (const status of [500, 502, 503, 504, 408]) {
      const code = await failure(() => html(status));
      assert.equal(code, 'server_unavailable', String(status));
      assert.equal(freezesPullApply(code), false);
    }
  });

  test('401, 403, 404 and 410 renew authority instead of freezing the replica on an integrity code', async () => {
    for (const status of [401, 403, 404, 410]) {
      const code = await failure(() => html(status));
      assert.equal(code, 'effect_page_transport_unavailable', String(status));
      assert.equal(refreshesReplicaIntegrity(code), false, 'not a dead-end integrity freeze');
      assert.equal(refreshesAuthority(code), true);
      assert.equal(freezesPullApply(code), true, 'the freeze demands the Session refresh that cures it');
    }
  });

  test('a complete answer the client cannot use is still effect_page_failed', async () => {
    assert.equal(await failure(() => html(400)), 'effect_page_failed');
    assert.equal(await failure(() => html(413)), 'effect_page_failed');
  });

  test('a body that stops arriving is network_unavailable, not effect_page_invalid', async () => {
    const code = await failure(() => reset());
    assert.equal(code, 'network_unavailable');
    assert.equal(classifySyncFailure(code)?.class, 'transient');
  });

  test('a complete, valid page still downloads', async () => {
    assert.equal((await download(() => json(200, page()))).length, 1);
  });

  test('a complete page that fails its digest or shape is still an integrity verdict', async () => {
    assert.equal(await failure(() => json(200, { ...page(), pageDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:' })),
      'effect_page_invalid');
    assert.equal(await failure(() => json(200, { nonsense: true })), 'effect_page_invalid');
    assert.equal(await failure(() => new Response('{broken', { status: 200, headers: { 'Content-Type': 'application/json' } })),
      'effect_page_invalid');
    assert.equal(refreshesReplicaIntegrity('effect_page_invalid'), true);
  });
});

describe('the engine after a transport fault in a response (B-01, B-05, W2C-01/-03)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  async function folderDeleteFixture() {
    const fixture = await setup({ useRealPullApplier: true });
    const event = pullFixtures.subtreeEvent({ sequence: 5, collectionId: engineScope.collectionId, targetId: 'root-old',
      members: ['root-old'], paged: true });
    const eventPage: any = pullEventsPage([event], 'cursor-5'); const effectPages = eventPage.effectPages; delete eventPage.effectPages;
    fixture.chromeNodes.set('native-root', { id: 'native-root', parentId: '1', index: 0, title: 'Old root' });
    await fixture.store.putMapping(engineScope, { nativeId: '1', colpId: 'root-colp', rootNativeId: '1', nodeKind: 'folder',
      projection: { revision: 'revision-0', childrenRevision: 'children-0', digest: 'sha256:root-colp' } });
    const effect = { status: 503, calls: 0 };
    vi.stubGlobal('fetch', async (url: string) => {
      if (!String(url).includes('/effects/')) throw new Error(`unexpected ${url}`);
      effect.calls += 1;
      return effect.status === 200 ? json(200, effectPages[0]) : html(effect.status);
    });
    return { fixture, eventPage, effect };
  }

  test('one 503 on an effect page is retried by the next wake; the device is not frozen', async () => {
    const { fixture, eventPage, effect } = await folderDeleteFixture();
    try {
      fixture.pullResponses.push(json(200, eventPage));
      await fixture.engine.wake('manual');
      let engine = (await fixture.store.getEngineState(engineScope))!;
      assert.equal(engine.lastError, 'server_unavailable');
      assert.equal(engine.recoveryFrozen, false);
      assert.equal(engine.authorityRefreshRequired, false);
      assert.equal((await fixture.store.getScope(engineScope))!.lifecycle, 'active');
      effect.status = 200;
      fixture.pullResponses.push(json(200, structuredClone(eventPage))); fixture.ackResponses.push(json(200, ack('cursor-5')));
      fixture.clock.now += 120_000;
      await fixture.engine.wake('alarm');
      engine = (await fixture.store.getEngineState(engineScope))!;
      assert.equal(engine.lastError, undefined, 'recovered by itself, without a manual Retry');
      assert.equal((await fixture.store.getCursor(engineScope))?.cursor, 'cursor-5');
      assert.equal(fixture.ackRequests.length, 1);
    } finally { await fixture.store.close(); }
  });

  test('a 404 on an effect page renews the Session on the next wake and then completes', async () => {
    const { fixture, eventPage, effect } = await folderDeleteFixture();
    try {
      effect.status = 404;
      fixture.pullResponses.push(json(200, eventPage));
      await fixture.engine.wake('manual');
      const frozen = (await fixture.store.getEngineState(engineScope))!;
      assert.equal(frozen.lastError, 'effect_page_transport_unavailable');
      assert.equal(frozen.authorityRefreshRequired, true);
      effect.status = 200;
      fixture.pullResponses.push(json(200, structuredClone(eventPage))); fixture.ackResponses.push(json(200, ack('cursor-5')));
      fixture.clock.now += 120_000;
      await fixture.engine.wake('manual');
      assert.deepEqual(fixture.sessionForces.includes(true), true, 'the Session was renewed');
      assert.equal((await fixture.store.getCursor(engineScope))?.cursor, 'cursor-5');
    } finally { await fixture.store.close(); }
  });

  test('a connection reset in the middle of a Pull body does not stop the engine until a manual Retry', async () => {
    const fixture = await setup();
    try {
      fixture.pullResponses.push(reset());
      await fixture.engine.wake('alarm');
      const failed = (await fixture.store.getEngineState(engineScope))!;
      assert.equal(failed.lastError, 'network_unavailable');
      assert.equal(failed.phase, 'offline', 'a transport fault backs off; it does not stop the engine');
      fixture.pullResponses.push(json(200, emptyPullPage('cursor-0'))); fixture.ackResponses.push(json(200, ack('cursor-0')));
      fixture.clock.now = failed.notBefore + 1_000;
      await fixture.engine.wake('alarm');
      assert.equal(fixture.pullRequests.length, 2, 'the next alarm pulls again');
      assert.equal((await fixture.store.getEngineState(engineScope))!.lastError, undefined);
    } finally { await fixture.store.close(); }
  });

  test('a connection reset in the middle of an Ack body keeps the exact Ack for the next wake', async () => {
    const fixture = await setup();
    try {
      fixture.pullResponses.push(json(200, emptyPullPage('cursor-1'))); fixture.ackResponses.push(reset());
      await fixture.engine.wake('alarm');
      const failed = (await fixture.store.getEngineState(engineScope))!;
      assert.equal(failed.lastError, 'network_unavailable');
      assert.equal(failed.phase, 'offline');
      assert.ok(await fixture.store.getPendingAckIntent(engineScope));
      fixture.ackResponses.push(json(200, ack('cursor-1')));
      fixture.clock.now = failed.notBefore + 1_000;
      await fixture.engine.wake('alarm');
      assert.equal(await fixture.store.getPendingAckIntent(engineScope), null);
      assert.equal(fixture.ackRequests.length, 2);
      assert.deepEqual(fixture.ackRequests[1], fixture.ackRequests[0], 'the identical durable Ack is retried');
    } finally { await fixture.store.close(); }
  });

  test('a Pull denial that no body names still renews authority on the next wake (P2-3)', async () => {
    for (const [status, code] of [[404, 'resource_not_found'], [401, 'authentication_required']] as const) {
      const fixture = await setup();
      try {
        fixture.pullResponses.push(html(status));
        await fixture.engine.wake('alarm');
        let engine = (await fixture.store.getEngineState(engineScope))!;
        assert.equal(engine.lastError, code);
        assert.equal(engine.phase, 'offline', 'a denial backs off; it does not stop the engine');
        assert.equal(engine.recoveryFrozen, false, 'a denial of the cached Session is not a replica freeze');
        assert.equal(refreshesAuthority(code), true);
        assert.deepEqual(fixture.sessionForces, [false], 'the first wake reused the cached Session');
        fixture.pullResponses.push(json(200, emptyPullPage('cursor-0'))); fixture.ackResponses.push(json(200, ack('cursor-0')));
        fixture.clock.now = engine.notBefore + 1_000;
        await fixture.engine.wake('alarm');
        assert.ok(fixture.sessionForces.includes(true), `${code}: the next wake forced a Session refresh`);
        engine = (await fixture.store.getEngineState(engineScope))!;
        assert.equal(engine.lastError, undefined, `${code}: the renewed Session ends the failure`);
        assert.equal(engine.authorityRefreshRequired, false);
        assert.equal(engine.recoveryFrozen, false);
        assert.equal(engine.phase, 'sleeping');
      } finally { await fixture.store.close(); }
    }
  });
});

describe('Snapshot conflicts endpoint (W2C-08)', () => {
  const run = (fetcher: (url: string, init: RequestInit) => Promise<Response>) => persistSnapshotOpenConflicts({
    snapshotUrl: 'https://known.example/v1/snapshot', sessionId: 'session-1', snapshotId: 'snap-1', headers: {},
    fetch: fetcher, maxBytes: 64_000, persist: async () => undefined });
  const message = async (fetcher: (url: string, init: RequestInit) => Promise<Response>) => {
    try { await run(fetcher); return 'resolved'; } catch (error) { return (error as Error).message; }
  };

  test('a gateway hiccup is transient and a stream reset is network_unavailable, never an integrity freeze', async () => {
    assert.equal(await message(async () => html(503)), 'server_unavailable');
    assert.equal(await message(async () => new Response('', { status: 502 })), 'server_unavailable');
    assert.equal(await message(async () => problem(504, 'service_unavailable', {})), 'server_unavailable');
    assert.equal(await message(async () => reset()), 'network_unavailable');
    assert.equal(await message(async () => new Response('', { status: 429, headers: { 'Retry-After': '3' } })), 'rate_limited');
  });

  test('a denial keeps the code the server named, or the one its status implies', async () => {
    assert.equal(await message(async () => problem(410, 'replica_retired', {})), 'replica_retired');
    assert.equal(await message(async () => problem(409, 'snapshot_expired', {})), 'snapshot_expired');
    assert.equal(await message(async () => html(404)), 'resource_not_found');
    assert.equal(await message(async () => html(401)), 'authentication_required');
  });

  test('only a complete 200 with a bad shape is the integrity code, and the confirm POST follows the same rule', async () => {
    assert.equal(await message(async () => json(200, { nonsense: true })), 'snapshot_conflict_page_invalid');
    assert.equal(await message(async () => html(422)), 'snapshot_conflict_page_invalid');
    const open = { id: 'c1', collectionId: 'col', targetId: 'n1', type: 't', createdAt: '2026-01-01T00:00:00Z', status: 'open',
      allowedResolutions: ['server'], revision: 'r1' };
    const confirm = async (post: () => Response) => message(async (_url, init) => init.method === 'POST' ? post()
      : json(200, { snapshotId: 'snap-1', offset: 0, limit: 50, conflictCount: 1, conflicts: [open], nextOffset: null }));
    assert.equal(await confirm(() => html(503)), 'server_unavailable');
    assert.equal(await confirm(() => reset()), 'network_unavailable');
    assert.equal(await confirm(() => json(200, { confirmed: false })), 'snapshot_conflict_confirm_invalid');
  });
});

describe('manifest and Session mint', () => {
  const config = { manifestUrl: 'https://known.example/.well-known/colp' } as unknown as BuildConfig;

  test('the manifest answers a gateway hiccup with server_unavailable and a definitive 4xx with manifest_unavailable', async () => {
    const fetching = (response: Response) => fetchSyncEndpoints(config, (async () => response) as typeof fetch);
    await assert.rejects(fetching(html(503)), /^Error: server_unavailable$/u);
    await assert.rejects(fetching(html(408)), /^Error: server_unavailable$/u);
    await assert.rejects(fetching(html(404)), /^Error: manifest_unavailable$/u);
    await assert.rejects(fetching(new Response('', { status: 429, headers: { 'Retry-After': '2' } })), /^Error: rate_limited$/u);
    await assert.rejects(fetching(reset()), /network_unavailable$/u);
  });

  test('a Session mint refused by a gateway is transient, and an unnamed denial keeps its status meaning', async () => {
    const mint = async (response: Response) => {
      try {
        await createSyncSession({ endpoints: { syncSessions: 'https://known.example/v1/sessions' } as never,
          credential: { accessToken: 'token' } as StoredCredential, request: {}, fetch: (async () => response) as typeof fetch });
        return 'resolved';
      } catch (error) { return error instanceof SessionRequestError ? error.code : (error as Error).message; }
    };
    assert.equal(await mint(html(503)), 'server_unavailable');
    assert.equal(await mint(html(502)), 'server_unavailable');
    assert.equal(await mint(problem(503, 'service_unavailable', {})), 'server_unavailable');
    assert.equal(await mint(html(404)), 'resource_not_found');
    assert.equal(await mint(html(401)), 'credential_revoked');
    assert.equal(await mint(problem(410, 'replica_retired', {})), 'replica_retired');
    assert.equal(await mint(html(400)), 'session_failed');
  });
});
