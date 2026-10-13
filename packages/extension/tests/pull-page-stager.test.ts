import type { Conflict } from '@know-n/colp/types';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, test, vi } from 'vitest';
import { createPullPageStager, type PullPageApplyRuntime } from '../src/pull-page-stager.js';
import { createPullApplier, type PullBookmarkApi } from '../src/pull-applier.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { pullFixtures } from './pull-effect-fixtures.js';

const scope: SyncScope = { environment: 'production', serverId: 'server-stager',
  serverOrigin: 'https://known.example', accountId: 'account-stager', browserProfileId: 'profile-stager',
  collectionId: 'collection-stager', replicaId: 'replica-stager', generation: 1 };
const effectPageTemplate = 'https://known.example/effects/{effectId}/pages/{pageNumber}';

describe('Pull page transport and staging', () => {
  test.each(['pull', 'stage'] as const)('%s downloads and durably binds subtree member pages before apply', async method => {
    const event = pullFixtures.subtreeEvent({ sequence: 1, collectionId: scope.collectionId,
      targetId: 'node-1', members: ['node-1', 'child-1'], paged: true });
    const { effectPages, ...page } = pullFixtures.page({ events: [event], nextCursor: 'cursor-1',
      collectionRevision: 'revision-next' });
    const requests: string[] = [];
    const fixture = await setup({ fetch: async url => {
      requests.push(String(url));
      return Response.json(String(url).includes('/pull?') ? page : effectPages![0]);
    } });
    const runtime = { preflight: vi.fn<PullPageApplyRuntime['preflight']>(async () => {}),
      preflightMapping: vi.fn<PullPageApplyRuntime['preflightMapping']>(async () => {}),
      resume: vi.fn(async () => {}) };
    const stager = createPullPageStager(fixture.options, () => 1000, runtime);
    try {
      if (method === 'pull') await stager.pull('cursor-old');
      else await stager.stage(page);
      assert.ok(requests.includes('https://known.example/effects/op-1/pages/1'));
      assert.deepEqual(runtime.preflightMapping.mock.calls.map(call => call[0]), ['node-1', 'child-1']);
      const saved = await fixture.store.exportScope(scope);
      assert.equal(saved.pullPages.length, 1);
      assert.equal(saved.pullEvents.length, 1);
      assert.equal(saved.pullEvents[0]?.state, 'staged');
      assert.notEqual(saved.cursor?.cursor, 'cursor-1');
      assert.equal(runtime.resume.mock.calls.length, method === 'pull' ? 1 : 0);
    } finally { fixture.store.close(); }
  });

  test.each([null, [], 'invalid'])('rejects a non-object page %j without durable writes', async page => {
    const fixture = await setup();
    try {
      await assert.rejects(fixture.applier.stage(page), /pull_page_invalid/);
      assert.equal((await fixture.store.exportScope(scope)).pullPages.length, 0);
    } finally { fixture.store.close(); }
  });

  test.each(['pull', 'stage'] as const)('%s rejects a valid event belonging to another collection', async method => {
    const event = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1,
      collectionId: 'other-collection', parentId: 'root-colp' });
    const page = pullFixtures.page({ events: [event], nextCursor: 'cursor-1', collectionRevision: 'revision-next' });
    const fixture = await setup({ fetch: async () => Response.json(page) });
    try {
      await assert.rejects(method === 'pull' ? fixture.applier.pull('cursor-old') : fixture.applier.stage(page),
        /pull_source_binding_invalid/);
      assert.equal((await fixture.store.exportScope(scope)).pullPages.length, 0);
    } finally { fixture.store.close(); }
  });

  test('pulls an empty page with exact authority headers and commits its unchanged cursor', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fixture = await setup({ fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json(emptyPage('cursor-old'));
    } });
    await fixture.applier.pull('cursor-old');
    assert.equal(requests[0]?.url,
      'https://known.example/pull?sessionId=session-stager&cursor=cursor-old');
    const headers = new Headers(requests[0]?.init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer access-token');
    assert.equal(headers.get('origin'), 'chrome-extension://extension-id');
    assert.equal(headers.get('known-sync-session'), 'session-stager');
    assert.equal(requests[0]?.init?.redirect, 'error'); assert.equal(requests[0]?.init?.credentials, 'omit');
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.cursor?.cursor, 'cursor-old'); assert.equal(exported.pullPages[0]?.state, 'page_complete');
    fixture.store.close();
  });

  test('accepts a server-authorized reissued cursor and resumes the durable page', async () => {
    const fixture = await setup({ fetch: async () => Response.json(emptyPage('cursor-reissued'), {
      headers: { 'Known-Sync-Cursor-Reissued': 'true' },
    }) });
    await fixture.applier.pull('cursor-old');
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-reissued');
    fixture.store.close();
  });

  test('stages an opening and dismissal for one conflict on the same Pull page', async () => {
    const fixture = await setup();
    const conflict: Conflict = { id: 'conflict-1', collectionId: scope.collectionId, targetId: 'node-1',
      type: 'delete_update', field: '/deletedAt', incomingOpId: 'failed-op', createdAt: '2026-08-20T06:02:00Z',
      status: 'open', allowedResolutions: ['server'], revision: 'conflict-r1' };
    await fixture.applier.stage(pullFixtures.page({ events: [
      { cursor: 'cursor-open', kind: 'conflict', conflict },
      { cursor: 'cursor-resolved', kind: 'conflict', conflict: { ...conflict, status: 'resolved', revision: 'resolved-r2' } },
    ], nextCursor: 'cursor-resolved', collectionRevision: 'revision-old' }));
    await fixture.applier.resume();
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-resolved');
    assert.equal((await fixture.store.listPullEvents(scope, ['page_complete'])).length, 2);
    fixture.store.close();
  });

  test.each(['open', 'resolved'] as const)('rejects repeated %s states for the same conflict', async status => {
    const fixture = await setup();
    const conflict: Conflict = { id: 'conflict-1', collectionId: scope.collectionId, targetId: 'node-1',
      type: 'delete_update', field: '/deletedAt', incomingOpId: 'failed-op', createdAt: '2026-08-20T06:02:00Z',
      status, allowedResolutions: ['server'], revision: 'conflict-r1' };
    await assert.rejects(() => fixture.applier.stage(pullFixtures.page({ events: [
      { cursor: 'cursor-first', kind: 'conflict', conflict },
      { cursor: 'cursor-second', kind: 'conflict', conflict },
    ], nextCursor: 'cursor-second', collectionRevision: 'revision-old' })), /pull_event_duplicate/);
    assert.equal((await fixture.store.exportScope(scope)).pullPages.length, 0);
    fixture.store.close();
  });

  test.each([
    ['protocol', (options: any) => { options.session.acceptedProtocolVersion = '0.1'; }],
    ['collection', (options: any) => { options.session.collectionId = 'other'; }],
    ['separator policy', (options: any) => { options.session.conversionPolicy.separator = 'native'; }],
    ['effect id template', (options: any) => { options.effectPageTemplate = 'https://known.example/effects/id/pages/{pageNumber}'; }],
    ['page template', (options: any) => { options.effectPageTemplate = 'https://known.example/effects/{effectId}/pages/1'; }],
    ['effect origin', (options: any) => { options.effectPageAuthority = 'https://other.example'; }],
  ])('fails the %s gate before staging', async (_name, mutate) => {
    const fixture = await setup(); const options: any = { ...fixture.options,
      session: { ...fixture.options.session, conversionPolicy: { ...fixture.options.session.conversionPolicy } } };
    mutate(options);
    const applier = createPullApplier(options);
    await assert.rejects(() => applier.stage(emptyPage('cursor-old')), /pull_effect_gate_closed/);
    assert.equal((await fixture.store.exportScope(scope)).pullPages.length, 0);
    fixture.store.close();
  });

  test('fails closed when Pull transport authority is missing or effect endpoints diverge', async () => {
    const missing = await setup();
    const { endpoints: _endpoints, credential: _credential, ...withoutTransport } = missing.options;
    await assert.rejects(() => createPullApplier(withoutTransport).pull('cursor-old'), /pull_transport_unavailable/);
    const mismatched = createPullApplier({ ...missing.options,
      endpoints: { ...missing.options.endpoints, syncEffectPages: 'https://known.example/other/{effectId}/{pageNumber}' } });
    await assert.rejects(() => mismatched.pull('cursor-old'), /effect_endpoint_binding_invalid/);
    missing.store.close();
  });

  test('rejects non-success, invalid and over-budget Pull responses without durable effects', async () => {
    for (const response of [
      new Response(null, { status: 503 }),
      Response.json({}),
      Response.json({ ...emptyPage('cursor-old'), padding: 'x'.repeat(256) }),
    ]) {
      const fixture = await setup({ fetch: async () => response,
        transportBudget: { pullResponseBytes: 128, snapshotPageBytes: 128,
          effectPageBytes: 128, effectAggregateBytes: 512 } });
      await assert.rejects(() => fixture.applier.pull('cursor-old'), /pull_failed|pull_page_invalid/);
      assert.equal((await fixture.store.exportScope(scope)).pullPages.length, 0);
      fixture.store.close();
    }
  });
});

function emptyPage(nextCursor: string) {
  return pullFixtures.page({ events: [], nextCursor, collectionRevision: 'revision-old' });
}

async function setup(overrides: { readonly fetch?: typeof fetch;
  readonly transportBudget?: { readonly pullResponseBytes: number; readonly snapshotPageBytes: number;
    readonly effectPageBytes: number; readonly effectAggregateBytes: number } } = {}) {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-stager',
    expiresAt: Date.parse('2099-01-01T00:00:00Z') }, checkpoint: {
    serverRevision: 'revision-old', cursor: 'cursor-old' }, selectedRoots: [], rootStatus: 'ready' });
  const api: PullBookmarkApi = {
    async create() { return { id: 'created' }; }, async update() {}, async move() {}, async remove() {},
    async removeTree() {}, async get() { return []; }, async getChildren() { return []; },
  };
  const options = { scope, store, api, session: { acceptedProtocolVersion: '0.2' as const,
    sessionId: 'session-stager', collectionId: scope.collectionId,
    conversionPolicy: { separator: 'preserve_remote' as const }, ...(overrides.transportBudget
      ? { transportBudget: overrides.transportBudget } : {}) },
    endpoints: { syncPull: 'https://known.example/pull', syncEffectPages: effectPageTemplate },
    credential: { accessToken: 'access-token' }, origin: 'chrome-extension://extension-id',
    effectPageTemplate, effectPageAuthority: 'https://known.example', ...(overrides.fetch ? { fetch: overrides.fetch } : {}) };
  return { store, options, applier: createPullApplier(options) };
}
