import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { assertProductErrorEnvelope } from '../../support/product-http-harness.js';
import {
  NOW, ROUTE, harness, row,
} from '../../support/classify-inbox-http-harness.js';

describe('GET /api/v1/me/classify-inbox', () => {
  test('anonymous requests are 401 with private no-store', async () => {
    const { app } = await harness({ enabled: true });
    const response = await app.inject({ method: 'GET', url: ROUTE });
    assertProductErrorEnvelope(response, 401, 'authentication_required');
    assert.equal(response.headers['cache-control'], 'private, no-store');
  });

  test('flag off returns 404 resource_not_found while the operation stays mounted', async () => {
    const { app, owner } = await harness({ enabled: false });
    const routes = app.printRoutes();
    assert.match(routes, /classify-inbox/u);
    const response = await app.inject({
      method: 'GET', url: ROUTE, headers: { cookie: owner.cookie },
    });
    assertProductErrorEnvelope(response, 404, 'resource_not_found');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.notEqual(response.json().error?.code, 'feature_temporarily_unavailable');
  });

  test('owner 200 lists root bookmarks with required fields and omits outsiders', async () => {
    const { app, owner } = await harness({
      enabled: true,
      bookmarks: [
        row('node-a', { title: 'Design systems', url: 'https://system.example.com/essay' }),
        row('node-secret', { owner: 'outsider', collectionId: 'col-other' }),
        row('node-nested', { parentKind: 'folder' }),
        row('node-done', { hasSidecar: true }),
      ],
    });
    const response = await app.inject({
      method: 'GET', url: ROUTE, headers: { cookie: owner.cookie },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    const body = response.json() as {
      items: Array<{
        nodeId: string;
        collectionId: string;
        collectionTitle: string;
        title: string;
        url: string;
        host: string;
        etag: string;
        createdAt: string;
        suggestions: Array<{
          suggestionId: string;
          folderId: string;
          folderTitle: string;
          score: number;
          reason: string;
          kind: string;
        }>;
      }>;
      nextCursor: string | null;
    };
    assert.deepEqual(Object.keys(body).sort(), ['items', 'nextCursor']);
    assert.deepEqual(body.items.map((item) => item.nodeId), ['node-a']);
    const item = body.items[0];
    assert.ok(item);
    assert.equal(item.collectionId, 'col-1');
    assert.equal(item.collectionTitle, 'Inbox library');
    assert.equal(item.title, 'Design systems');
    assert.equal(item.url, 'https://system.example.com/essay');
    assert.equal(item.host, 'system.example.com');
    assert.equal(item.etag, '"rev-node-a"');
    assert.equal(item.createdAt, '2026-08-24T08:00:00Z');
    assert.equal(Object.hasOwn(item, 'revision'), false);
    assert.ok(item.suggestions.length >= 1);
    assert.equal(item.suggestions[0]?.kind, 'existing');
    assert.equal(item.suggestions[0]?.suggestionId, item.suggestions[0]?.folderId);
    assert.match(item.suggestions[0]?.reason ?? '', /Title\/host overlap with "/u);
    assert.equal(body.nextCursor, null);
  });

  test('unknown query, oversize limit, and cursor+limit are invalid_query', async () => {
    const { app, owner } = await harness({ enabled: true, bookmarks: [row('node-a')] });
    const unknown = await app.inject({
      method: 'GET', url: `${ROUTE}?foo=1`, headers: { cookie: owner.cookie },
    });
    assertProductErrorEnvelope(unknown, 400, 'invalid_query');
    const oversize = await app.inject({
      method: 'GET', url: `${ROUTE}?limit=51`, headers: { cookie: owner.cookie },
    });
    assertProductErrorEnvelope(oversize, 400, 'invalid_query');
    const together = await app.inject({
      method: 'GET', url: `${ROUTE}?limit=1&cursor=x`, headers: { cookie: owner.cookie },
    });
    assertProductErrorEnvelope(together, 400, 'invalid_query');
  });

  test('first page accepts limit; continuation is cursor only', async () => {
    const { app, owner, signer } = await harness({
      enabled: true,
      bookmarks: [
        row('node-b', { createdAt: new Date('2026-08-24T07:00:00.000Z') }),
        row('node-a', { createdAt: new Date('2026-08-24T09:00:00.000Z') }),
      ],
    });
    const first = await app.inject({
      method: 'GET', url: `${ROUTE}?limit=1`, headers: { cookie: owner.cookie },
    });
    assert.equal(first.statusCode, 200);
    const body = first.json() as { items: Array<{ nodeId: string }>; nextCursor: string | null };
    assert.deepEqual(body.items.map((item) => item.nodeId), ['node-a']);
    assert.ok(body.nextCursor);
    const payload = signer.verify(body.nextCursor, NOW);
    assert.equal(payload.purpose, 'classify_inbox_v1');
    const continued = await app.inject({
      method: 'GET',
      url: `${ROUTE}?cursor=${encodeURIComponent(body.nextCursor)}`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(continued.statusCode, 200);
    assert.deepEqual(
      (continued.json() as { items: Array<{ nodeId: string }> }).items.map((item) => item.nodeId),
      ['node-b'],
    );
  });
});
