/**
 * P1-06 editor page query — product editor cursor signer key rotation.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'vitest';
import { canonicalJson } from '../../../src/modules/commands/index.js';
import {
  EditorCursorError,
  PRODUCT_EDITOR_COMPARATOR_VERSION,
  PRODUCT_EDITOR_CURSOR_PURPOSE,
  PRODUCT_EDITOR_CURSOR_TTL_MS,
  PRODUCT_EDITOR_CURSOR_VERSION,
  createProductEditorCursorSigner,
  formatUtcDateTime,
  getCollectionEditorPage,
  type GetCollectionEditorPagePorts,
  type ProductEditorCursorPayload,
} from '../../../src/modules/collections/index.js';
import {
  COLLECTION_ID,
  CONTENT_REV,
  NOW,
  POLICY_REV,
  PRINCIPAL_OWNER,
  PRINCIPAL_VIEWER,
  ROOT_ID,
  SUBJECT_VIEWER,
  addBookmark,
  createMemoryPorts,
  createState,
  expectCode,
  ownerInput,
  query,
  seedOwnedCollection,
} from './editor-page-query-helpers.js';

// ---------------------------------------------------------------------------
// Cursor key rotation (previousKeys)
// ---------------------------------------------------------------------------

describe('createProductEditorCursorSigner: key rotation', () => {
  const PREV_KEY = 'product-editor-cursor-test-key-v0';
  const CURR_KEY = 'product-editor-cursor-test-key-v1';
  const UNKNOWN_KEY = 'product-editor-cursor-test-key-unknown';

  function samplePayload(): ProductEditorCursorPayload {
    return {
      v: PRODUCT_EDITOR_CURSOR_VERSION,
      purpose: PRODUCT_EDITOR_CURSOR_PURPOSE,
      principalId: PRINCIPAL_OWNER,
      collectionId: COLLECTION_ID,
      limit: 200,
      comparatorVersion: PRODUCT_EDITOR_COMPARATOR_VERSION,
      after: {
        parentKey: ROOT_ID,
        positionKey: '0',
        nodeId: 'bm-0',
      },
      contentRevision: CONTENT_REV,
      policyRevision: POLICY_REV,
      snapshotId: 'snap-rotation-1',
      issuedAt: formatUtcDateTime(NOW),
      expiresAt: formatUtcDateTime(new Date(NOW.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS)),
    };
  }

  function signCanonical(id: string, key: string, canonical: string): string {
    const body = Buffer.from(canonical, 'utf8').toString('base64url');
    const signed = `${id}.${body}`;
    const signature = createHmac('sha256', key).update(signed, 'utf8').digest('base64url');
    return `${signed}.${signature}`;
  }

  function signHeadLegacy(key: string, canonical: string): string {
    const body = Buffer.from(canonical, 'utf8').toString('base64url');
    const signature = createHmac('sha256', key).update(canonical, 'utf8').digest('base64url');
    return `${body}${signature}`;
  }

  function verifyWithHeadLegacyBinary(token: string, key: string): ProductEditorCursorPayload {
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    const signature = token.slice(-43);
    const body = token.slice(0, -43);
    const canonical = Buffer.from(body, 'base64url').toString('utf8');
    assert.equal(
      signature,
      createHmac('sha256', key).update(canonical, 'utf8').digest('base64url'),
    );
    return JSON.parse(canonical) as ProductEditorCursorPayload;
  }

  test('phase A emits exact HEAD bytes; phase B switches wire format without dropping live legacy cursors', () => {
    const cutoff = new Date(NOW.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS);
    const canonical = canonicalJson(samplePayload());
    const phaseA = createProductEditorCursorSigner({
      current: { id: 'key-v0', key: PREV_KEY },
      issuanceFormat: 'legacy',
      legacyAcceptUntil: cutoff.toISOString(),
    });
    const legacyToken = phaseA.sign(samplePayload());

    assert.equal(legacyToken, signHeadLegacy(PREV_KEY, canonical));
    assert.equal(verifyWithHeadLegacyBinary(legacyToken, PREV_KEY).snapshotId, 'snap-rotation-1');

    const metrics: string[] = [];
    const phaseB = createProductEditorCursorSigner({
      current: { id: 'key-v1', key: CURR_KEY },
      previous: [{
        id: 'key-v0', key: PREV_KEY,
        lastIssuedAt: NOW.toISOString(), retainUntil: cutoff.toISOString(),
      }],
      issuanceFormat: 'keyed',
      legacyAcceptUntil: cutoff.toISOString(),
    }, { observe: (metric) => metrics.push(metric) });

    assert.equal(phaseB.verify(legacyToken, new Date(cutoff.getTime() - 1)).snapshotId, 'snap-rotation-1');
    assert.throws(() => phaseB.verify(legacyToken, cutoff), EditorCursorError);
    const keyedToken = phaseB.sign(samplePayload());
    assert.match(keyedToken, /^key-v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    assert.equal(phaseB.verify(keyedToken, NOW).snapshotId, 'snap-rotation-1');
    assert.deepEqual(metrics, [
      'verified_legacy',
      'rejected_legacy_disabled',
      'issued',
      'verified_current',
    ]);
  });

  test('editor can update metadata but cannot manage publication', async () => {
    const state = createState();
    seedOwnedCollection(state);
    state.memberships.push({
      collectionId: COLLECTION_ID,
      subjectId: SUBJECT_VIEWER,
      role: 'editor',
    });

    const page = await query(state, ownerInput({
      actor: { principalId: PRINCIPAL_VIEWER, subjectId: SUBJECT_VIEWER },
    }));

    assert.equal(page.capabilities.updateCollection, true);
    assert.equal(page.capabilities.managePublication, false);
    assert.equal(page.capabilities.createNode, true);
  });

  test('legacy fallback is bounded, rejects unknown signatures, and never downgrades dotted tokens', () => {
    const cutoff = new Date(NOW.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS);
    const verifier = createProductEditorCursorSigner({
      current: { id: 'key-v1', key: CURR_KEY },
      previous: [{
        id: 'key-v0', key: PREV_KEY,
        lastIssuedAt: NOW.toISOString(), retainUntil: cutoff.toISOString(),
      }],
      legacyAcceptUntil: cutoff.toISOString(),
    });
    const unknownLegacy = signHeadLegacy(UNKNOWN_KEY, canonicalJson(samplePayload()));

    assert.throws(() => verifier.verify(unknownLegacy, NOW), EditorCursorError);
    assert.throws(() => verifier.verify(`broken.${unknownLegacy}`, NOW), EditorCursorError);
    assert.throws(() => verifier.verify(`a.b.c.extra`, NOW), EditorCursorError);
  });

  test('legacy issuance cannot outlive its acceptance deadline and keyring attempts are capped', () => {
    const cutoff = new Date(NOW.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS - 1);
    const legacySigner = createProductEditorCursorSigner({
      current: { id: 'key-v0', key: PREV_KEY },
      issuanceFormat: 'legacy',
      legacyAcceptUntil: cutoff.toISOString(),
    });
    assert.throws(() => legacySigner.sign(samplePayload()), EditorCursorError);

    assert.throws(() => createProductEditorCursorSigner({
      current: { id: 'key-v9', key: CURR_KEY },
      previous: Array.from({ length: 9 }, (_, index) => ({
        id: `key-v${index}`,
        key: `independent-product-editor-cursor-key-${index}`,
        lastIssuedAt: NOW.toISOString(),
        retainUntil: new Date(NOW.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS).toISOString(),
      })),
    }), /at most 8 previous keys/);
  });

  test('signer metadata accepts only documented canonical UTC timestamp variants', () => {
    for (const timestamp of [
      '0', '2026-07-23', '2026-07-23T00:00:00.000',
      '2026-07-23T08:00:00.000+08:00', '2026-02-30T00:00:00.000Z',
    ]) {
      assert.throws(() => createProductEditorCursorSigner({
        current: { id: 'key-v1', key: CURR_KEY },
        previous: [{
          id: 'key-v0', key: PREV_KEY,
          lastIssuedAt: timestamp,
          retainUntil: new Date(NOW.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS).toISOString(),
        }],
      }), /canonical RFC 3339 UTC/);
    }
  });

  test('sign with previous key, verify with current+previous → success', () => {
    const previousSigner = createProductEditorCursorSigner({ current: { id: 'key-v0', key: PREV_KEY } });
    const rotatedSigner = createProductEditorCursorSigner({
      current: { id: 'key-v1', key: CURR_KEY },
      previous: [{
        id: 'key-v0', key: PREV_KEY,
        lastIssuedAt: formatUtcDateTime(NOW),
        retainUntil: formatUtcDateTime(new Date(NOW.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS)),
      }],
    });

    const token = previousSigner.sign(samplePayload());
    const verified = rotatedSigner.verify(token, NOW);

    assert.equal(verified.collectionId, COLLECTION_ID);
    assert.equal(verified.principalId, PRINCIPAL_OWNER);
    assert.equal(verified.snapshotId, 'snap-rotation-1');
    assert.equal(verified.after.nodeId, 'bm-0');
  });

  test('unknown key → EditorCursorError / invalid_cursor', () => {
    const unknownSigner = createProductEditorCursorSigner({ current: { id: 'unknown', key: UNKNOWN_KEY } });
    const rotatedSigner = createProductEditorCursorSigner({
      current: { id: 'key-v1', key: CURR_KEY },
      previous: [{
        id: 'key-v0', key: PREV_KEY,
        lastIssuedAt: formatUtcDateTime(NOW),
        retainUntil: formatUtcDateTime(new Date(NOW.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS)),
      }],
    });

    const token = unknownSigner.sign(samplePayload());

    assert.throws(
      () => rotatedSigner.verify(token, NOW),
      (error: unknown) => {
        assert.ok(error instanceof EditorCursorError);
        expectCode(error, 'invalid_cursor');
        return true;
      },
    );
  });

  test('new cursors carry the current key ID and reject key-ID tampering', () => {
    const signer = createProductEditorCursorSigner({
      current: { id: 'key-v1', key: CURR_KEY },
    });
    const token = signer.sign(samplePayload());
    assert.match(token, /^key-v1\./);
    assert.equal(signer.verify(token, NOW).snapshotId, 'snap-rotation-1');

    const tamperedKeyId = token.replace(/^key-v1\./, 'unknown.');
    assert.throws(() => signer.verify(tamperedKeyId, NOW), EditorCursorError);
  });

  test('previous key fails closed after its retention window', () => {
    const previousSigner = createProductEditorCursorSigner({
      current: { id: 'key-v0', key: PREV_KEY },
    });
    const rotatedSigner = createProductEditorCursorSigner({
      current: { id: 'key-v1', key: CURR_KEY },
      previous: [{
        id: 'key-v0', key: PREV_KEY,
        lastIssuedAt: formatUtcDateTime(NOW),
        retainUntil: formatUtcDateTime(new Date(NOW.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS)),
      }],
    });
    const token = previousSigner.sign(samplePayload());
    assert.throws(
      () => rotatedSigner.verify(token, new Date(NOW.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS)),
      EditorCursorError,
    );
  });

  test('old-key issuance through the final rollout cutoff remains valid for its full absolute TTL', () => {
    const cutoff = new Date(NOW.getTime() + 60_000);
    const retainUntil = new Date(cutoff.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS);
    const previousSigner = createProductEditorCursorSigner({
      current: { id: 'key-v0', key: PREV_KEY },
    });
    const metrics: string[] = [];
    const rotatedSigner = createProductEditorCursorSigner({
      current: { id: 'key-v1', key: CURR_KEY },
      previous: [{
        id: 'key-v0', key: PREV_KEY,
        lastIssuedAt: formatUtcDateTime(cutoff),
        retainUntil: formatUtcDateTime(retainUntil),
      }],
    }, { observe: (metric) => metrics.push(metric) });
    const atCutoff = {
      ...samplePayload(),
      issuedAt: formatUtcDateTime(cutoff),
      expiresAt: formatUtcDateTime(retainUntil),
    };
    const token = previousSigner.sign(atCutoff);

    assert.equal(
      rotatedSigner.verify(token, new Date(retainUntil.getTime() - 1)).issuedAt,
      atCutoff.issuedAt,
    );
    assert.throws(() => rotatedSigner.verify(token, retainUntil), EditorCursorError);
    assert.deepEqual(metrics, ['verified_previous', 'rejected_retired_key']);
  });

  test('issuance cutoff and TTL boundaries reject tokens outside the declared window without extension', () => {
    const cutoff = new Date(NOW.getTime() + 60_000);
    const retainUntil = new Date(cutoff.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS);
    const verifier = createProductEditorCursorSigner({
      current: { id: 'key-v1', key: CURR_KEY },
      previous: [{
        id: 'key-v0', key: PREV_KEY,
        lastIssuedAt: formatUtcDateTime(cutoff),
        retainUntil: formatUtcDateTime(retainUntil),
      }],
    });
    const oneMsAfter = new Date(cutoff.getTime() + 1);
    const issuedTooLate = {
      ...samplePayload(),
      issuedAt: oneMsAfter.toISOString(),
      expiresAt: new Date(oneMsAfter.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS).toISOString(),
    };
    const extended = {
      ...samplePayload(),
      expiresAt: new Date(NOW.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS + 1).toISOString(),
    };

    assert.throws(
      () => verifier.verify(signCanonical('key-v0', PREV_KEY, canonicalJson(issuedTooLate)), NOW),
      EditorCursorError,
    );
    assert.throws(
      () => verifier.verify(signCanonical('key-v0', PREV_KEY, canonicalJson(extended)), NOW),
      EditorCursorError,
    );
  });

  test('constructor rejects duplicate secret material even when IDs differ', () => {
    assert.throws(
      () => createProductEditorCursorSigner({
        current: { id: 'key-v1', key: CURR_KEY },
        previous: [{
          id: 'key-v0', key: CURR_KEY,
          lastIssuedAt: formatUtcDateTime(NOW),
          retainUntil: formatUtcDateTime(new Date(NOW.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS)),
        }],
      }),
      /key material must not be reused/,
    );
  });

  test('every verification rejection emits exactly one documented low-cardinality metric', () => {
    const metrics: string[] = [];
    const signer = createProductEditorCursorSigner({
      current: { id: 'key-v1', key: CURR_KEY },
      previous: [{
        id: 'key-v0', key: PREV_KEY,
        lastIssuedAt: formatUtcDateTime(NOW),
        retainUntil: formatUtcDateTime(new Date(NOW.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS)),
      }],
    }, { observe: (metric) => metrics.push(metric) });
    const valid = signer.sign(samplePayload());
    metrics.length = 0;
    const invalidPayload = canonicalJson({ ...samplePayload(), purpose: 'wrong-purpose' });
    const nonCanonicalPayload = JSON.stringify(samplePayload());
    const excessiveTtlPayload = canonicalJson({
      ...samplePayload(),
      expiresAt: new Date(NOW.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS + 1).toISOString(),
    });
    const expiredPayload = canonicalJson({
      ...samplePayload(),
      issuedAt: formatUtcDateTime(new Date(NOW.getTime() - PRODUCT_EDITOR_CURSOR_TTL_MS)),
      expiresAt: formatUtcDateTime(NOW),
    });
    const cases = [
      ['not-a-token', 'rejected_malformed_token'],
      [`key-v1._.${'a'.repeat(43)}`, 'rejected_malformed_token'],
      [valid.replace(/^key-v1\./, 'unknown.'), 'rejected_unknown_key'],
      [valid.slice(0, -1) + (valid.endsWith('a') ? 'b' : 'a'), 'rejected_bad_signature'],
      [signCanonical('key-v1', CURR_KEY, '{'), 'rejected_invalid_payload'],
      [signCanonical('key-v1', CURR_KEY, invalidPayload), 'rejected_invalid_payload'],
      [signCanonical('key-v1', CURR_KEY, nonCanonicalPayload), 'rejected_invalid_payload'],
      [signCanonical('key-v1', CURR_KEY, excessiveTtlPayload), 'rejected_invalid_payload'],
      [signCanonical('key-v1', CURR_KEY, expiredPayload), 'rejected_expired'],
    ] as const;

    for (const [token, expectedMetric] of cases) {
      const before = metrics.length;
      assert.throws(() => signer.verify(token, NOW), EditorCursorError);
      assert.deepEqual(metrics.slice(before), [expectedMetric]);
    }
    assert.ok(metrics.every((metric) => !metric.includes('key-v')));
  });

  test('continuation signed under previous key still pages under rotated verifier', async () => {
    // End-to-end: first page issued with PREV_KEY; second page verified with CURR+PREV.
    const prevState = createState({ cursorKey: PREV_KEY });
    seedOwnedCollection(prevState);
    for (let i = 0; i < 3; i += 1) {
      addBookmark(prevState, {
        id: `bm-rot-${i}`,
        parentId: ROOT_ID,
        positionToken: String(i).padStart(2, '0'),
      });
    }

    const first = await query(prevState, ownerInput({ limit: 1 }));
    assert.ok(first.page.nextCursor);
    assert.equal(first.page.hasMore, true);

    const rotatedState = createState({
      now: new Date(prevState.now),
      collection: prevState.collection,
      root: prevState.root,
      nodes: prevState.nodes.slice(),
      memberships: prevState.memberships.slice(),
      cursorKey: CURR_KEY,
    });

    const rotatedPorts: GetCollectionEditorPagePorts = {
      ...createMemoryPorts(rotatedState),
      cursorSigner: createProductEditorCursorSigner({
        current: { id: 'key-v1', key: CURR_KEY },
        previous: [{
          id: 'test-v1', key: PREV_KEY,
          lastIssuedAt: formatUtcDateTime(NOW),
          retainUntil: formatUtcDateTime(new Date(NOW.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS)),
        }],
      }),
    };

    const second = await getCollectionEditorPage(
      rotatedPorts,
      ownerInput({ cursor: first.page.nextCursor! }),
    );
    assert.equal(second.nodes.length, 1);
    assert.equal(second.page.snapshotId, first.page.snapshotId);
    assert.ok(!first.nodes.some((n) => n.id === second.nodes[0]!.id));
  });
});
