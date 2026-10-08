import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { assertProductErrorEnvelope } from '../../support/product-http-harness.js';
import {
  NOW,
  createProductLinkHealthCursorSigner,
  getMyLinkHealthPage,
  harness,
  LinkHealthCursorError,
  LinkHealthInputError,
  row,
  type LinkHealthBookmarkUrlFact,
} from '../../support/link-health-http-harness.js';

describe('GET /api/v1/me/link-health', () => {
  test('flag off returns 404 resource_not_found while the operation stays mounted', async () => {
    const { app, owner } = await harness({ enabled: false, seeds: [] });
    const routes = app.printRoutes();
    assert.match(routes, /link-health/u);
    const response = await app.inject({
      method: 'GET', url: '/api/v1/me/link-health', headers: { cookie: owner.cookie },
    });
    assertProductErrorEnvelope(response, 404, 'resource_not_found');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.notEqual(response.json().error?.code, 'feature_temporarily_unavailable');
  });

  test('anonymous requests are 401 with private no-store', async () => {
    const { app } = await harness({ enabled: true, seeds: [] });
    const response = await app.inject({ method: 'GET', url: '/api/v1/me/link-health' });
    assertProductErrorEnvelope(response, 401, 'authentication_required');
    assert.equal(response.headers['cache-control'], 'private, no-store');
  });

  test('flag on lists owned bookmarks, marks the later same-URL row as duplicate, and omits folders and outsiders', async () => {
    const { app, owner } = await harness({
      enabled: true,
      seeds: [
        {
          owner: 'owner',
          row: row('node-a', 'col-1', 'https://example.com/shared', { createdAt: new Date('2026-08-22T07:00:00.000Z') }),
        },
        {
          owner: 'owner',
          row: row('node-b', 'col-1', 'https://EXAMPLE.com/shared', { createdAt: new Date('2026-08-22T07:01:00.000Z') }),
        },
        {
          owner: 'outsider',
          row: row('node-secret', 'col-other', 'https://example.com/secret'),
        },
      ],
    });
    const response = await app.inject({
      method: 'GET', url: '/api/v1/me/link-health',
      headers: { cookie: owner.cookie },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    const body = response.json() as {
      items: Array<{
        nodeId: string; duplicateOfNodeId: string | null; status: LinkHealthStatus; etag?: string;
        membership?: string;
      }>;
      nextCursor: string | null;
    };
    const ids = body.items.map((item) => item.nodeId);
    assert.equal(ids.includes('node-secret'), false);
    const a = body.items.find((item) => item.nodeId === 'node-a');
    const b = body.items.find((item) => item.nodeId === 'node-b');
    assert.ok(a && b);
    assert.equal(a.duplicateOfNodeId, null);
    assert.equal(b.duplicateOfNodeId, 'node-a');
    assert.equal(a.status, 'pending');
    assert.equal(a.etag, '"rev-node-a"');
    const duplicates = await app.inject({
      method: 'GET', url: '/api/v1/me/link-health?duplicate=true',
      headers: { cookie: owner.cookie },
    });
    assert.equal(duplicates.statusCode, 200);
    const dupBody = duplicates.json() as typeof body;
    assert.deepEqual(dupBody.items.map((item) => item.nodeId), ['node-b']);
    assert.equal(dupBody.items[0]?.duplicateOfNodeId, 'node-a');
    assert.equal(a.membership, 'owner');
  });

  test('serializes probe errorClass and a private duplicate_of review without leaking outsider rows', async () => {
    const { app, owner } = await harness({
      enabled: true,
      seeds: [
        {
          owner: 'owner',
          row: row('node-a', 'col-1', 'https://example.com/shared', {
            createdAt: new Date('2026-08-22T07:00:00.000Z'),
          }),
        },
        {
          owner: 'owner',
          row: row('node-b', 'col-1', 'https://example.com/shared', {
            createdAt: new Date('2026-08-22T07:01:00.000Z'),
            status: 'broken',
            errorClass: 'timeout',
            duplicateRelationId: 'rel-dup',
            duplicateRelationRevision: 'rel-r1',
          }),
        },
        {
          owner: 'outsider',
          row: row('node-secret', 'col-other', 'https://example.com/shared', {
            duplicateRelationId: 'rel-secret',
            duplicateRelationRevision: 'secret-r1',
          }),
        },
      ],
    });
    const response = await app.inject({
      method: 'GET', url: '/api/v1/me/link-health',
      headers: { cookie: owner.cookie },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      items: Array<{
        nodeId: string;
        errorClass?: string;
        duplicateRelationId?: string;
        duplicateRelationEtag?: string;
        duplicateOfNodeId: string | null;
      }>;
    };
    assert.equal(body.items.some((item) => item.nodeId === 'node-secret'), false);
    const reviewed = body.items.find((item) => item.nodeId === 'node-b');
    assert.ok(reviewed);
    assert.equal(reviewed.duplicateOfNodeId, 'node-a');
    assert.equal(reviewed.errorClass, 'timeout');
    assert.equal(reviewed.duplicateRelationId, 'rel-dup');
    assert.equal(reviewed.duplicateRelationEtag, '"rel-r1"');
  });

  test('unknown scope and unordered query are invalid_query', async () => {
    const { app, owner } = await harness({ enabled: true, seeds: [] });
    const unknown = await app.inject({
      method: 'GET', url: '/api/v1/me/link-health?scope=mine',
      headers: { cookie: owner.cookie },
    });
    assertProductErrorEnvelope(unknown, 400, 'invalid_query');
    const unordered = await app.inject({
      method: 'GET', url: '/api/v1/me/link-health?status=pending&scope=shared',
      headers: { cookie: owner.cookie },
    });
    assertProductErrorEnvelope(unordered, 400, 'invalid_query');
  });

  test('canonical scope=shared&status=pending is 200 and cursor+scope is invalid_query', async () => {
    const { app, owner, editor, signer } = await harness({
      enabled: true,
      seeds: [{
        owner: 'owner',
        row: row('node-a', 'col-1', 'https://example.com/a', { status: 'pending' }),
        members: [{ who: 'editor', role: 'editor' }],
      }],
    });
    const canonical = await app.inject({
      method: 'GET', url: '/api/v1/me/link-health?scope=shared&status=pending',
      headers: { cookie: editor.cookie },
    });
    assert.equal(canonical.statusCode, 200);
    const together = await app.inject({
      method: 'GET', url: `/api/v1/me/link-health?scope=shared&cursor=${encodeURIComponent('x')}`,
      headers: { cookie: owner.cookie },
    });
    assertProductErrorEnvelope(together, 400, 'invalid_query');
    const first = await app.inject({
      method: 'GET', url: '/api/v1/me/link-health?scope=shared&limit=1',
      headers: { cookie: editor.cookie },
    });
    assert.equal(first.statusCode, 200);
    const body = first.json() as { nextCursor: string | null };
    if (body.nextCursor) {
      const payload = signer.verify(body.nextCursor, NOW);
      assert.equal(payload.filters.scope, 'shared');
    }
  });

  test('scope=shared lists editor bookmarks, stranger is empty, owned default excludes shared-only', async () => {
    const { app, owner, editor, stranger } = await harness({
      enabled: true,
      seeds: [
        {
          owner: 'owner',
          row: row('node-owned', 'col-owned', 'https://example.com/owned'),
          members: [{ who: 'editor', role: 'editor' }, { who: 'viewer', role: 'viewer' }],
        },
        {
          owner: 'outsider',
          row: row('node-edit', 'col-edit', 'https://example.com/edit'),
          members: [{ who: 'owner', role: 'editor' }],
        },
      ],
    });
    const sharedEditor = await app.inject({
      method: 'GET', url: '/api/v1/me/link-health?scope=shared',
      headers: { cookie: editor.cookie },
    });
    assert.equal(sharedEditor.statusCode, 200);
    const editorItems = (sharedEditor.json() as { items: Array<{ nodeId: string; membership?: string }> }).items;
    assert.deepEqual(editorItems.map((item) => item.nodeId), ['node-owned']);
    assert.equal(editorItems[0]?.membership, 'editor');
    const sharedStranger = await app.inject({
      method: 'GET', url: '/api/v1/me/link-health?scope=shared',
      headers: { cookie: stranger.cookie },
    });
    assert.equal(sharedStranger.statusCode, 200);
    assert.deepEqual((sharedStranger.json() as { items: unknown[] }).items, []);
    const ownedDefault = await app.inject({
      method: 'GET', url: '/api/v1/me/link-health',
      headers: { cookie: owner.cookie },
    });
    const ownedIds = (ownedDefault.json() as { items: Array<{ nodeId: string }> }).items.map((item) => item.nodeId);
    assert.equal(ownedIds.includes('node-owned'), true);
    assert.equal(ownedIds.includes('node-edit'), false);
    const ownerShared = await app.inject({
      method: 'GET', url: '/api/v1/me/link-health?scope=shared',
      headers: { cookie: owner.cookie },
    });
    const ownerSharedIds = (ownerShared.json() as { items: Array<{ nodeId: string }> }).items.map((item) => item.nodeId);
    assert.equal(ownerSharedIds.includes('node-owned'), false);
    assert.equal(ownerSharedIds.includes('node-edit'), true);
    const all = await app.inject({
      method: 'GET', url: '/api/v1/me/link-health?scope=all',
      headers: { cookie: owner.cookie },
    });
    const allIds = (all.json() as { items: Array<{ nodeId: string }> }).items.map((item) => item.nodeId);
    assert.deepEqual([...allIds].sort(), ['node-edit', 'node-owned']);
    assert.equal(new Set(allIds).size, allIds.length);
  });

  test('old three-key cursor continuation without query.scope stays owned; shared continuation is cursor-only', async () => {
    const { app, owner, editor, signer } = await harness({
      enabled: true,
      seeds: [
        { owner: 'owner', row: row('node-a', 'col-1', 'https://example.com/a'), members: [{ who: 'editor', role: 'editor' }] },
        { owner: 'owner', row: row('node-b', 'col-1', 'https://example.com/b'), members: [{ who: 'editor', role: 'editor' }] },
      ],
    });
    const legacy = signer.sign({
      v: 1,
      purpose: 'link_health_v1',
      subjectId: owner.subjectId,
      filters: { status: null, collectionId: null, duplicate: false },
      limit: 1,
      sort: 'checked_at:asc_nulls_first,node_id:asc',
      comparatorVersion: 'checked-at-nulls-first-node-id-v1',
      after: { checkedAt: null, nodeId: 'node-a' },
      issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    const continued = await app.inject({
      method: 'GET', url: `/api/v1/me/link-health?cursor=${encodeURIComponent(legacy)}`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(continued.statusCode, 200);
    assert.deepEqual(
      (continued.json() as { items: Array<{ nodeId: string }> }).items.map((item) => item.nodeId),
      ['node-b'],
    );
    const firstShared = await app.inject({
      method: 'GET', url: '/api/v1/me/link-health?scope=shared&limit=1',
      headers: { cookie: editor.cookie },
    });
    assert.equal(firstShared.statusCode, 200);
    const sharedPage = firstShared.json() as { items: Array<{ nodeId: string }>; nextCursor: string | null };
    assert.equal(sharedPage.items[0]?.nodeId, 'node-a');
    assert.ok(sharedPage.nextCursor);
    const sharedContinued = await app.inject({
      method: 'GET', url: `/api/v1/me/link-health?cursor=${encodeURIComponent(sharedPage.nextCursor!)}`,
      headers: { cookie: editor.cookie },
    });
    assert.equal(sharedContinued.statusCode, 200);
    assert.deepEqual(
      (sharedContinued.json() as { items: Array<{ nodeId: string }> }).items.map((item) => item.nodeId),
      ['node-b'],
    );
  });
});

test('getMyLinkHealthPage computes duplicates with the shared normalizer', async () => {
  const facts: LinkHealthBookmarkUrlFact[] = [
    { nodeId: 'old', collectionId: 'c1', url: 'https://example.com/x/', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    { nodeId: 'new', collectionId: 'c1', url: 'https://example.com/x', createdAt: new Date('2026-01-02T00:00:00.000Z') },
  ];
  const signer = createProductLinkHealthCursorSigner({
    current: { id: 'lh-use-v1', key: 'link-health-use-cursor-secret-material' },
  });
  const page = await getMyLinkHealthPage({
    reads: {
      async listOwnedBookmarkUrlFacts() { return facts; },
      async listLinkHealth() {
        return facts.map((fact) => ({
          nodeId: fact.nodeId, collectionId: fact.collectionId, collectionTitle: 'C',
          title: fact.nodeId, url: fact.url, resourceRevision: 'r1', createdAt: fact.createdAt,
          status: 'pending' as const, httpStatus: null, finalUrl: null, checkedAt: null,
          membership: 'owner' as const, errorClass: null, duplicateRelationId: null,
          duplicateRelationRevision: null,
        }));
      },
    },
    cursors: signer,
    clock: { now: async () => NOW },
  }, { actor: { subjectId: 's1' } });
  assert.equal(page.items.find((item) => item.nodeId === 'old')?.duplicateOfNodeId, null);
  assert.equal(page.items.find((item) => item.nodeId === 'new')?.duplicateOfNodeId, 'old');
  signer.destroy();
});

test('getMyLinkHealthPage XOR rejects cursor together with scope', async () => {
  const signer = createProductLinkHealthCursorSigner({
    current: { id: 'lh-xor-v1', key: 'link-health-xor-cursor-secret-material' },
  });
  await assert.rejects(() => getMyLinkHealthPage({
    reads: {
      async listOwnedBookmarkUrlFacts() { return []; },
      async listLinkHealth() { return []; },
    },
    cursors: signer,
    clock: { now: async () => NOW },
  }, { actor: { subjectId: 's1' }, cursor: 'token', scope: 'shared' }), LinkHealthInputError);
  signer.destroy();
});

test('getMyLinkHealthPage rejects a legacy cursor when the request scope is not owned', async () => {
  const signer = createProductLinkHealthCursorSigner({
    current: { id: 'lh-legacy-v1', key: 'link-health-legacy-cursor-secret-material' },
  });
  const token = signer.sign({
    v: 1,
    purpose: 'link_health_v1',
    subjectId: 's1',
    filters: { status: null, collectionId: null, duplicate: false },
    limit: 50,
    sort: 'checked_at:asc_nulls_first,node_id:asc',
    comparatorVersion: 'checked-at-nulls-first-node-id-v1',
    after: { checkedAt: null, nodeId: 'node-a' },
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  });
  await assert.rejects(() => getMyLinkHealthPage({
    reads: {
      async listOwnedBookmarkUrlFacts() { return []; },
      async listLinkHealth() { return []; },
    },
    cursors: signer,
    clock: { now: async () => NOW },
  }, { actor: { subjectId: 's1' }, cursor: token, scope: 'shared' }), (error: unknown) => {
    return error instanceof LinkHealthInputError || error instanceof LinkHealthCursorError;
  });
  signer.destroy();
});

