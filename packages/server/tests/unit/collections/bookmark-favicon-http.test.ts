/**
 * BF-03: Product session POST/GET/PATCH Fastify contract for bookmark favicon.
 *
 * Anti-false-positive: PNG-as-ICO is served as image/png; 64KiB+1 is 413 with
 * no bound row; SVG is 415 with no row; POST does not change revision/etag;
 * in-progress is 429 rate_limited (never 409 command_in_progress); GET after
 * POST uses the real GET handler.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { PRODUCT_ROUTE_MANIFEST } from '../../../generated/openapi/product-v1.routes.js';
import {
  BOOKMARK_FAVICON_MAX_BYTES,
  strongEntityTag,
} from '../../../src/modules/collections/index.js';
import { assertProductErrorEnvelope, productCommandReceiptKey } from '../../support/product-http-harness.js';
import {
  BOOKMARK_ID,
  BOOKMARK_REV,
  COLLECTION_ID,
  COMMAND_A,
  COMMAND_B,
  COMMAND_C,
  CUR,
  EDITOR_BEARER,
  EXTENSION_ORIGIN,
  FOLDER_ID,
  ICO,
  OTHER_COLLECTION_ID,
  OWNER_BEARER,
  PNG,
  PRODUCT_ORIGIN,
  SVG,
  closeFaviconHttpApps,
  createHarness,
  faviconHttpApps,
  helperFaviconUrl,
  issueOwned,
  productFaviconUrl,
  seedBookmark,
  seedCollection,
  seedFolder,
  sessionHeaders,
  uploadFingerprint,
} from '../../support/bookmark-favicon-http-harness.js';

afterEach(closeFaviconHttpApps);

describe('BF-03 bookmark favicon HTTP (product session)', () => {
  test('helper routes are not Product OpenAPI operations', () => {
    const helperPath = '/colp/v0.1/sync/collections/{collectionId}/nodes/{nodeId}/favicon';
    assert.equal(
      PRODUCT_ROUTE_MANIFEST.some((route) => route.path === helperPath),
      false,
    );
  });

  test('401 without session on Product POST', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const response = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(),
      headers: {
        origin: PRODUCT_ORIGIN,
        'x-csrf-token': 'not-a-real-csrf-token-value____________',
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
      },
      payload: PNG,
    });
    assertProductErrorEnvelope(response, 401, 'authentication_required');
    assert.equal(harness.collectionsState.bookmarkIcons.size, 0);
  });

  test('PNG bytes declared as image/x-icon persist and GET as image/png; revision unchanged', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-png-ico', 'ownpngico');
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedBookmark(harness);
    const before = harness.collectionsState.nodes.get(BOOKMARK_ID)!;

    const response = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(),
      headers: sessionHeaders(harness, owner, {
        'content-type': 'image/x-icon',
        'known-command-id': COMMAND_A,
      }),
      payload: PNG,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    const body = response.json() as {
      kind: string;
      iconUrl: string | null;
      revision: string;
      etag: string;
      url: string;
    };
    assert.equal(body.kind, 'bookmark');
    assert.equal(typeof body.iconUrl, 'string');
    assert.match(body.iconUrl ?? '', new RegExp(`^${PRODUCT_ORIGIN}/api/v1/favicon/[a-f0-9-]{36}$`, 'i'));
    assert.equal(body.revision, BOOKMARK_REV);
    assert.equal(body.etag, strongEntityTag(BOOKMARK_REV));
    assert.equal(harness.collectionsState.nodes.get(BOOKMARK_ID)!.resourceRevision, before.resourceRevision);
    assert.equal(harness.collectionsState.nodes.get(BOOKMARK_ID)!.updatedAt.getTime(), before.updatedAt.getTime());

    const bound = [...harness.collectionsState.bookmarkIcons.values()][0];
    assert.ok(bound);
    assert.equal(bound.contentType, 'image/png');
    assert.equal(bound.nodeId, BOOKMARK_ID);
    assert.equal(bound.collectionId, COLLECTION_ID);
    assert.equal(bound.byteSize, PNG.byteLength);
    assert.equal(bound.digestSha256.byteLength, 32);

    const objectId = bound.objectId;
    const stored = harness.faviconStore.objects.get(objectId);
    assert.ok(stored);
    assert.equal(stored.contentType, 'image/png');
    assert.deepEqual(stored.body, PNG);

    const get = await harness.app.inject({ method: 'GET', url: `/api/v1/favicon/${objectId}` });
    assert.equal(get.statusCode, 200, get.body);
    assert.equal(get.headers['content-type'], 'image/png');
    assert.deepEqual(get.rawPayload, PNG);
    assert.equal(get.headers['cache-control'], 'public, max-age=30, must-revalidate');
  });

  test('PATCH title keeps the uploaded iconUrl (same-origin, not reset to null)', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-patch-icon', 'ownpatchi');
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedBookmark(harness);

    const uploaded = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(),
      headers: sessionHeaders(harness, owner, {
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
      }),
      payload: PNG,
    });
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const iconUrl = (uploaded.json() as { iconUrl: string }).iconUrl;
    assert.match(iconUrl, new RegExp(`^${PRODUCT_ORIGIN}/api/v1/favicon/[a-f0-9-]{36}$`, 'i'));

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${COLLECTION_ID}/nodes/${BOOKMARK_ID}`,
      headers: sessionHeaders(harness, owner, {
        'content-type': 'application/merge-patch+json',
        'known-command-id': COMMAND_B,
        'if-match': strongEntityTag(BOOKMARK_REV),
      }),
      payload: { title: 'Renamed after icon upload' },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    const body = patched.json() as { node: { title: string; iconUrl: string | null; kind: string } };
    assert.equal(body.node.kind, 'bookmark');
    assert.equal(body.node.title, 'Renamed after icon upload');
    assert.equal(body.node.iconUrl, iconUrl);
    assert.doesNotMatch(body.node.iconUrl ?? '', /favicon\.im|duckduckgo/i);
  });

  test('ICO magic stores image/x-icon even when declared as image/vnd.microsoft.icon', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-ico', 'ownico1');
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedBookmark(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(),
      headers: sessionHeaders(harness, owner, {
        'content-type': 'image/vnd.microsoft.icon',
        'known-command-id': COMMAND_A,
      }),
      payload: ICO,
    });
    assert.equal(response.statusCode, 200, response.body);
    const bound = [...harness.collectionsState.bookmarkIcons.values()][0];
    assert.equal(bound?.contentType, 'image/x-icon');
    const get = await harness.app.inject({ method: 'GET', url: `/api/v1/favicon/${bound!.objectId}` });
    assert.equal(get.statusCode, 200);
    assert.equal(get.headers['content-type'], 'image/x-icon');
  });

  test('64KiB+1 is 413 payload_too_large with no bookmark_icons row and no bound PUT', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-413', 'own413a');
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedBookmark(harness);
    const oversized = Buffer.concat([PNG, Buffer.alloc(BOOKMARK_FAVICON_MAX_BYTES + 1 - PNG.byteLength, 0x00)]);
    assert.equal(oversized.byteLength, BOOKMARK_FAVICON_MAX_BYTES + 1);

    const response = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(),
      headers: sessionHeaders(harness, owner, {
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
      }),
      payload: oversized,
    });
    assertProductErrorEnvelope(response, 413, 'payload_too_large');
    assert.equal(harness.collectionsState.bookmarkIcons.size, 0);
    assert.equal(harness.faviconStore.puts.length, 0);
  });

  test('declared SVG is 415 unsupported_media_type with no row', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-svg', 'ownsvg1');
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedBookmark(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(),
      headers: sessionHeaders(harness, owner, {
        'content-type': 'image/svg+xml',
        'known-command-id': COMMAND_A,
      }),
      payload: SVG,
    });
    assertProductErrorEnvelope(response, 415, 'unsupported_media_type');
    assert.equal(harness.collectionsState.bookmarkIcons.size, 0);
    assert.equal(harness.faviconStore.puts.length, 0);
  });

  test('declared GIF and HTML are 415 with no row', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-gif', 'owngif1');
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedBookmark(harness);

    for (const type of ['image/gif', 'text/html'] as const) {
      const response = await harness.app.inject({
        method: 'POST',
        url: productFaviconUrl(),
        headers: sessionHeaders(harness, owner, {
          'content-type': type,
          'known-command-id': type === 'image/gif' ? COMMAND_A : COMMAND_B,
        }),
        payload: PNG,
      });
      assertProductErrorEnvelope(response, 415, 'unsupported_media_type');
    }
    assert.equal(harness.collectionsState.bookmarkIcons.size, 0);
  });

  test('unknown magic and CUR are 400 invalid_request with no row', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-magic', 'ownmagic');
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedBookmark(harness);

    const unknown = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(),
      headers: sessionHeaders(harness, owner, {
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
      }),
      payload: Buffer.from('not-an-image'),
    });
    assertProductErrorEnvelope(unknown, 400, 'invalid_request');
    assert.notEqual(unknown.statusCode, 422);

    const cur = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(),
      headers: sessionHeaders(harness, owner, {
        'content-type': 'application/octet-stream',
        'known-command-id': COMMAND_B,
      }),
      payload: CUR,
    });
    assertProductErrorEnvelope(cur, 400, 'invalid_request');
    assert.equal(harness.collectionsState.bookmarkIcons.size, 0);
  });

  test('non-bookmark node is 400 invalid_request not 422', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-folder', 'ownfold1');
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedFolder(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(COLLECTION_ID, FOLDER_ID),
      headers: sessionHeaders(harness, owner, {
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
      }),
      payload: PNG,
    });
    assertProductErrorEnvelope(response, 400, 'invalid_request');
    assert.notEqual(response.statusCode, 422);
    const envelope = response.json() as { error: { code: string } };
    assert.notEqual(envelope.error.code, 'invalid_identity_input');
    assert.equal(harness.collectionsState.bookmarkIcons.size, 0);
  });

  test('viewer 403; stranger 404; editor 200', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-roles', 'ownroles');
    const viewer = await issueOwned(harness, 'viewer-roles', 'viewroles');
    const editor = await issueOwned(harness, 'editor-roles', 'editroles');
    const stranger = await issueOwned(harness, 'stranger-roles', 'strroles');
    seedCollection(harness, {
      ownerSubjectId: owner.subjectId,
      memberships: [
        { subjectId: viewer.subjectId, role: 'viewer' },
        { subjectId: editor.subjectId, role: 'editor' },
      ],
    });
    seedBookmark(harness);

    assertProductErrorEnvelope(
      await harness.app.inject({
        method: 'POST',
        url: productFaviconUrl(),
        headers: sessionHeaders(harness, viewer, {
          'content-type': 'image/png',
          'known-command-id': COMMAND_A,
        }),
        payload: PNG,
      }),
      403,
      'insufficient_permission',
    );
    assertProductErrorEnvelope(
      await harness.app.inject({
        method: 'POST',
        url: productFaviconUrl(),
        headers: sessionHeaders(harness, stranger, {
          'content-type': 'image/png',
          'known-command-id': COMMAND_B,
        }),
        payload: PNG,
      }),
      404,
      'resource_not_found',
    );
    const ok = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(),
      headers: sessionHeaders(harness, editor, {
        'content-type': 'image/png',
        'known-command-id': COMMAND_C,
      }),
      payload: PNG,
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((ok.json() as { kind: string }).kind, 'bookmark');
  });

  test('cross-collection node is concealed 404', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-xcol', 'ownxcol1');
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedCollection(harness, {
      ownerSubjectId: owner.subjectId,
      collectionId: OTHER_COLLECTION_ID,
      rootId: 'root-other',
    });
    seedBookmark(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(OTHER_COLLECTION_ID, BOOKMARK_ID),
      headers: sessionHeaders(harness, owner, {
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
      }),
      payload: PNG,
    });
    assertProductErrorEnvelope(response, 404, 'resource_not_found');
    assert.equal(harness.collectionsState.bookmarkIcons.size, 0);
  });

  test('POST without If-Match succeeds; exact replay returns first receipt', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-replay', 'ownrepli');
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedBookmark(harness);

    const headers = sessionHeaders(harness, owner, {
      'content-type': 'image/png',
      'known-command-id': COMMAND_A,
    });
    const first = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(),
      headers,
      payload: PNG,
    });
    assert.equal(first.statusCode, 200, first.body);
    const puts = harness.faviconStore.puts.length;
    const second = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(),
      headers,
      payload: PNG,
    });
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json(), first.json());
    assert.equal(harness.faviconStore.puts.length, puts);
    assert.equal(harness.collectionsState.bookmarkIcons.size, 1);
  });

  test('in-progress is 429 rate_limited and never 409 command_in_progress', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-prog', 'ownprog1');
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedBookmark(harness);
    const fingerprint = uploadFingerprint(PNG, 'image/png');
    harness.collectionsState.receipts.set(
      productCommandReceiptKey({
        principalId: owner.accountId,
        commandScope: `collection:${COLLECTION_ID}:node:${BOOKMARK_ID}:favicon:upload`,
        commandId: COMMAND_A,
      }),
      { fingerprint, status: 'in_progress' },
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(),
      headers: sessionHeaders(harness, owner, {
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
      }),
      payload: PNG,
    });
    assert.equal(response.statusCode, 429, response.body);
    const envelope = response.json() as { error: { code: string } };
    assert.equal(envelope.error.code, 'rate_limited');
    assert.notEqual(response.statusCode, 409);
    assert.notEqual(envelope.error.code, 'command_in_progress');
    assert.ok(response.headers['retry-after']);
    assert.equal(harness.collectionsState.bookmarkIcons.size, 0);
  });

  test('command_id_reused remains 409 when the fingerprint differs', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-reuse', 'ownreuse');
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedBookmark(harness);

    const first = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(),
      headers: sessionHeaders(harness, owner, {
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
      }),
      payload: PNG,
    });
    assert.equal(first.statusCode, 200, first.body);

    const reused = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(),
      headers: sessionHeaders(harness, owner, {
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
      }),
      payload: ICO,
    });
    assertProductErrorEnvelope(reused, 409, 'command_id_reused');
  });
});
