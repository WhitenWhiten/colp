import assert from 'node:assert/strict';
import { request as rawRequest } from 'node:http';
import { afterEach, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { endpointContracts } from '@know-n/colp/semantic';
import type { Operation, SyncPull } from '@know-n/colp/types';
import { loadConfig } from '../../support/test-config.js';
import { createPublicationManifestCandidate } from '../../../src/modules/publication/index.js';
import { SyncPullReadError, type SyncPullReadInput } from '../../../src/modules/sync/index.js';
import {
  createMemorySyncAdmissionPolicy,
  type SyncAdmissionPolicy,
} from '../../../src/infrastructure/rate-limit/index.js';
import { DatabaseOperationError } from '../../../src/infrastructure/database/errors.js';
import { registerSyncPullRoutes } from '../../../src/transport/colp-sync/sync-pull-routes.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const AUTHORIZATION = 'Bearer P3-21-AUTHORIZATION-SECRET';
const SESSION = 'p3-21-session';
const CURSOR = 'p3-21-cursor';
const NEXT_CURSOR = 'p3-21-next-cursor';
const apps: FastifyInstance[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function operation(id = 'p3-21-operation'): Operation {
  return { opId: id, replicaId: 'p3-21-replica', sequence: 1, collectionId: 'p3-21-collection',
    type: 'update_node_content', targetId: 'p3-21-node', baseRevision: 'node-r1',
    occurredAt: '2026-07-26T08:00:00Z', payload: { base: { title: 'Before' }, value: { title: 'After' } } };
}

async function start(options: {
  readonly read?: (input: SyncPullReadInput) => Promise<{
    readonly events: readonly { readonly cursor: string; readonly kind: 'operation'; readonly operation: Operation }[];
    readonly nextCursor: string; readonly hasMore: boolean; readonly collectionRevision: string;
    readonly nextTuple: { readonly commitOrdinal: string; readonly streamKind: 'operation'; readonly stableId: string };
  }>;
  readonly responseBudgetBytes?: number;
  readonly requestTimeoutMs?: number;
  /** FIX-L-038: the test builder may default the required recommendedPullAfterSeconds dependency. */
  readonly recommendedPullAfterSeconds?: number;
  readonly allowInsecureLoopback?: boolean;
  readonly snapshotUrl?: string;
  readonly admission?: SyncAdmissionPolicy;
  readonly allowedOrigins?: readonly string[];
} = {}) {
  const calls: SyncPullReadInput[] = [];
  const credential = await mintVerifiedExtensionCredentialFixture({ issuer: 'https://issuer.example',
    audience: 'known-api', clientId: 'known-extension', subject: 'p3-21-subject',
    credentialId: 'p3-21-credential' });
  const app = Fastify({ logger: false, routerOptions: { querystringParser: (query) => {
    const parameters = new URLSearchParams(query);
    return Object.fromEntries([...new Set(parameters.keys())].map((name) => {
      const values = parameters.getAll(name); return [name, values.length === 1 ? values[0] : values];
    }));
  } } });
  registerSyncPullRoutes(app, {
    path: '/private-entry/pull-stream', allowedOrigins: options.allowedOrigins ?? [ORIGIN],
    credentialVerifier: { async verify({ authorization }) {
      if (authorization !== AUTHORIZATION) throw new Error('denied');
      return credential;
    } },
    reader: { async read(input) {
      calls.push(input);
      return options.read?.(input) ?? { events: [], nextCursor: input.cursor ?? NEXT_CURSOR, hasMore: false,
        collectionRevision: 'collection-r1',
        nextTuple: { commitOrdinal: '0', streamKind: 'operation', stableId: '' } };
    } },
    rateLimit: { maxRequests: 100, windowMs: 60_000 }, maxLimit: 100,
    responseBudgetBytes: options.responseBudgetBytes ?? 131_072,
    requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
    recommendedPullAfterSeconds: options.recommendedPullAfterSeconds ?? 0,
    ...(options.snapshotUrl ? { snapshotUrl: options.snapshotUrl } : {}),
    allowInsecureLoopback: options.allowInsecureLoopback ?? true,
    ...(options.admission === undefined ? {} : { admission: options.admission }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('not listening');
  return { origin: `http://127.0.0.1:${address.port}`, calls };
}

async function pull(origin: string, query = `sessionId=${SESSION}&cursor=${CURSOR}&limit=2`, requestOrigin = ORIGIN) {
  return fetch(`${origin}/private-entry/pull-stream?${query}`, { headers: {
    Accept: 'application/json', Authorization: AUTHORIZATION, Origin: requestOrigin,
  } });
}

test('uses the public syncPull endpoint/query/response contracts and a Manifest candidate key', async () => {
  assert.deepEqual(endpointContracts.syncPull.operations[0], {
    method: 'GET', profile: 'sync', query: 'syncPullQuery', response: 'syncPull', successStatuses: [200],
  });
  const candidate = createPublicationManifestCandidate({
    origin: 'https://known.example', mountPath: '/colp/v0.1/',
    serverUuid: '019f9d33-2111-7111-8111-111111111111', title: 'Known',
    maxPageSize: 100, maxSnapshotNodes: 10_000,
    endpoints: { directory: 'https://known.example/directory', collection: 'https://known.example/collections/{collectionId}',
      snapshot: 'https://known.example/collections/{collectionId}/snapshot',
      syncPull: 'https://known.example/private-entry/pull-stream' },
  }, ['directory', 'collection', 'snapshot', 'syncPull']);
  assert.equal(candidate.manifest.mounts[0]?.endpoints.syncPull, 'https://known.example/private-entry/pull-stream');
  assert.deepEqual(candidate.manifest.mounts[0]?.profiles, ['core']);
});

test('accepts strict public query parsing and emits a schema-valid private empty page', async () => {
  const server = await start({ read: async () => ({ events: [], nextCursor: CURSOR, hasMore: false,
    collectionRevision: 'collection-r1', nextTuple: {
      commitOrdinal: '0', streamKind: 'operation', stableId: '',
    } }) });
  const response = await pull(server.origin);
  const body = await response.json() as SyncPull;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(createValidatorRegistry().validate('syncPull', body).valid, true);
  assert.deepEqual(body, { events: [], nextCursor: CURSOR, hasMore: false,
    collectionRevision: 'collection-r1', recommendedPullAfterSeconds: 0 });
  assert.equal(server.calls[0]?.sessionId, SESSION);
  assert.equal(server.calls[0]?.cursor, CURSOR);
  assert.equal(server.calls[0]?.limit, 2);
});

test('passes the authenticated Origin binding into the Pull reader', async () => {
  const server = await start({ read: async (input) => {
    assert.equal(input.origin, ORIGIN);
    return { events: [], nextCursor: CURSOR, hasMore: false, collectionRevision: 'collection-r1',
      nextTuple: { commitOrdinal: '0', streamKind: 'operation', stableId: '' } };
  } });
  assert.equal((await pull(server.origin)).status, 200);
});

test('passes the configured recommendedPullAfterSeconds through normal and reissued Pull responses', async () => {
  const empty = await start({ recommendedPullAfterSeconds: 10 });
  const emptyResponse = await pull(empty.origin);
  assert.equal(emptyResponse.status, 200);
  assert.equal((await emptyResponse.json() as SyncPull).recommendedPullAfterSeconds, 10);

  const event = { cursor: NEXT_CURSOR, kind: 'operation' as const, operation: operation() };
  const reissued = await start({ recommendedPullAfterSeconds: 10, read: async () => ({ events: [event],
    nextCursor: NEXT_CURSOR, hasMore: false, cursorReissued: true, collectionRevision: 'collection-r1',
    nextTuple: { commitOrdinal: '1', streamKind: 'operation', stableId: event.operation.opId } }) });
  const reissuedResponse = await pull(reissued.origin);
  assert.equal(reissuedResponse.status, 200);
  assert.equal((await reissuedResponse.json() as SyncPull).recommendedPullAfterSeconds, 10);
});

test('fails closed when recommendedPullAfterSeconds is missing, fractional, negative, or above the config cap', () => {
  const base = { path: '/private-entry/pull-stream', allowedOrigins: [ORIGIN],
    credentialVerifier: { async verify() { throw new Error('not invoked'); } },
    reader: { async read(): Promise<never> { throw new Error('not invoked'); } },
    rateLimit: { maxRequests: 100, windowMs: 60_000 }, maxLimit: 100,
    responseBudgetBytes: 131_072, requestTimeoutMs: 5_000 };
  for (const value of [undefined, 1.5, -1, 86_401]) {
    const app = Fastify({ logger: false });
    apps.push(app);
    assert.throws(() => registerSyncPullRoutes(app, { ...base,
      recommendedPullAfterSeconds: value as never }), /recommended interval/u, String(value));
  }
});

test('rejects a non-bootstrap empty page that changes cursor identity', async () => {
  const server = await start({ read: async () => ({ events: [], nextCursor: NEXT_CURSOR, hasMore: false,
    collectionRevision: 'collection-r1', nextTuple: {
      commitOrdinal: '0', streamKind: 'operation', stableId: '',
    } }) });
  const response = await pull(server.origin);
  assert.equal(response.status, 500);
  assert.equal((await response.json() as { readonly code: string }).code, 'internal_error');
});

test('allows a verified Session handoff to reissue cursor identity on an empty page', async () => {
  const server = await start({ read: async () => ({ events: [], nextCursor: NEXT_CURSOR, hasMore: false,
    collectionRevision: 'collection-r1', cursorReissued: true, nextTuple: {
      commitOrdinal: '0', streamKind: 'operation', stableId: '',
    } }) });
  const response = await pull(server.origin);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as SyncPull).nextCursor, NEXT_CURSOR);
  assert.equal(response.headers.get('known-sync-cursor-reissued'), 'true');
});

test('allows initial empty Pull to issue a cursor and rejects events that retain the request cursor', async () => {
  const initial = await start();
  const initialResponse = await pull(initial.origin, `sessionId=${SESSION}&limit=2`);
  assert.equal(initialResponse.status, 200);
  assert.equal((await initialResponse.json() as SyncPull).nextCursor, NEXT_CURSOR);
  assert.equal(initial.calls[0]?.cursor, null);

  const event = { cursor: CURSOR, kind: 'operation' as const, operation: operation() };
  const stalled = await start({ read: async () => ({ events: [event], nextCursor: CURSOR,
    hasMore: false, collectionRevision: 'collection-r1', nextTuple: {
      commitOrdinal: '1', streamKind: 'operation', stableId: event.operation.opId,
    } }) });
  assert.equal((await pull(stalled.origin)).status, 500);

  const advancedEvent = { cursor: NEXT_CURSOR, kind: 'operation' as const, operation: operation() };
  const advanced = await start({ read: async () => ({ events: [advancedEvent], nextCursor: NEXT_CURSOR,
    hasMore: false, cursorReissued: true, collectionRevision: 'collection-r1', nextTuple: {
      commitOrdinal: '1', streamKind: 'operation', stableId: advancedEvent.operation.opId,
    } }) });
  const advancedResponse = await pull(advanced.origin);
  assert.equal(advancedResponse.status, 200);
  assert.equal(advancedResponse.headers.get('known-sync-cursor-reissued'), null);
});

test('rejects unknown, repeated, malformed and out-of-range query before reading', async () => {
  const server = await start();
  for (const query of [
    `sessionId=${SESSION}&cursor=${CURSOR}&unknown=1`,
    `sessionId=${SESSION}&sessionId=other&cursor=${CURSOR}`,
    `sessionId=${SESSION}&cursor=${CURSOR}&cursor=other`,
    `sessionId=${SESSION}&cursor=${CURSOR}&limit=0`,
    `sessionId=${SESSION}&cursor=${CURSOR}&limit=101`,
    `sessionId=${SESSION}&cursor=${CURSOR}&limit=01`,
    `sessionId=${SESSION}&cursor=%ZZ`,
  ]) {
    const response = await pull(server.origin, query);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json() as { code: string }).code, 'invalid_query');
  }
  assert.deepEqual(server.calls, []);
});

test('authenticates before parsing attacker-controlled query details', async () => {
  const server = await start();
  const response = await fetch(`${server.origin}/private-entry/pull-stream?cursor=%ZZ`, { headers: {
    Authorization: 'Bearer invalid', Origin: ORIGIN,
  } });
  assert.equal(response.status, 401);
  assert.equal((await response.json() as { readonly code: string }).code, 'authentication_required');
  assert.deepEqual(server.calls, []);
});

test('requires raw singleton Authorization and Origin plus secure transport', async () => {
  for (const duplicate of ['Authorization', 'Origin']) {
    const server = await start();
    const url = new URL(`/private-entry/pull-stream?sessionId=${SESSION}&cursor=${CURSOR}`, server.origin);
    const status = await new Promise<number>((resolve, reject) => {
      const headers = ['Accept', 'application/json', 'Authorization', AUTHORIZATION, 'Origin', ORIGIN];
      headers.push(duplicate, duplicate === 'Authorization' ? 'Bearer other' : ORIGIN);
      const request = rawRequest({ hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`,
        method: 'GET', headers }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)); });
      request.on('error', reject); request.end();
    });
    assert.equal(status, 400);
    assert.deepEqual(server.calls, []);
  }
  const insecure = await start({ allowInsecureLoopback: false });
  const forged = await fetch(`${insecure.origin}/private-entry/pull-stream?sessionId=${SESSION}&cursor=${CURSOR}`, {
    headers: { Authorization: AUTHORIZATION, Origin: ORIGIN, 'X-Forwarded-Proto': 'https' },
  });
  assert.equal(forged.status, 401);
  assert.deepEqual(insecure.calls, []);
});

test('maps ordered events, enforces response budget and never exposes secret inputs', async () => {
  const event = { cursor: NEXT_CURSOR, kind: 'operation' as const, operation: operation() };
  const success = await start({ read: async () => ({ events: [event], nextCursor: NEXT_CURSOR,
    hasMore: false, collectionRevision: 'collection-r2',
    nextTuple: { commitOrdinal: '1', streamKind: 'operation', stableId: event.operation.opId } }) });
  const response = await pull(success.origin);
  const body = await response.json() as SyncPull;
  assert.equal(response.status, 200);
  assert.equal(body.nextCursor, body.events.at(-1)?.cursor);
  const bounded = await start({ responseBudgetBytes: 64, read: async () => ({ events: [event],
    nextCursor: NEXT_CURSOR, hasMore: false, collectionRevision: 'collection-r2',
    nextTuple: { commitOrdinal: '1', streamKind: 'operation', stableId: event.operation.opId } }) });
  const denied = await pull(bounded.origin);
  const text = await denied.text();
  assert.equal(denied.status, 413);
  assert.doesNotMatch(text, /P3-21-AUTHORIZATION-SECRET|p3-21-cursor/u);
});

test('maps cursor and active-only lifecycle failures to registered private Problems', async () => {
  for (const [readCode, status, problemCode] of [
    ['invalid_cursor_scope', 400, 'invalid_cursor_scope'],
    ['sync_cursor_expired', 410, 'sync_cursor_expired'],
    ['stale_replica', 410, 'stale_replica'],
    ['replica_retired', 410, 'replica_retired'],
    ['not_found', 404, 'resource_not_found'],
    ['payload_too_large', 413, 'payload_too_large'],
    ['integrity_failure', 500, 'internal_error'],
  ] as const) {
    const server = await start({ read: async () => { throw new SyncPullReadError(readCode); } });
    const response = await pull(server.origin);
    const body = await response.json() as { readonly code: string };
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(body.code, problemCode);
  }
});

test('maps a unique_violation during read to a retryable service_unavailable', async () => {
  const server = await start({
    read: async () => { throw new DatabaseOperationError('unique_violation', { code: '23505' }); },
  });
  const response = await pull(server.origin);
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { readonly code: string }).code, 'service_unavailable');
});

test('sync_cursor_expired without a configured Snapshot URL stays wire-valid (F027)', async () => {
  const server = await start({ read: async () => { throw new SyncPullReadError('sync_cursor_expired'); } });
  const response = await pull(server.origin);
  const body = await response.json() as { readonly code: string; readonly snapshotUrl?: string };
  assert.equal(response.status, 410);
  assert.equal(body.code, 'sync_cursor_expired');
  assert.equal('snapshotUrl' in body, false);
});

test('distinguishes expired renegotiation from Snapshot recovery without inventing wire codes', async () => {
  const snapshotUrl = 'https://known.example/private-entry/snapshot';
  for (const [readCode, expectedRecovery] of [
    ['replica_expired', undefined],
    ['recovery_required', snapshotUrl],
  ] as const) {
    const server = await start({ snapshotUrl, read: async () => { throw new SyncPullReadError(readCode); } });
    const response = await pull(server.origin);
    const body = await response.json() as { readonly code: string; readonly snapshotUrl?: string };
    assert.equal(response.status, 410);
    assert.equal(body.code, 'stale_replica');
    assert.equal(body.snapshotUrl, expectedRecovery);
  }
});

test('propagates timeout and client cancellation to the read signal without checkpoint facts', async () => {
  let observedSignal: AbortSignal | undefined;
  const server = await start({ requestTimeoutMs: 100, read: async (input) => {
    observedSignal = input.signal;
    await new Promise<void>((resolve, reject) => {
      input.signal?.addEventListener('abort', () => reject(input.signal?.reason), { once: true });
      setTimeout(resolve, 60_000).unref();
    });
    throw new Error('unreachable');
  } });
  const response = await pull(server.origin);
  assert.equal(response.status, 503);
  assert.equal(observedSignal?.aborted, true);

  let entered!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  let disconnected!: () => void;
  const disconnectedSignal = new Promise<void>((resolve) => { disconnected = resolve; });
  const cancelled = await start({ requestTimeoutMs: 5_000, read: async (input) => {
    entered();
    await new Promise<never>((_resolve, reject) => input.signal?.addEventListener('abort', () => {
      disconnected(); reject(input.signal?.reason);
    }, { once: true }));
    throw new Error('unreachable');
  } });
  const url = new URL(`/private-entry/pull-stream?sessionId=${SESSION}&cursor=${CURSOR}`, cancelled.origin);
  const request = rawRequest({ hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`,
    method: 'GET', headers: { Authorization: AUTHORIZATION, Origin: ORIGIN } });
  request.on('error', () => undefined);
  request.end();
  await reading;
  request.destroy();
  await disconnectedSignal;
});

test('loads independent active/retained Pull cursor keys and fails closed on malformed configuration', () => {
  const config = loadConfig(syncEnv());
  assert.equal(config.syncSession?.pull.path, '/private-entry/pull-stream');
  assert.equal(config.publication.endpoints.syncPull, 'https://known.example/private-entry/pull-stream');
  assert.equal(config.syncSession?.pull.cursorKeys.active.id, 'pull-v2');
  assert.equal(config.syncSession?.pull.cursorKeys.retained[0]?.id, 'pull-v1');
  assert.equal(config.syncSession?.pull.recommendedPullAfterSeconds, 30);
  assert.equal(loadConfig(syncEnv({ SYNC_PULL_RECOMMENDED_AFTER_SECONDS: '10' }))
    .syncSession?.pull.recommendedPullAfterSeconds, 10);
  assert.throws(() => loadConfig(syncEnv({ SYNC_PULL_RECOMMENDED_AFTER_SECONDS: '0.5' })),
    /SYNC_PULL_RECOMMENDED_AFTER_SECONDS/u);
  assert.throws(() => loadConfig(syncEnv({ SYNC_PULL_RECOMMENDED_AFTER_SECONDS: '86401' })),
    /SYNC_PULL_RECOMMENDED_AFTER_SECONDS/u);
  assert.notEqual(config.syncSession?.pull.cursorKeys.active.secret,
    config.publication.cursorKeys.active.secret);
  assert.equal(config.syncSession?.ack.recoveryCapabilityKeys.active.id, 'recovery-v1');
  assert.notEqual(config.syncSession?.ack.recoveryCapabilityKeys.active.secret,
    config.syncSession?.pull.cursorKeys.active.secret);
  assert.throws(() => loadConfig(syncEnv({ SYNC_PULL_CURSOR_KEYS: 'not-json' })), /SYNC_PULL_CURSOR_KEYS/u);
  assert.throws(() => loadConfig(syncEnv({ SYNC_PULL_CURSOR_KEY: Buffer.alloc(32, 17).toString('base64') })), /independent/u);
  assert.throws(() => loadConfig(syncEnv({
    SYNC_RECOVERY_CAPABILITY_KEY: Buffer.alloc(32, 41).toString('base64'),
  })), /SYNC_RECOVERY_CAPABILITY|independent/u);
});

test('injected memory limiter max=1 returns rate_limited on the second pull', async () => {
  const limited = await start({
    admission: createMemorySyncAdmissionPolicy({
      budgets: { pull: { maxRequests: 1, windowMs: 60_000 } },
    }),
  });
  assert.equal((await pull(limited.origin)).status, 200);
  const denied = await pull(limited.origin);
  assert.equal(denied.status, 429);
  assert.equal((await denied.json() as { code: string }).code, 'rate_limited');
});

test('injected failing limiter returns service_unavailable and never reads', async () => {
  const failing: SyncAdmissionPolicy = {
    admitPreAuth: async () => ({ kind: 'failed', reason: 'limiter_unavailable' }),
    admitSubject: async () => ({ kind: 'failed', reason: 'limiter_unavailable' }),
    readiness: () => ({ status: 'degraded', reason: 'last_command_failed' }),
    close: async () => undefined,
  };
  const server = await start({ admission: failing });
  const response = await pull(server.origin);
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { code: string }).code, 'service_unavailable');
  assert.deepEqual(server.calls, []);
});

function syncEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', DATABASE_URL: 'postgres://unused/known', LOG_LEVEL: 'silent',
    PRODUCT_ORIGIN: 'https://known.example', PUBLICATION_ORIGIN: 'https://known.example',
    // FIX-H-001: non-test-provider configs require a JWKS URI whose origin
    // matches the default OIDC_ISSUER; keep loadConfig() assertions hermetic
    // instead of depending on ambient OIDC variables.
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    SYNC_SESSION_ENABLED: 'true', SYNC_EXTENSION_IDS: 'abcdefghijklmnopabcdefghijklmnop',
    SYNC_OAUTH_ISSUER: 'https://issuer.example.test', SYNC_OAUTH_CLIENT_ID: 'known-extension',
    SYNC_OAUTH_AUDIENCE: 'known-sync-api', SYNC_OAUTH_AUTHORIZATION_ENDPOINT: 'https://issuer.example.test/auth',
    SYNC_OAUTH_TOKEN_ENDPOINT: 'https://issuer.example.test/token', SYNC_OAUTH_JWKS_URI: 'https://issuer.example.test/jwks',
    SYNC_OAUTH_REDIRECT_URI: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/callback',
    SYNC_SESSION_REPLAY_KEY: Buffer.alloc(32, 23).toString('base64'),
    SYNC_SNAPSHOT_CURSOR_KEY: Buffer.alloc(32, 29).toString('base64'), SYNC_SNAPSHOT_CURSOR_KEY_ID: 'snapshot-v1',
    PUBLICATION_CURSOR_KEY: Buffer.alloc(32, 31).toString('base64'),
    SYNC_PULL_PATH: '/private-entry/pull-stream', SYNC_PULL_CURSOR_KEY_ID: 'pull-v2',
    SYNC_PULL_CURSOR_KEY: Buffer.alloc(32, 41).toString('base64'),
    SYNC_RECOVERY_CAPABILITY_KEY_ID: 'recovery-v1',
    SYNC_RECOVERY_CAPABILITY_KEY: Buffer.alloc(32, 44).toString('base64'),
    SYNC_PULL_LINEAGE_KEY_ID: 'lineage-v1',
    SYNC_PULL_LINEAGE_KEY: Buffer.alloc(32, 45).toString('base64'),
    SYNC_PULL_CURSOR_KEYS: JSON.stringify([{ id: 'pull-v1', secret: Buffer.alloc(32, 43).toString('base64') }]),
    ...overrides };
}
