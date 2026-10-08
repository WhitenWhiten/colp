/**
 * BF-03: Product DELETE/tombstone and extension helper Fastify contract.
 *
 * Injected R2 DELETE failure still commits; helper Bearer is isolated from
 * Session CSRF; helper in-progress is 429 rate_limited.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { strongEntityTag } from '../../../src/modules/collections/index.js';
import {
  assertProductErrorEnvelope,
  productCommandReceiptKey,
} from '../../support/product-http-harness.js';
import {
  BOOKMARK_B_ID,
  BOOKMARK_ID,
  BOOKMARK_REV,
  COLLECTION_ID,
  COMMAND_A,
  COMMAND_B,
  COMMAND_C,
  CONTENT_REV,
  EDITOR_BEARER,
  EXTENSION_ORIGIN,
  FOLDER_ID,
  FOLDER_REV,
  HELPER_POLICY_REVISION,
  ICO,
  OWNER_BEARER,
  PNG,
  PRODUCT_ORIGIN,
  closeFaviconHttpApps,
  createHarness,
  faviconHttpApps,
  helperCaptureFingerprint,
  helperFaviconUrl,
  helperSourceEtag,
  issueOwned,
  productFaviconUrl,
  seedBookmark,
  seedCollection,
  seedFolder,
  sessionHeaders,
} from '../../support/bookmark-favicon-http-harness.js';

afterEach(closeFaviconHttpApps);

describe('BF-03 bookmark favicon HTTP (delete and helper)', () => {
  test('upload-replace retires the previous object with retention instead of an immediate R2 delete', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-orphan', 'ownorphn');
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
    const firstUrl = (first.json() as { iconUrl: string }).iconUrl;
    const firstObjectId = firstUrl.split('/').at(-1) ?? '';
    harness.faviconStore.deleteFails = true;

    const second = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(),
      headers: sessionHeaders(harness, owner, {
        'content-type': 'image/x-icon',
        'known-command-id': COMMAND_B,
      }),
      payload: ICO,
    });
    assert.equal(second.statusCode, 200, second.body);
    const secondUrl = (second.json() as { iconUrl: string }).iconUrl;
    assert.notEqual(secondUrl, firstUrl);
    assert.equal(harness.collectionsState.bookmarkIcons.size, 1);
    const bound = [...harness.collectionsState.bookmarkIcons.values()][0]!;
    assert.equal(`${PRODUCT_ORIGIN}/api/v1/favicon/${bound.objectId}`, secondUrl);
    assert.equal(bound.contentType, 'image/x-icon');
    // The displaced object is retained for asynchronous GC, while the public
    // route revokes its binding immediately.
    assert.equal(harness.faviconStore.deletes.length, 0);
    assert.ok(harness.faviconStore.objects.has(firstObjectId), 'old object still served during retention');
    const retired = harness.collectionsState.faviconPendingDeletions.get(firstObjectId);
    assert.ok(retired, 'the replaced upload enters the durable GC retirement ledger');
    assert.ok(retired.deletableAt.getTime() > retired.retiredAt.getTime(),
      'retention window protects asynchronous object cleanup');
    assert.ok(harness.collectionsState.bookmarkIcons.has(BOOKMARK_ID));
  });

  test('DELETE with no icon is exact-replay success with no R2 side effects', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-delnone', 'owndelno');
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedBookmark(harness);

    const headers = sessionHeaders(harness, owner, { 'known-command-id': COMMAND_A });
    const first = await harness.app.inject({
      method: 'DELETE',
      url: productFaviconUrl(),
      headers,
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal((first.json() as { iconUrl: null }).iconUrl, null);
    assert.equal(first.headers['cache-control'], 'private, no-store');
    assert.equal(harness.faviconStore.deletes.length, 0);
    const puts = harness.faviconStore.puts.length;

    const second = await harness.app.inject({
      method: 'DELETE',
      url: productFaviconUrl(),
      headers,
    });
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json(), first.json());
    assert.equal(harness.faviconStore.deletes.length, 0);
    assert.equal(harness.faviconStore.puts.length, puts);
  });

  test('DELETE after upload clears iconUrl and the bookmark_icons row', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-delrow', 'owndelrw');
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
    assert.equal(harness.collectionsState.bookmarkIcons.size, 1);
    const objectId = [...harness.collectionsState.bookmarkIcons.values()][0]!.objectId;

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: productFaviconUrl(),
      headers: sessionHeaders(harness, owner, { 'known-command-id': COMMAND_B }),
    });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal((deleted.json() as { iconUrl: null }).iconUrl, null);
    assert.equal((deleted.json() as { revision: string }).revision, BOOKMARK_REV);
    assert.equal(harness.collectionsState.bookmarkIcons.size, 0);
    // The retired upload enters the durable GC ledger; the object stays
    // served through its retention window (never an immediate delete).
    assert.equal(harness.faviconStore.deletes.length, 0);
    assert.ok(harness.collectionsState.faviconPendingDeletions.has(objectId));
    assert.ok(harness.faviconStore.objects.has(objectId));
  });

  test('Product node delete drops the icon row via shared persistence', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-tomb', 'owntomb1');
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
    assert.equal(harness.collectionsState.bookmarkIcons.size, 1);

    const tombstone = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${COLLECTION_ID}/nodes/${BOOKMARK_ID}`,
      headers: sessionHeaders(harness, owner, {
        'known-command-id': COMMAND_B,
        'if-match': strongEntityTag(BOOKMARK_REV),
      }),
    });
    assert.equal(tombstone.statusCode, 200, tombstone.body);
    assert.ok(harness.collectionsState.nodes.get(BOOKMARK_ID)!.deletedAt instanceof Date);
    assert.equal(harness.collectionsState.bookmarkIcons.size, 0);
  });

  test('Product recursive folder delete drops descendant bookmark icon rows', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-rec', 'ownrec1');
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedFolder(harness);
    seedBookmark(harness, { id: BOOKMARK_B_ID, parentId: FOLDER_ID, positionToken: 'B' });

    const uploaded = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(COLLECTION_ID, BOOKMARK_B_ID),
      headers: sessionHeaders(harness, owner, {
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
      }),
      payload: PNG,
    });
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    assert.equal(harness.collectionsState.bookmarkIcons.has(BOOKMARK_B_ID), true);

    const tombstone = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${COLLECTION_ID}/nodes/${FOLDER_ID}?recursive=true`,
      headers: sessionHeaders(harness, owner, {
        'known-command-id': COMMAND_B,
        'if-match': strongEntityTag(FOLDER_REV),
        'if-content-match': strongEntityTag(CONTENT_REV),
      }),
    });
    assert.equal(tombstone.statusCode, 200, tombstone.body);
    assert.ok(harness.collectionsState.nodes.get(FOLDER_ID)!.deletedAt instanceof Date);
    assert.ok(harness.collectionsState.nodes.get(BOOKMARK_B_ID)!.deletedAt instanceof Date);
    assert.equal(harness.collectionsState.bookmarkIcons.has(BOOKMARK_B_ID), false);
  });

  test('helper capture POST uploads with Bearer + etag + policy revision and the helper-route fingerprint', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const issued = await issueOwned(harness, 'owner-help', 'ownhelp1');
    harness.extensionSubjects[OWNER_BEARER] = issued.subjectId;
    seedCollection(harness, { ownerSubjectId: issued.subjectId });
    seedBookmark(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: helperFaviconUrl(),
      headers: {
        origin: EXTENSION_ORIGIN,
        authorization: `Bearer ${OWNER_BEARER}`,
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
        'if-match': helperSourceEtag(),
        'known-favicon-policy-revision': HELPER_POLICY_REVISION,
      },
      payload: PNG,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((response.json() as { kind: string }).kind, 'bookmark');
    assert.match((response.json() as { iconUrl: string }).iconUrl, /\/api\/v1\/favicon\//);
    assert.equal(harness.collectionsState.bookmarkIcons.size, 1);

    const fingerprint = helperCaptureFingerprint(PNG, 'image/png');
    const key = productCommandReceiptKey({
      principalId: issued.accountId,
      commandScope: `collection:${COLLECTION_ID}:node:${BOOKMARK_ID}:favicon:helper-capture`,
      commandId: COMMAND_A,
    });
    const receipt = harness.collectionsState.receipts.get(key);
    assert.ok(receipt);
    assert.equal(receipt.fingerprint, fingerprint);
    // The response ETag is snapshotted into the receipt at write time (the
    // memory source port returns revision 2 for the first CAS write).
    assert.equal(response.headers['etag'], `"favicon-source:${BOOKMARK_REV}:2"`);
    assert.equal(receipt.result?.stableHeaders['etag'], response.headers['etag']);
  });

  test('helper receipt replay restores the stored ETag and never recomputes it', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-hetag', 'ownhetag');
    harness.extensionSubjects[OWNER_BEARER] = owner.subjectId;
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedBookmark(harness);
    const headers = {
      origin: EXTENSION_ORIGIN,
      authorization: `Bearer ${OWNER_BEARER}`,
      'content-type': 'image/png',
      'known-command-id': COMMAND_A,
      'if-match': helperSourceEtag(),
      'known-favicon-policy-revision': HELPER_POLICY_REVISION,
    };
    const first = await harness.app.inject({
      method: 'POST', url: helperFaviconUrl(), headers, payload: PNG,
    });
    assert.equal(first.statusCode, 200, first.body);
    const storedEtag = first.headers['etag'];
    assert.equal(storedEtag, `"favicon-source:${BOOKMARK_REV}:2"`);

    // A later mutation moves the node revision forward: a live recompute
    // would now produce "favicon-source:bookmark-res-9:1" (the memory source
    // read port has no row, so it pins the virtual revision 1).
    harness.collectionsState.nodes.get(BOOKMARK_ID)!.resourceRevision = 'bookmark-res-9';
    const replay = await harness.app.inject({
      method: 'POST', url: helperFaviconUrl(), headers, payload: PNG,
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), first.json());
    assert.equal(replay.headers['etag'], storedEtag,
      'replay must restore the write-time ETag, never a live recompute');

    // A purged node cannot be reprojected at all; the stored receipt still
    // answers with its snapshotted ETag.
    harness.collectionsState.nodes.delete(BOOKMARK_ID);
    const purgedReplay = await harness.app.inject({
      method: 'POST', url: helperFaviconUrl(), headers, payload: PNG,
    });
    assert.equal(purgedReplay.statusCode, 200, purgedReplay.body);
    assert.equal(purgedReplay.headers['etag'], storedEtag,
      'replay of a purged node must still carry the stored ETag');
  });

  test('helper replay of a pre-snapshot receipt falls back to the live ETag recompute', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-hleg', 'ownhleg');
    harness.extensionSubjects[OWNER_BEARER] = owner.subjectId;
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedBookmark(harness);
    // Receipts written before the ETag snapshot (still inside their TTL)
    // have no stored etag; replaying them recomputes the composite tag live.
    const legacyBody = Buffer.from(
      JSON.stringify({ id: BOOKMARK_ID, collectionId: COLLECTION_ID, kind: 'bookmark' }),
      'utf8',
    );
    harness.collectionsState.receipts.set(
      productCommandReceiptKey({
        principalId: owner.accountId,
        commandScope: `collection:${COLLECTION_ID}:node:${BOOKMARK_ID}:favicon:helper-capture`,
        commandId: COMMAND_A,
      }),
      {
        fingerprint: helperCaptureFingerprint(PNG, 'image/png'),
        status: 'completed',
        result: {
          status: 200,
          body: legacyBody,
          stableHeaders: {
            'cache-control': 'private, no-store',
            'content-type': 'application/json',
          },
          mediaType: 'application/json',
          contractVersion: '1.0.0',
          targetIdentity: BOOKMARK_ID,
        },
      },
    );
    const replay = await harness.app.inject({
      method: 'POST',
      url: helperFaviconUrl(),
      headers: {
        origin: EXTENSION_ORIGIN,
        authorization: `Bearer ${OWNER_BEARER}`,
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
        'if-match': helperSourceEtag(),
        'known-favicon-policy-revision': HELPER_POLICY_REVISION,
      },
      payload: PNG,
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), { id: BOOKMARK_ID, collectionId: COLLECTION_ID, kind: 'bookmark' });
    assert.equal(replay.headers['etag'], helperSourceEtag(),
      'legacy receipt without a stored etag falls back to the live recompute');
  });

  test('helper default JSON admission must not 415 a valid PNG', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-adm', 'ownadm1');
    harness.extensionSubjects[OWNER_BEARER] = owner.subjectId;
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedBookmark(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: helperFaviconUrl(),
      headers: {
        origin: EXTENSION_ORIGIN,
        authorization: `Bearer ${OWNER_BEARER}`,
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
        'if-match': helperSourceEtag(),
        'known-favicon-policy-revision': HELPER_POLICY_REVISION,
      },
      payload: PNG,
    });
    assert.notEqual(response.statusCode, 415, response.body);
    assert.equal(response.statusCode, 200, response.body);
  });

  test('helper in-progress uses the helper route fingerprint and returns 429 rate_limited', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-hprog', 'ownhprog');
    harness.extensionSubjects[OWNER_BEARER] = owner.subjectId;
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedBookmark(harness);
    harness.collectionsState.receipts.set(
      productCommandReceiptKey({
        principalId: owner.accountId,
        commandScope: `collection:${COLLECTION_ID}:node:${BOOKMARK_ID}:favicon:helper-capture`,
        commandId: COMMAND_A,
      }),
      { fingerprint: helperCaptureFingerprint(PNG, 'image/png'), status: 'in_progress' },
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: helperFaviconUrl(),
      headers: {
        origin: EXTENSION_ORIGIN,
        authorization: `Bearer ${OWNER_BEARER}`,
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
        'if-match': helperSourceEtag(),
        'known-favicon-policy-revision': HELPER_POLICY_REVISION,
      },
      payload: PNG,
    });
    assert.equal(response.statusCode, 429, response.body);
    const envelope = response.json() as { error: { code: string } };
    assert.equal(envelope.error.code, 'rate_limited');
    assert.notEqual(envelope.error.code, 'command_in_progress');
  });

  test('credential isolation: extension Origin cannot call Product POST; Web Origin cannot call helper', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-iso', 'owniso1');
    harness.extensionSubjects[OWNER_BEARER] = owner.subjectId;
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedBookmark(harness);

    const extensionOnProduct = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(),
      headers: {
        cookie: owner.cookie,
        origin: EXTENSION_ORIGIN,
        'x-csrf-token': owner.csrfToken,
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
      },
      payload: PNG,
    });
    assert.notEqual(extensionOnProduct.statusCode, 200);
    assertProductErrorEnvelope(extensionOnProduct, 403, 'csrf_failed');

    const webOnHelper = await harness.app.inject({
      method: 'POST',
      url: helperFaviconUrl(),
      headers: {
        origin: PRODUCT_ORIGIN,
        authorization: `Bearer ${OWNER_BEARER}`,
        'content-type': 'image/png',
        'known-command-id': COMMAND_B,
        'if-match': helperSourceEtag(),
        'known-favicon-policy-revision': HELPER_POLICY_REVISION,
      },
      payload: PNG,
    });
    assert.notEqual(webOnHelper.statusCode, 200);

    const helperCookieNoBearer = await harness.app.inject({
      method: 'POST',
      url: helperFaviconUrl(),
      headers: {
        origin: EXTENSION_ORIGIN,
        cookie: owner.cookie,
        'content-type': 'image/png',
        'known-command-id': COMMAND_C,
        'if-match': helperSourceEtag(),
        'known-favicon-policy-revision': HELPER_POLICY_REVISION,
      },
      payload: PNG,
    });
    assert.notEqual(helperCookieNoBearer.statusCode, 200);

    const productBearerNoCookie = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(),
      headers: {
        origin: PRODUCT_ORIGIN,
        authorization: `Bearer ${OWNER_BEARER}`,
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
      },
      payload: PNG,
    });
    assertProductErrorEnvelope(productBearerNoCookie, 401, 'authentication_required');
    assert.equal(harness.collectionsState.bookmarkIcons.size, 0);
  });

  test('helper rejects non-owner shared editors', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-hed', 'ownhed1');
    const editor = await issueOwned(harness, 'editor-hed', 'edthed1');
    harness.extensionSubjects[OWNER_BEARER] = owner.subjectId;
    harness.extensionSubjects[EDITOR_BEARER] = editor.subjectId;
    seedCollection(harness, {
      ownerSubjectId: owner.subjectId,
      memberships: [{ subjectId: editor.subjectId, role: 'editor' }],
    });
    seedBookmark(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: helperFaviconUrl(),
      headers: {
        origin: EXTENSION_ORIGIN,
        authorization: `Bearer ${EDITOR_BEARER}`,
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
        'if-match': helperSourceEtag(),
        'known-favicon-policy-revision': HELPER_POLICY_REVISION,
      },
      payload: PNG,
    });
    assertProductErrorEnvelope(response, 403, 'insufficient_permission');
    assert.equal(harness.collectionsState.bookmarkIcons.size, 0);
  });

  test('old helper queue without If-Match / policy revision is 428 precondition_required', async () => {
    const harness = createHarness();
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-428', 'own428a');
    harness.extensionSubjects[OWNER_BEARER] = owner.subjectId;
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedBookmark(harness);

    const noValidators = await harness.app.inject({
      method: 'POST',
      url: helperFaviconUrl(),
      headers: {
        origin: EXTENSION_ORIGIN,
        authorization: `Bearer ${OWNER_BEARER}`,
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
      },
      payload: PNG,
    });
    assertProductErrorEnvelope(noValidators, 428, 'precondition_required');
    assert.equal(harness.collectionsState.bookmarkIcons.size, 0);

    // A replayed old command id still needs the validators on the wire.
    const onlyEtag = await harness.app.inject({
      method: 'POST',
      url: helperFaviconUrl(),
      headers: {
        origin: EXTENSION_ORIGIN,
        authorization: `Bearer ${OWNER_BEARER}`,
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
        'if-match': helperSourceEtag(),
      },
      payload: PNG,
    });
    assertProductErrorEnvelope(onlyEtag, 428, 'precondition_required');

    // Stale policy revision is 412 precondition_failed with the current etag.
    const stalePolicy = await harness.app.inject({
      method: 'POST',
      url: helperFaviconUrl(),
      headers: {
        origin: EXTENSION_ORIGIN,
        authorization: `Bearer ${OWNER_BEARER}`,
        'content-type': 'image/png',
        'known-command-id': COMMAND_B,
        'if-match': helperSourceEtag(),
        'known-favicon-policy-revision': '7',
      },
      payload: PNG,
    });
    assert.equal(stalePolicy.statusCode, 412, stalePolicy.body);
    const precondition = stalePolicy.json() as { error: { code: string; currentEtag: string } };
    assert.equal(precondition.error.code, 'precondition_failed');
    assert.equal(precondition.error.currentEtag, '"favicon-policy:1"');
    assert.equal(harness.collectionsState.bookmarkIcons.size, 0);
  });

  test('missing faviconStore is 503 feature_temporarily_unavailable', async () => {
    const harness = createHarness({ omitFaviconStore: true });
    faviconHttpApps.push(harness.app);
    const owner = await issueOwned(harness, 'owner-503', 'own503a');
    seedCollection(harness, { ownerSubjectId: owner.subjectId });
    seedBookmark(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: productFaviconUrl(),
      headers: sessionHeaders(harness, owner, {
        'content-type': 'image/png',
        'known-command-id': COMMAND_A,
      }),
      payload: PNG,
    });
    assertProductErrorEnvelope(response, 503, 'feature_temporarily_unavailable');
  });
});
