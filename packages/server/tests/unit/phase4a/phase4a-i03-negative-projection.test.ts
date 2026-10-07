import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  NO_PROJECTION_SURFACE,
  PROJECTION_KINDS,
  STORED_PRIVATE_MEANING,
  assertNoProjectionSurface,
  assertStoredPrivateEvidenceShape,
  assertStoredPrivateMeaning,
  projectPrivateObject,
} from '../../../scripts/evidence/phase4a-i03-negative-projection.js';
import type { ProjectionAttempt, ProjectionKind } from '../../../scripts/evidence/phase4a-i03-negative-projection.js';
import { sanitizeEvidence } from '../../../scripts/evidence/phase4a-i02-upload-probe.js';
import { createDeliveryHost } from '../../../scripts/evidence/phase4a-i03-delivery-host.js';
import {
  FixturePrivateStore,
  activeHtmlBytes,
  pdfBytes,
  randomCapabilityId,
} from '../../support/phase4a-i03-test-helpers.js';

const FIXTURE_ROOT = resolve('tests/fixtures/phase4a');
const OWNER = 'subject:owner-1';
const BLOB_ID = '018f6f7a-8f2a-7a3d-a123-123456789101';
const GENERATION_ID = '018f6f7a-8f2a-7a3d-a123-123456789102';

function seededPrivateStore(): FixturePrivateStore {
  const store = new FixturePrivateStore();
  store.seed({
    blobId: BLOB_ID,
    generationId: GENERATION_ID,
    ownerSubject: OWNER,
    bytes: activeHtmlBytes('projection-seed-marker'),
    mediaType: 'text/html',
    category: 'suspicious',
    etag: '"i03-etag-projection"',
  });
  return store;
}

function attempt(kind: ProjectionKind, overrides: Partial<ProjectionAttempt> = {}): ProjectionAttempt {
  return {
    kind,
    blobId: BLOB_ID,
    generationId: GENERATION_ID,
    requesterSubject: OWNER,
    ...overrides,
  };
}

describe('P4A-I03 negative projection contract (Publication/Sync/MCP/search/Profile)', () => {
  test('pins the frozen no-projection surface and stored_private meaning against the fixture', async () => {
    const fixture = JSON.parse(await readFile(resolve(FIXTURE_ROOT, 'i03-contract.json'), 'utf8')) as {
      storedPrivateMeaning: {
        state: string; clean: boolean; safe: boolean; ready: boolean; scanned: boolean;
        exposureMode: string; noProjection: Record<string, boolean>;
      };
    };
    assert.equal(STORED_PRIVATE_MEANING.state, fixture.storedPrivateMeaning.state);
    assert.equal(STORED_PRIVATE_MEANING.clean, false);
    assert.equal(STORED_PRIVATE_MEANING.safe, false);
    assert.equal(STORED_PRIVATE_MEANING.ready, false);
    assert.equal(STORED_PRIVATE_MEANING.scanned, false);
    assert.equal(STORED_PRIVATE_MEANING.exposureMode, fixture.storedPrivateMeaning.exposureMode);
    assert.deepEqual(NO_PROJECTION_SURFACE, fixture.storedPrivateMeaning.noProjection);
    assert.deepEqual(STORED_PRIVATE_MEANING.noProjection, NO_PROJECTION_SURFACE);
    for (const kind of PROJECTION_KINDS) assert.equal(NO_PROJECTION_SURFACE[kind], false);
    assertNoProjectionSurface(NO_PROJECTION_SURFACE);
    assertStoredPrivateMeaning(STORED_PRIVATE_MEANING);
  });

  test('every consumer projection is denied with zero bytes while a real private object is seeded', async () => {
    const store = seededPrivateStore();
    for (const kind of PROJECTION_KINDS) {
      const verdict = projectPrivateObject(store, attempt(kind));
      assert.equal(verdict.kind, kind, kind);
      assert.equal(verdict.allowed, false, kind);
      assert.equal(verdict.zeroBytes, true, kind);
      assert.equal(verdict.objectSeeded, true, `seed must be real for ${kind} (deny-by-default, not empty database)`);
      assert.equal(verdict.reason, 'owner-private-unscanned', kind);
      assert.equal(verdict.exposureMode, 'owner-private-unscanned', kind);
    }
  });

  test('an unknown consumer kind fails closed instead of silently allowing', () => {
    const store = seededPrivateStore();
    assert.throws(
      () => projectPrivateObject(store, attempt('social' as ProjectionKind)),
      /unknown_projection_kind/,
    );
    assert.throws(() => assertNoProjectionSurface({ ...NO_PROJECTION_SURFACE, publication: true }), /projection_surface_must_be_false/);
    assert.throws(() => assertNoProjectionSurface({ ...NO_PROJECTION_SURFACE, mcp: true }), /projection_surface_must_be_false/);
    assert.throws(() => assertStoredPrivateMeaning({ ...STORED_PRIVATE_MEANING, safe: true }), /stored_private_never_claims_safe/);
    assert.throws(() => assertStoredPrivateMeaning({ ...STORED_PRIVATE_MEANING, clean: true }), /stored_private_never_claims_clean/);
    assert.throws(() => assertStoredPrivateMeaning({ ...STORED_PRIVATE_MEANING, ready: true }), /stored_private_never_claims_ready/);
    assert.throws(() => assertStoredPrivateMeaning({ ...STORED_PRIVATE_MEANING, scanned: true }), /stored_private_never_claims_scanned/);
  });

  test('evidence shape never exposes projection fields, safe/clean/ready claims, or secrets', () => {
    const evidence = {
      schemaVersion: 1,
      task: 'phase4a-i03',
      exposureMode: 'owner-private-unscanned',
      storedPrivateMeaning: STORED_PRIVATE_MEANING,
      noProjection: NO_PROJECTION_SURFACE,
      capabilities: [{ capability: 'streamed_byte_count', verdict: 'pass' }],
      digestFingerprint: 'a1b2c3d4',
    };
    assert.doesNotThrow(() => assertStoredPrivateEvidenceShape(evidence));
    assert.doesNotThrow(() => sanitizeEvidence(evidence));

    assert.throws(() => assertStoredPrivateEvidenceShape({ ...evidence, exposureMode: 'public' }), /exposure_mode_must_be_owner_private_unscanned/);
    assert.throws(() => assertStoredPrivateEvidenceShape({ ...evidence, publication: { manifest: [] } }), /projection_surface_must_be_false/);
    assert.throws(() => assertStoredPrivateEvidenceShape({ ...evidence, sync: { snapshot: [] } }), /projection_surface_must_be_false/);
    assert.throws(() => assertStoredPrivateEvidenceShape({ ...evidence, mcp: { resources: [] } }), /projection_surface_must_be_false/);
    assert.throws(() => assertStoredPrivateEvidenceShape({ ...evidence, search: { index: [] } }), /projection_surface_must_be_false/);
    assert.throws(() => assertStoredPrivateEvidenceShape({ ...evidence, profile: { claim: true } }), /projection_surface_must_be_false/);
    assert.throws(() => assertStoredPrivateEvidenceShape({ ...evidence, safe: true }), /stored_private_never_claims_safe/);
    assert.throws(() => assertStoredPrivateEvidenceShape({ ...evidence, clean: true }), /stored_private_never_claims_clean/);
    assert.throws(() => assertStoredPrivateEvidenceShape({ ...evidence, ready: true }), /stored_private_never_claims_ready/);
    assert.throws(() => assertStoredPrivateEvidenceShape({ ...evidence, capabilityId: 'secret-capability' }), /sensitive_evidence_field/);
    assert.throws(() => assertStoredPrivateEvidenceShape({ ...evidence, note: `capability-probes/deployment-01/${randomCapabilityId()}` }), /sensitive_evidence_value/);
  });

  test('consumer-shaped HTTP surfaces on the reference host return zero body with the object seeded', async () => {
    const store = seededPrivateStore();
    const host = createDeliveryHost({ store, appOrigin: 'http://127.0.0.1:9' });
    try {
      const origin = await host.start();
      host.issuer.registerActiveGeneration(BLOB_ID, GENERATION_ID);
      const consumerPaths = [
        '/publication/manifest', '/publication/snapshot', '/sync/snapshot', '/sync/pull',
        '/mcp/resources', '/mcp/read', '/search?q=marker', '/profile/claims', '/sharing/1', '/preview/1',
      ];
      for (const path of consumerPaths) {
        const response = await fetch(`${origin}${path}`);
        assert.equal(response.status, 404, path);
        assert.equal(await response.text(), '', path);
      }
      assert.equal(host.requestLog.every((entry) => entry.byteCount === 0), true);
    } finally {
      await host.close();
    }
  });
});
