import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { digestJson } from '../src/bookmark-event-codec.js';
import type { JsonObject, SyncScope } from '../src/sync-state-store.js';
import { SESSION_COOKIE_NAME } from '../src/auth-client.js';
import { config, COOKIE_VALUE, EXTENSION_ID, fixtureCredential, fixtureSessionResult,
  manifest, memoryCookies, sessionJson } from './auth-shell-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
});

/** Real SW owners, credential/fence/Session lane and IndexedDB. Only Chrome
 * storage/cookies/tabs and server HTTP are replaceable external boundaries. */
export async function scopeAuditFixture(connected = true) {
  vi.resetModules();
  const database = new IDBFactory();
  vi.stubGlobal('indexedDB', database);
  const local = new MemoryStorageArea(), managed = new MemoryStorageArea();
  const sessionArea = Object.assign(new MemoryStorageArea(), { setAccessLevel: vi.fn(async () => undefined) });
  const cookies = memoryCookies();
  cookies.values.set(`https://known.example/:${SESSION_COOKIE_NAME}`, COOKIE_VALUE);
  const tabs = { create: vi.fn(async (details: { url: string }) => ({ id: 1, ...details })) };
  vi.stubGlobal('chrome', { runtime: { id: EXTENSION_ID,
    getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}` },
  storage: { local, managed, session: sessionArea }, cookies, tabs });
  const build = config();
  let sessionNumber = 0;
  let handler: (url: string, init?: RequestInit) => Promise<Response | undefined> = async () => undefined;
  const network = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const handled = await handler(url, init);
    if (handled) return handled;
    if (url.endsWith('/generated-config.json')) return Response.json(build);
    if (url === build.manifestUrl) {
      const body = manifest();
      Object.assign(body.mounts[0]!['https://known.example/extensions/sync-retire'], { version: 2,
        reauthorization: { proofHeader: 'Known-Sync-Replica-Proof', proof: 'pinned-session',
          authority: 'current-account-installation' } });
      return Response.json(body, { headers: { 'content-type': 'application/vnd.collection-protocol.manifest+json;version=0.2' } });
    }
    if (url === `${build.serverOrigin}/v1/session`) {
      const request = JSON.parse(String(init?.body));
      const result = fixtureSessionResult(Date.now());
      return Response.json({ ...result, sessionId: `audit-session-${++sessionNumber}`,
        collection: { ...result.collection, collectionId: request.collection.collectionId, snapshotRequired: false },
        replicaLease: { ...result.replicaLease, generation: request.replica.binding.generation } }, { status: 201 });
    }
    if (url === build.tokenEndpoint) return Response.json(sessionJson(Date.now()));
    if (url.endsWith('/extensions/sync-retire')) return new Response(null, { status: 204 });
    if (url.endsWith('/api/v1/session')) return Response.json({ authenticated: true, csrfToken: 'audit-csrf' });
    if (url.endsWith('/api/v1/me')) return new Response(null, { status: 404 });
    throw new Error(`unexpected HTTP ${url}`);
  });
  vi.stubGlobal('fetch', network);
  const runtime = await import('../src/sw/runtime.js');
  const api = await import('../src/sw/scope.js');
  cleanups.push(async () => { await runtime.workCoordinator.drain(); runtime.syncState.close(); });
  const credential = fixtureCredential(build, Date.now());
  await runtime.store.saveCredential(credential);
  const binding = await runtime.store.getOrCreateBinding(0);
  await local.set({ [runtime.COLLECTION_BINDING]: 'collection-fixture' });
  const scope: SyncScope = { environment: build.environment, serverId: build.serverOrigin, serverOrigin: build.serverOrigin,
    accountId: credential.subject!, browserProfileId: binding.browserProfileId, collectionId: 'collection-fixture',
    replicaId: binding.replicaId, generation: Number(binding.generation) };
  if (connected) {
    await api.pushSessionAuthority();
    assert.ok(await runtime.syncState.getScope(scope), 'real Session admission registers this exact scope');
  }
  return { ...runtime, api, database, local, managed, sessionArea, cookies, tabs, build, credential, binding, scope, network,
    handleHTTP(value: typeof handler) { handler = value; },
    calls(pathname: string) { return network.mock.calls.filter(([url]) => new URL(String(url)).pathname === pathname); } };
}

export async function enqueueAuditEdit(f: Awaited<ReturnType<typeof scopeAuditFixture>>, metadata = false) {
  const payload: JsonObject = { opId: 'unsettled-edit', replicaId: f.scope.replicaId, sequence: 1,
    collectionId: f.scope.collectionId, type: 'update_node_content', targetId: 'kept-bookmark', baseRevision: 'revision-fixture',
    occurredAt: '2026-10-20T00:00:00.000Z', dependencies: [],
    payload: metadata ? { base: { tags: [] }, value: { tags: ['personal-tag'] } }
      : { base: { title: 'Original' }, value: { title: 'Local edit' } } };
  return f.syncState.allocateSequenceAndEnqueue(f.scope, { opId: String(payload.opId), batchId: 'unsettled-edit',
    idempotencyKey: 'unsettled-edit', digest: digestJson(payload), endpointIdentity: 'syncPush', mediaType: 'application/json',
    baseRevision: 'revision-fixture', operationRevision: 'local-1', status: 'pending', retry: { attempt: 0, notBefore: 0 },
    payload }, { allowUnstamped: true });
}
