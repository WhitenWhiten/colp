import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'vitest';
import { assertProductErrorEnvelope } from '../../support/product-http-harness.js';
import {
  ACCEPT, FOLDER_ID, MATCH, PRODUCT_ORIGIN, ROUTE, SKIP,
  harness, mutationHeaders, row,
} from '../../support/classify-inbox-http-harness.js';

describe('POST /api/v1/me/classify-inbox/{nodeId}/skip', () => {
  test('missing CSRF is csrf_failed', async () => {
    const { app, owner } = await harness({ enabled: true, bookmarks: [row('node-a')] });
    const response = await app.inject({
      method: 'POST', url: SKIP('node-a'),
      headers: {
        cookie: owner.cookie,
        origin: PRODUCT_ORIGIN,
        'known-command-id': randomUUID(),
        'content-type': 'application/json',
      },
      payload: {},
    });
    assertProductErrorEnvelope(response, 403, 'csrf_failed');
  });

  test('missing Origin is csrf_failed', async () => {
    const { app, owner } = await harness({ enabled: true, bookmarks: [row('node-a')] });
    const response = await app.inject({
      method: 'POST', url: SKIP('node-a'),
      headers: {
        cookie: owner.cookie,
        'x-csrf-token': owner.csrfToken,
        'known-command-id': randomUUID(),
        'content-type': 'application/json',
      },
      payload: {},
    });
    assertProductErrorEnvelope(response, 403, 'csrf_failed');
  });

  test('anonymous requests are 401 before CSRF', async () => {
    const { app } = await harness({ enabled: true, bookmarks: [row('node-a')] });
    const response = await app.inject({
      method: 'POST', url: SKIP('node-a'),
      headers: { origin: PRODUCT_ORIGIN, 'content-type': 'application/json' },
      payload: {},
    });
    assertProductErrorEnvelope(response, 401, 'authentication_required');
  });

  test('same Known-Command-Id replays the first receipt without a second write', async () => {
    const { app, owner, sidecarWrites } = await harness({
      enabled: true, bookmarks: [row('node-a')],
    });
    const commandId = randomUUID();
    const first = await app.inject({
      method: 'POST', url: SKIP('node-a'),
      headers: mutationHeaders(owner, commandId), payload: {},
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['cache-control'], 'private, no-store');
    assert.deepEqual(first.json(), { nodeId: 'node-a', decision: 'skipped' });
    assert.deepEqual(sidecarWrites, ['node-a']);
    const replay = await app.inject({
      method: 'POST', url: SKIP('node-a'),
      headers: mutationHeaders(owner, commandId), payload: {},
    });
    assert.equal(replay.statusCode, first.statusCode);
    assert.equal(replay.payload, first.payload);
    assert.deepEqual(sidecarWrites, ['node-a']);
  });

  test('new command id on an already skipped item is 200 without another sidecar row', async () => {
    const { app, owner, sidecarWrites } = await harness({
      enabled: true, bookmarks: [row('node-done', { hasSidecar: true })],
    });
    const response = await app.inject({
      method: 'POST', url: SKIP('node-done'),
      headers: mutationHeaders(owner, randomUUID()), payload: {},
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { nodeId: 'node-done', decision: 'skipped' });
    assert.deepEqual(sidecarWrites, []);
  });

  test('other users nodeId is concealed as resource_not_found', async () => {
    const { app, owner, sidecarWrites } = await harness({
      enabled: true,
      bookmarks: [row('node-secret', { owner: 'outsider', collectionId: 'col-other' })],
    });
    const response = await app.inject({
      method: 'POST', url: SKIP('node-secret'),
      headers: mutationHeaders(owner, randomUUID()), payload: {},
    });
    assertProductErrorEnvelope(response, 404, 'resource_not_found');
    assert.deepEqual(sidecarWrites, []);
  });

  test('accepted and ineligible nodeIds are concealed as resource_not_found', async () => {
    const { app, owner, sidecarWrites } = await harness({
      enabled: true,
      bookmarks: [
        row('node-accepted', { sidecarStatus: 'accepted' }),
        row('node-nested', { parentKind: 'folder' }),
      ],
    });
    const accepted = await app.inject({
      method: 'POST', url: SKIP('node-accepted'),
      headers: mutationHeaders(owner, randomUUID()), payload: {},
    });
    assertProductErrorEnvelope(accepted, 404, 'resource_not_found');
    const nested = await app.inject({
      method: 'POST', url: SKIP('node-nested'),
      headers: mutationHeaders(owner, randomUUID()), payload: {},
    });
    assertProductErrorEnvelope(nested, 404, 'resource_not_found');
    assert.deepEqual(sidecarWrites, []);
  });

  test('flag off returns 404 resource_not_found while skip stays mounted', async () => {
    const { app, owner } = await harness({ enabled: false, bookmarks: [row('node-a')] });
    const routes = app.printRoutes();
    assert.match(routes, /classify-inbox/u);
    assert.match(routes, /skip/u);
    const response = await app.inject({
      method: 'POST', url: SKIP('node-a'),
      headers: mutationHeaders(owner, randomUUID()), payload: {},
    });
    assertProductErrorEnvelope(response, 404, 'resource_not_found');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.notEqual(response.json().error?.code, 'feature_temporarily_unavailable');
  });

  test('skip then GET omits the item', async () => {
    const { app, owner } = await harness({
      enabled: true, bookmarks: [row('node-a')],
    });
    const skipped = await app.inject({
      method: 'POST', url: SKIP('node-a'),
      headers: mutationHeaders(owner, randomUUID()), payload: {},
    });
    assert.equal(skipped.statusCode, 200);
    const listed = await app.inject({
      method: 'GET', url: ROUTE, headers: { cookie: owner.cookie },
    });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(
      (listed.json() as { items: Array<{ nodeId: string }> }).items.map((item) => item.nodeId),
      [],
    );
  });
});

describe('POST /api/v1/me/classify-inbox/{nodeId}/accept', () => {
  test('accepts into the suggested folder, calls move once, then GET omits the item', async () => {
    const { app, owner, acceptWrites, moveCalls } = await harness({
      enabled: true, bookmarks: [row('node-a')],
    });
    const accepted = await app.inject({
      method: 'POST', url: ACCEPT('node-a'),
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': MATCH('node-a') }),
      payload: { suggestionId: FOLDER_ID },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.headers['cache-control'], 'private, no-store');
    assert.deepEqual(accepted.json(), { nodeId: 'node-a', decision: 'accepted', folderId: FOLDER_ID });
    assert.deepEqual(acceptWrites, ['node-a']);
    assert.deepEqual(moveCalls, [{ newParentId: FOLDER_ID, afterId: null, beforeId: null }]);
    const listed = await app.inject({
      method: 'GET', url: ROUTE, headers: { cookie: owner.cookie },
    });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(
      (listed.json() as { items: Array<{ nodeId: string }> }).items.map((item) => item.nodeId),
      [],
    );
  });

  test('same Known-Command-Id replays without a second move or sidecar', async () => {
    const { app, owner, acceptWrites, moveCalls } = await harness({
      enabled: true, bookmarks: [row('node-a')],
    });
    const commandId = randomUUID();
    const headers = mutationHeaders(owner, commandId, { 'if-match': MATCH('node-a') });
    const first = await app.inject({
      method: 'POST', url: ACCEPT('node-a'), headers, payload: { suggestionId: FOLDER_ID },
    });
    const replay = await app.inject({
      method: 'POST', url: ACCEPT('node-a'), headers, payload: { suggestionId: FOLDER_ID },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(replay.statusCode, first.statusCode);
    assert.equal(replay.payload, first.payload);
    assert.deepEqual(acceptWrites, ['node-a']);
    assert.equal(moveCalls.length, 1);
  });

  test('already accepted in that folder is 200 without another move', async () => {
    const { app, owner, acceptWrites, moveCalls } = await harness({
      enabled: true,
      bookmarks: [row('node-done', {
        sidecarStatus: 'accepted', parentKind: 'folder', parentId: FOLDER_ID,
      })],
    });
    const response = await app.inject({
      method: 'POST', url: ACCEPT('node-done'),
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': MATCH('node-done') }),
      payload: { suggestionId: FOLDER_ID },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { nodeId: 'node-done', decision: 'accepted', folderId: FOLDER_ID });
    assert.deepEqual(acceptWrites, []);
    assert.equal(moveCalls.length, 0);
  });

  test('missing If-Match is 428; wrong ETag is 412; both leave no sidecar', async () => {
    const { app, owner, acceptWrites, moveCalls } = await harness({
      enabled: true, bookmarks: [row('node-a')],
    });
    const missing = await app.inject({
      method: 'POST', url: ACCEPT('node-a'),
      headers: mutationHeaders(owner, randomUUID()),
      payload: { suggestionId: FOLDER_ID },
    });
    assertProductErrorEnvelope(missing, 428, 'precondition_required');
    const stale = await app.inject({
      method: 'POST', url: ACCEPT('node-a'),
      headers: mutationHeaders(owner, randomUUID(), { 'if-match': '"stale"' }),
      payload: { suggestionId: FOLDER_ID },
    });
    assertProductErrorEnvelope(stale, 412, 'precondition_failed');
    assert.deepEqual(acceptWrites, []);
    assert.equal(moveCalls.length, 0);
  });

  test('wrong suggestion, skipped item, outsider node, and flag-off conceal as resource_not_found', async () => {
    const missingFolder = await harness({ enabled: true, bookmarks: [row('node-a')] });
    const wrong = await missingFolder.app.inject({
      method: 'POST', url: ACCEPT('node-a'),
      headers: mutationHeaders(missingFolder.owner, randomUUID(), { 'if-match': MATCH('node-a') }),
      payload: { suggestionId: 'fld-missing' },
    });
    assertProductErrorEnvelope(wrong, 404, 'resource_not_found');
    assert.deepEqual(missingFolder.acceptWrites, []);

    const skipped = await harness({
      enabled: true, bookmarks: [row('node-skip', { sidecarStatus: 'skipped' })],
    });
    const skipRes = await skipped.app.inject({
      method: 'POST', url: ACCEPT('node-skip'),
      headers: mutationHeaders(skipped.owner, randomUUID(), { 'if-match': MATCH('node-skip') }),
      payload: { suggestionId: FOLDER_ID },
    });
    assertProductErrorEnvelope(skipRes, 404, 'resource_not_found');

    const foreign = await harness({
      enabled: true,
      bookmarks: [row('node-secret', { owner: 'outsider', collectionId: 'col-other' })],
    });
    const hidden = await foreign.app.inject({
      method: 'POST', url: ACCEPT('node-secret'),
      headers: mutationHeaders(foreign.owner, randomUUID(), { 'if-match': MATCH('node-secret') }),
      payload: { suggestionId: FOLDER_ID },
    });
    assertProductErrorEnvelope(hidden, 404, 'resource_not_found');
    assert.deepEqual(foreign.acceptWrites, []);

    const off = await harness({ enabled: false, bookmarks: [row('node-a')] });
    const flagged = await off.app.inject({
      method: 'POST', url: ACCEPT('node-a'),
      headers: mutationHeaders(off.owner, randomUUID(), { 'if-match': MATCH('node-a') }),
      payload: { suggestionId: FOLDER_ID },
    });
    assertProductErrorEnvelope(flagged, 404, 'resource_not_found');
    assert.notEqual(flagged.json().error?.code, 'feature_temporarily_unavailable');
  });

  test('anonymous is 401; missing CSRF or Origin is csrf_failed', async () => {
    const { app, owner } = await harness({ enabled: true, bookmarks: [row('node-a')] });
    const anon = await app.inject({
      method: 'POST', url: ACCEPT('node-a'),
      headers: { origin: PRODUCT_ORIGIN, 'content-type': 'application/json', 'if-match': MATCH('node-a') },
      payload: { suggestionId: FOLDER_ID },
    });
    assertProductErrorEnvelope(anon, 401, 'authentication_required');
    const csrf = await app.inject({
      method: 'POST', url: ACCEPT('node-a'),
      headers: {
        cookie: owner.cookie, origin: PRODUCT_ORIGIN,
        'known-command-id': randomUUID(), 'content-type': 'application/json', 'if-match': MATCH('node-a'),
      },
      payload: { suggestionId: FOLDER_ID },
    });
    assertProductErrorEnvelope(csrf, 403, 'csrf_failed');
    const origin = await app.inject({
      method: 'POST', url: ACCEPT('node-a'),
      headers: {
        cookie: owner.cookie, 'x-csrf-token': owner.csrfToken,
        'known-command-id': randomUUID(), 'content-type': 'application/json', 'if-match': MATCH('node-a'),
      },
      payload: { suggestionId: FOLDER_ID },
    });
    assertProductErrorEnvelope(origin, 403, 'csrf_failed');
  });
});
