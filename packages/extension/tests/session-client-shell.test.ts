import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'vitest';
import { colpCredentialHeaders } from '../src/auth-client.js';
import { parseBuildConfig } from '../src/config.js';
import { readBoundedJson } from '../src/json-response.js';
import { discoverSyncEndpoints } from '../src/manifest-client.js';
import { classifySessionAuthority, createSessionAuthorityQueue, createSyncSession,
  credentialAuthorityDigest, sessionMatchesCredentialAuthority, parseSyncSessionResult,
  retainSessionAfterTransientRenewalFailure, retryStaleReplicaSession,
  shouldForceSessionRefresh, syncSessionNeedsRenewal } from '../src/session-client.js';
import type { BuildConfig, StoredCredential, StoredSession } from '../src/types.js';

const EXTENSION_ID = 'pplpnpegpnghcddhmpgkbfkdfadjiaen';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const NOW = 1_785_139_200_000;
const COOKIE_VALUE = 'baSessionToken.dGVzdHNpZ25hdHVyZQ==';
const sessionAuthorityContract = JSON.parse(readFileSync(new URL(
  '../../server/tests/fixtures/phase3/session-authority-contract.json', import.meta.url), 'utf8')) as {
  successfulLeaseStates: string[]; authorities: Record<'bootstrap' | 'active' | 'recovery', {
    snapshotRequired: boolean; scopeCeiling: string;
  }>;
};

function fixtureCredential(value: BuildConfig, now: number): StoredCredential {
  return { accessToken: COOKIE_VALUE, tokenType: 'Bearer', expiresAt: now + 300_000,
    scope: ['known.sync'], issuer: value.issuer, audience: value.audience, clientId: value.clientId,
    serverOrigin: value.serverOrigin, subject: 'auth-user-fixture',
    accountLabel: 'p3-27-extension@example.test' };
}

function fixtureSession(now: number): StoredSession {
  return { sessionId: 'session-fixture', expiresAt: new Date(now + 300_000).toISOString(),
    credentialAuthorityDigest: 'a'.repeat(64), scope: 'collection',
    collection: { collectionId: 'collection-fixture', serverCursor: 'cursor-fixture',
      serverRevision: 'revision-fixture' }, snapshotRequired: false,
    replicaLease: { leaseId: 'lease-fixture', generation: '1', state: 'active',
      expiresAt: new Date(now + 600_000).toISOString() } };
}

function fixtureSessionResult(now: number) {
  const { snapshotRequired: _snapshotRequired,
    credentialAuthorityDigest: _credentialAuthorityDigest, ...stored } = fixtureSession(now);
  return { ...stored, serverTime: new Date(now).toISOString(), clockSkewMilliseconds: 0,
    acceptedProtocolVersion: '0.2', maxBatchOperations: 1, tombstoneRetentionSeconds: 86400,
    collection: { ...stored.collection, snapshotRequired: true }, replicaLease: { ...stored.replicaLease,
      lastSeenAt: new Date(now).toISOString(), acknowledgedCursor: null },
    conversionPolicy: { alias: 'duplicate', separator: 'preserve_remote', unknownExtensions: 'sidecar' } };
}

function fixtureSessionRequest() {
  return { protocolVersion: '0.2', replica: { replicaId: 'replica-fixture', name: 'Chromium',
    kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
    capabilities: { read: true, write: true, events: true, separator: false, alias: false,
      annotations: 'sidecar', maxBatchOperations: 1 }, binding: { browserProfileId: 'profile-fixture',
      mountMode: 'mounted-folder', mountNativeId: 'pending-selection', generation: '1' } },
    scope: 'collection', collection: { collectionId: 'collection-fixture', lastCursor: null,
      lastRevision: null, bootstrapMode: 'download' }, clientTime: new Date().toISOString() };
}

function config() {
  return parseBuildConfig({ environment: 'production', extensionId: EXTENSION_ID,
    serverOrigin: 'https://known.example',
    manifestUrl: 'https://known.example/.well-known/collection-protocol',
    issuer: 'https://known.example/',
    authorizationEndpoint: 'https://known.example/api/v1/auth/sign-in/email',
    tokenEndpoint: 'https://known.example/api/v1/auth/get-session',
    jwksUri: 'https://known.example/.well-known/jwks.json',
    revocationEndpoint: 'https://known.example/api/v1/auth/sign-out',
    clientId: 'known-chromium-extension', audience: 'known-sync-api',
    scopes: ['openid', 'offline_access', 'known.sync'], allowedAlgorithms: ['RS256'],
    refreshBeforeExpirySeconds: 60 });
}

function manifest() {
  const origin = 'https://known.example';
  return { protocol: 'https://know-n.com/colp/spec/0.2', protocolVersions: ['0.1', '0.2'],
    syncEffectPages: `${origin}/v1/effects/{effectId}/pages/{pageNumber}`,
    serverId: `${origin}/`, serverUuid: '019f97ff-1111-7111-8111-111111111111', title: 'Known',
    mounts: [{ id: 'known-sync-entry', baseUrl: `${origin}/sync/`, profiles: ['core'], endpoints: {
      syncSessions: `${origin}/v1/session`, syncSnapshot: `${origin}/v1/snapshot`,
      syncPush: `${origin}/v1/push`, syncPull: `${origin}/v1/pull`, syncAck: `${origin}/v1/ack`,
      syncConflict: `${origin}/v1/conflicts/{conflictId}` },
    features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] },
      sync: { multiCollectionSessions: false } },
    auth: { anonymousRead: false, apiKeys: false, oauth: true,
      protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource` },
    limits: { maxPageSize: 100, maxSnapshotNodes: 10000, minPollIntervalSeconds: 10,
      recommendedPollIntervalSeconds: 30, maxSyncBatchOperations: 1,
      idempotencyRetentionSeconds: 86400, syncCursorRetentionSeconds: 2592000 },
    'https://known.example/extensions/sync-retire': { href: `${origin}/extensions/sync-retire`,
      method: 'DELETE', requestBody: false, successStatus: 204,
      requiredHeaders: ['Authorization', 'Origin', 'Known-Sync-Session', 'Idempotency-Key'] } }] };
}

describe('P3-27 real Session client', () => {
  test('retirement v2 remains readable by the existing required-field Manifest parser', () => {
    const value = manifest();
    Object.assign(value.mounts[0]!['https://known.example/extensions/sync-retire'], { version: 2,
      reauthorization: { proofHeader: 'Known-Sync-Replica-Proof', proof: 'pinned-session', authority: 'current-account-installation' } });
    const found = discoverSyncEndpoints(value, config());
    assert.equal(found.syncRetire, 'https://known.example/extensions/sync-retire');
    assert.equal(found.syncSessions, 'https://known.example/v1/session');
    assert.equal(found.syncPush, 'https://known.example/v1/push');
    assert.equal(found.syncRetireReauthorization, true);
  });

  test('unknown, absent and malformed namespace versions never authorize a new proof header', () => {
    const authorization = { proofHeader: 'Known-Sync-Replica-Proof', proof: 'pinned-session', authority: 'current-account-installation' };
    for (const declaration of [{}, { version: 1, reauthorization: authorization }, { version: 3, reauthorization: authorization },
      { version: '2', reauthorization: authorization }, { version: 2 },
      { version: 2, reauthorization: { ...authorization, proof: 'any-session' } },
      { version: 2, reauthorization: { ...authorization, proofHeader: 'Authorization' } },
      { version: 2, reauthorization: { ...authorization, authority: 'any-account' } },
      { version: 2, reauthorization: { ...authorization, extra: true } }]) {
      const value = manifest(); Object.assign(value.mounts[0]!['https://known.example/extensions/sync-retire'], declaration);
      const found = discoverSyncEndpoints(value, config());
      assert.equal(found.syncRetireReauthorization, undefined);
      assert.equal(found.syncSessions, 'https://known.example/v1/session');
    }
  });

  test('serializes authority renewal so a concurrent caller observes the committed Session', async () => {
    const queue = createSessionAuthorityQueue(); const events: string[] = []; let release!: () => void;
    assert.equal(queue.isInFlight(), false);
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.run(async () => { events.push('first:start'); await blocked;
      events.push('first:commit'); return 'session-2'; });
    const second = queue.run(async () => { events.push('second:read'); return 'session-2'; });
    assert.equal(queue.isInFlight(), true);
    await Promise.resolve(); assert.deepEqual(events, ['first:start']); release();
    assert.deepEqual(await Promise.all([first, second]), ['session-2', 'session-2']);
    assert.deepEqual(events, ['first:start', 'first:commit', 'second:read']);
    assert.equal(queue.isInFlight(), false);
  });

  test('clears rejected authority work before a restart can observe stability', async () => {
    const queue = createSessionAuthorityQueue();
    await assert.rejects(() => queue.run(async () => { throw new Error('session_failed'); }), /session_failed/);
    assert.equal(queue.isInFlight(), false);
    assert.equal(await queue.run(async () => 'session-restarted'), 'session-restarted');
    assert.equal(queue.isInFlight(), false);
  });

  test('uses observed Session identity as a CAS fence for queued force refreshes', () => {
    assert.equal(shouldForceSessionRefresh(true, 'session-1', 'session-1'), true);
    assert.equal(shouldForceSessionRefresh(true, 'session-1', 'session-2'), false);
    assert.equal(shouldForceSessionRefresh(true, null, 'session-2'), false);
    assert.equal(shouldForceSessionRefresh(true, null, null), true);
    assert.equal(shouldForceSessionRefresh(false, 'session-1', 'session-1'), false);
  });

  test('renews before the replica lease can expire between engine wake cycles', () => {
    assert.equal(syncSessionNeedsRenewal(fixtureSession(NOW), NOW), false);
    assert.equal(syncSessionNeedsRenewal({ ...fixtureSession(NOW), replicaLease: {
      ...fixtureSession(NOW).replicaLease, expiresAt: new Date(NOW + 60_000).toISOString() } }, NOW), true);
    assert.equal(syncSessionNeedsRenewal({ ...fixtureSession(NOW), expiresAt: new Date(NOW).toISOString() }, NOW), true);
  });

  test('fences a durable Session to the credential that created it across refresh and worker restart', async () => {
    const prior = { ...fixtureSession(NOW),
      credentialAuthorityDigest: await credentialAuthorityDigest(COOKIE_VALUE) };
    assert.equal(await sessionMatchesCredentialAuthority(prior, { accessToken: COOKIE_VALUE }), true);
    assert.equal(await sessionMatchesCredentialAuthority(prior, { accessToken: `${COOKIE_VALUE}-rotated` }), false);
    assert.equal(await sessionMatchesCredentialAuthority({ ...prior,
      credentialAuthorityDigest: undefined } as unknown as StoredSession, { accessToken: COOKIE_VALUE }), false);
  });

  test('classifies the closed COLP Session authority matrix and rejects contradictory wire states', () => {
    assert.deepEqual(sessionAuthorityContract.successfulLeaseStates, ['active']);
    assert.equal(classifySessionAuthority(fixtureSession(NOW), {
      authorityRefreshRequired: false, bootstrapped: false }), 'active');
    const snapshot = { ...fixtureSession(NOW), snapshotRequired: true };
    assert.equal(classifySessionAuthority(snapshot, {
      authorityRefreshRequired: false, bootstrapped: false }), 'bootstrap');
    assert.equal(classifySessionAuthority(snapshot, {
      authorityRefreshRequired: true, bootstrapped: true }), 'recovery');
    assert.equal(snapshot.snapshotRequired, sessionAuthorityContract.authorities.recovery.snapshotRequired);
    assert.throws(() => classifySessionAuthority({ ...snapshot, replicaLease: {
      ...snapshot.replicaLease, state: 'recovery_required' } }, {
      authorityRefreshRequired: true, bootstrapped: true }), /session_authority_invalid/);
    assert.throws(() => classifySessionAuthority({ ...fixtureSession(NOW), snapshotRequired: undefined }, {
      authorityRefreshRequired: true, bootstrapped: true }), /session_authority_invalid/);
  });

  test('retries stale renewal against committed Replica authority while the prior Session remains valid', async () => {
    const prior = fixtureSession(NOW);
    const renewed = { ...prior, sessionId: 'session-renewed' }; let attempts = 0;
    assert.equal(await retryStaleReplicaSession(prior, new Error('stale_replica'), async () => {
      attempts += 1; return renewed;
    }, NOW), renewed);
    assert.equal(attempts, 1);
    await assert.rejects(retryStaleReplicaSession(prior, new Error('session_failed'), async () => renewed, NOW),
      /session_failed/);
    await assert.rejects(retryStaleReplicaSession({ ...prior, expiresAt: new Date(NOW).toISOString() },
      new Error('stale_replica'), async () => renewed, NOW), /stale_replica/);
  });

  test('keeps a still-valid prior Session across offline renewal attempts without masking hard failures', () => {
    const prior = fixtureSession(NOW);
    assert.equal(retainSessionAfterTransientRenewalFailure(prior, new TypeError('Failed to fetch'), NOW), true);
    assert.equal(retainSessionAfterTransientRenewalFailure(prior, new DOMException('timed out', 'AbortError'), NOW), true);
    assert.equal(retainSessionAfterTransientRenewalFailure(prior, new Error('credential_revoked'), NOW), false);
    assert.equal(retainSessionAfterTransientRenewalFailure({ ...prior,
      expiresAt: new Date(NOW).toISOString() }, new TypeError('Failed to fetch'), NOW), false);
  });

  test('sends one explicit Bearer to the discovered Session endpoint and stores only bounded Session facts', async () => {
    const calls: Array<{ url: string; authorization: string | null; cookie: string;
      credentials: RequestCredentials | undefined }> = [];
    const result = await createSyncSession({ endpoints: discoverSyncEndpoints(manifest(), config()),
      credential: fixtureCredential(config(), NOW), request: fixtureSessionRequest(), fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(url), authorization: headers.get('authorization'),
          cookie: headers.get('cookie') ?? '', credentials: init?.credentials });
        return Response.json(fixtureSessionResult(NOW), { status: 201 });
      } });
    assert.deepEqual(calls, [{ url: 'https://known.example/v1/session', authorization: `Bearer ${COOKIE_VALUE}`,
      cookie: '', credentials: 'omit' }]);
    assert.equal('accessToken' in result, false);
    assert.equal(result.credentialAuthorityDigest, await credentialAuthorityDigest(COOKIE_VALUE));
    assert.equal(result.sessionId, 'session-fixture');
  });

  test('combines caller cancellation with the Session request timeout', async () => {
    const originalAny = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
    try {
      const caller = new AbortController();
      const observed: { signal?: AbortSignal } = {};
      const result = await createSyncSession({ endpoints: discoverSyncEndpoints(manifest(), config()),
        credential: fixtureCredential(config(), NOW), request: fixtureSessionRequest(), origin: EXTENSION_ORIGIN,
        signal: caller.signal, fetch: async (_url, init) => {
          observed.signal = init?.signal ?? undefined;
          assert.equal(new Headers(init?.headers).get('origin'), EXTENSION_ORIGIN);
          return Response.json(fixtureSessionResult(NOW), { status: 201 });
        } });
      assert.equal(result.sessionId, 'session-fixture');
      assert.equal(observed.signal?.aborted, false);
      caller.abort();
      assert.equal(observed.signal?.aborted, true);

      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      await assert.rejects(createSyncSession({ endpoints: discoverSyncEndpoints(manifest(), config()),
        credential: fixtureCredential(config(), NOW), request: fixtureSessionRequest(),
        signal: alreadyAborted.signal, fetch: async (_url, init) => {
          assert.equal(init?.signal?.aborted, true);
          return Response.json(fixtureSessionResult(NOW), { status: 201 });
        } }), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
    } finally {
      if (originalAny) Object.defineProperty(AbortSignal, 'any', originalAny);
      else delete (AbortSignal as unknown as { any?: unknown }).any;
    }
  });

  test('caller cancellation after Session headers releases a stalled body', async () => {
    const caller = new AbortController(); let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    const request = createSyncSession({ endpoints: discoverSyncEndpoints(manifest(), config()),
      credential: fixtureCredential(config(), NOW), request: fixtureSessionRequest(),
      signal: caller.signal, fetch: async () => response });
    const rejected = assert.rejects(request,
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
    while (!response.bodyUsed) await new Promise<void>(resolve => setImmediate(resolve));
    caller.abort(); await rejected;
    assert.equal(cancelled, true);
  });

  test('rejects empty, oversized, or header-unsafe COLP session values', () => {
    assert.deepEqual(colpCredentialHeaders(COOKIE_VALUE), { Authorization: `Bearer ${COOKIE_VALUE}` });
    for (const value of ['', 'valid\r\nInjected: value', 'x'.repeat(8_193)]) {
      assert.throws(() => colpCredentialHeaders(value), /session_cookie_invalid/u);
    }
  });

  test('preserves bounded Retry-After authority on a rate-limited Session response', async () => {
    const response = new Response(JSON.stringify({ code: 'rate_limited', retryable: true,
      retryAfterSeconds: 4 }), { status: 429, headers: {
      'Content-Type': 'application/problem+json', 'Retry-After': '4' } });
    const error = await createSyncSession({ endpoints: discoverSyncEndpoints(manifest(), config()),
      credential: fixtureCredential(config(), NOW), request: fixtureSessionRequest(),
      fetch: async () => response }).catch((caught: unknown) => caught) as Error & {
        readonly code?: string; readonly retryAfterMilliseconds?: number };
    assert.equal(error.message, 'rate_limited');
    assert.equal(error.code, 'rate_limited');
    assert.equal(error.retryAfterMilliseconds, 4_000);
    assert.doesNotMatch(JSON.stringify(error), /baSessionToken/u);
  });

  test('rejects lifecycle state leakage and incomplete lease facts in a successful Session response', async () => {
    for (const response of [
      { ...fixtureSessionResult(NOW), replicaLease: { ...fixtureSessionResult(NOW).replicaLease,
        state: 'recovery_required' } },
      { ...fixtureSessionResult(NOW), replicaLease: { ...fixtureSessionResult(NOW).replicaLease,
        acknowledgedCursor: undefined } },
      { ...fixtureSessionResult(NOW), replicaLease: { ...fixtureSessionResult(NOW).replicaLease,
        acknowledgedCursor: '' } },
    ]) {
      await assert.rejects(createSyncSession({ endpoints: discoverSyncEndpoints(manifest(), config()),
        credential: fixtureCredential(config(), NOW), request: fixtureSessionRequest(),
        fetch: async () => Response.json(response, { status: 201 }) }), /session_invalid/);
    }
  });

  test('rejects oversized, invalid UTF-8 and misleading remote JSON bodies before object construction', async () => {
    await assert.rejects(() => readBoundedJson(
      new Response(JSON.stringify({ value: 'x'.repeat(128) })), 64, 'json_invalid'), /json_invalid/);
    await assert.rejects(() => readBoundedJson(
      new Response(new Uint8Array([0xc3, 0x28])), 64, 'json_invalid'), /json_invalid/);
    await assert.rejects(() => readBoundedJson(
      new Response('{}', { headers: { 'Content-Length': '65' } }), 64, 'json_invalid'), /json_invalid/);
  });
});


test('stores the negotiated batch limit and rejects a response above the client declaration', () => {
  const request = fixtureSessionRequest(); request.replica.capabilities.maxBatchOperations = 50;
  const response = { ...fixtureSessionResult(NOW), maxBatchOperations: 50 };
  assert.equal(parseSyncSessionResult(response, request, 'a'.repeat(64)).maxBatchOperations, 50);
  request.replica.capabilities.maxBatchOperations = 1;
  assert.throws(() => parseSyncSessionResult(response, request, 'a'.repeat(64)), /session_invalid/u);
  for (const maximum of [0, -1, 1.5, 51, '50']) {
    assert.throws(() => parseSyncSessionResult({ ...response, maxBatchOperations: maximum }, request, 'a'.repeat(64)), /session_invalid/u);
  }
});


test('discovers batch capacity while falling back to singleton transport on older manifests', () => {
  const value = manifest();
  assert.equal(discoverSyncEndpoints(value, config()).maxBatchOperations, 1);
  value.mounts[0]!.limits.maxSyncBatchOperations = 50;
  assert.equal(discoverSyncEndpoints(value, config()).maxBatchOperations, 50);
  const legacy = structuredClone(value) as unknown as { mounts: Array<{ limits: Record<string, unknown> }> };
  delete legacy.mounts[0]!.limits.maxSyncBatchOperations;
  assert.equal(discoverSyncEndpoints(legacy, config()).maxBatchOperations, 1);
  legacy.mounts[0]!.limits.maxSyncBatchOperations = 0;
  assert.throws(() => discoverSyncEndpoints(legacy, config()), /manifest_batch_limit_invalid/u);
});
