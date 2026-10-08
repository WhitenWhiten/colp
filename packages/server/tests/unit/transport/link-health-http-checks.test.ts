import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'vitest';
import { assertProductErrorEnvelope } from '../../support/product-http-harness.js';
import {
  NOW,
  createFixedWindowRateLimiter,
  harness,
  mutationHeaders,
  row,
} from '../../support/link-health-http-harness.js';

describe('POST /api/v1/me/link-health/checks', () => {
  const CHECKS = '/api/v1/me/link-health/checks';

  test('flag off returns 404 resource_not_found after auth while POST stays mounted', async () => {
    const { app, owner } = await harness({ enabled: false, seeds: [] });
    const routes = app.printRoutes();
    assert.match(routes, /link-health \(GET, HEAD\)/u);
    assert.match(routes, /\/checks \(POST\)/u);
    const response = await app.inject({
      method: 'POST', url: CHECKS, headers: mutationHeaders(owner, randomUUID()), payload: {},
    });
    assertProductErrorEnvelope(response, 404, 'resource_not_found');
    assert.equal(response.headers['cache-control'], 'private, no-store');
  });

  test('anonymous requests are 401 before CSRF', async () => {
    const { app } = await harness({ enabled: true, seeds: [] });
    const response = await app.inject({
      method: 'POST', url: CHECKS,
      headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      payload: {},
    });
    assertProductErrorEnvelope(response, 401, 'authentication_required');
  });

  test('missing CSRF is csrf_failed', async () => {
    const { app, owner } = await harness({ enabled: true, seeds: [] });
    const response = await app.inject({
      method: 'POST', url: CHECKS,
      headers: {
        cookie: owner.cookie,
        origin: 'https://app.example.test',
        'known-command-id': randomUUID(),
        'content-type': 'application/json',
      },
      payload: {},
    });
    assertProductErrorEnvelope(response, 403, 'csrf_failed');
  });

  test('empty body marks only this owner pending and skips foreign ids', async () => {
    const { app, owner, healthRows } = await harness({
      enabled: true,
      seeds: [
        {
          owner: 'owner',
          row: row('node-a', 'col-1', 'https://bookmarks.test/a', {
            status: 'healthy', httpStatus: 200, checkedAt: NOW,
          }),
        },
        {
          owner: 'owner',
          row: row('node-b', 'col-1', 'https://bookmarks.test/b', { status: 'broken' }),
        },
        {
          owner: 'outsider',
          row: row('node-secret', 'col-other', 'https://bookmarks.test/secret', {
            status: 'healthy', httpStatus: 200, checkedAt: NOW,
          }),
        },
      ],
    });
    const response = await app.inject({
      method: 'POST', url: CHECKS, headers: mutationHeaders(owner, randomUUID()), payload: {},
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.deepEqual(response.json(), { queued: 2 });
    const ownerRows = healthRows.filter((item) => item.nodeId !== 'node-secret');
    assert.equal(ownerRows.every((item) => item.status === 'pending' && item.checkedAt === null), true);
    const secret = healthRows.find((item) => item.nodeId === 'node-secret');
    assert.equal(secret?.status, 'healthy');
    assert.equal(secret?.checkedAt?.getTime(), NOW.getTime());
    const skipped = await app.inject({
      method: 'POST', url: CHECKS, headers: mutationHeaders(owner, randomUUID()),
      payload: { nodeIds: ['node-secret', 'unknown-node'] },
    });
    assert.equal(skipped.statusCode, 200);
    assert.deepEqual(skipped.json(), { queued: 0 });
    assert.equal(healthRows.find((item) => item.nodeId === 'node-secret')?.status, 'healthy');
  });

  test('same Known-Command-Id replays the first receipt without a second write', async () => {
    const { app, owner, healthRows } = await harness({
      enabled: true,
      seeds: [{ owner: 'owner', row: row('node-a', 'col-1', 'https://bookmarks.test/a') }],
    });
    const commandId = randomUUID();
    const first = await app.inject({
      method: 'POST', url: CHECKS, headers: mutationHeaders(owner, commandId), payload: {},
    });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), { queued: 1 });
    healthRows[0]!.status = 'healthy';
    healthRows[0]!.checkedAt = NOW;
    const replay = await app.inject({
      method: 'POST', url: CHECKS, headers: mutationHeaders(owner, commandId), payload: {},
    });
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json(), { queued: 1 });
    assert.equal(replay.headers['cache-control'], 'private, no-store');
    assert.equal(healthRows[0]?.status, 'healthy');
  });

  test('injected limiter returns 429 rate_limited', async () => {
    const { app, owner } = await harness({
      enabled: true,
      seeds: [],
      rateLimiter: createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    const allowed = await app.inject({
      method: 'POST', url: CHECKS, headers: mutationHeaders(owner, randomUUID()), payload: {},
    });
    assert.equal(allowed.statusCode, 200);
    const limited = await app.inject({
      method: 'POST', url: CHECKS, headers: mutationHeaders(owner, randomUUID()), payload: {},
    });
    assertProductErrorEnvelope(limited, 429, 'rate_limited');
  });

  test('viewer POST with shared collectionId does not mark pending; editor POST does', async () => {
    const { app, editor, viewer, healthRows } = await harness({
      enabled: true,
      seeds: [{
        owner: 'owner',
        row: row('node-a', 'col-1', 'https://bookmarks.test/a', {
          status: 'healthy', httpStatus: 200, checkedAt: NOW,
        }),
        members: [{ who: 'editor', role: 'editor' }, { who: 'viewer', role: 'viewer' }],
      }],
    });
    const viewerPost = await app.inject({
      method: 'POST', url: CHECKS, headers: mutationHeaders(viewer, randomUUID()),
      payload: { collectionId: 'col-1' },
    });
    assert.equal(viewerPost.statusCode, 200);
    assert.deepEqual(viewerPost.json(), { queued: 0 });
    assert.equal(healthRows[0]?.status, 'healthy');
    const editorPost = await app.inject({
      method: 'POST', url: CHECKS, headers: mutationHeaders(editor, randomUUID()),
      payload: { collectionId: 'col-1' },
    });
    assert.equal(editorPost.statusCode, 200);
    assert.deepEqual(editorPost.json(), { queued: 1 });
    assert.equal(healthRows[0]?.status, 'pending');
    assert.equal(healthRows[0]?.checkedAt, null);
  });
});
