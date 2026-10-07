import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { validateManifestSemantics } from '@know-n/colp/semantic';
import { loadConfig } from '../../support/test-config.js';
import {
  createPublicationManifestCandidate,
  createPublicationManifestCandidateV02,
  deriveClaimedProfiles,
  type PublicationManifestConfig,
} from '../../../src/modules/publication/index.js';

function config(overrides: Partial<PublicationManifestConfig> = {}): PublicationManifestConfig {
  return {
    origin: 'https://collections.example.test',
    mountPath: '/colp/v0.1/',
    serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
    title: 'Known Collections',
    maxPageSize: 200,
    maxSnapshotNodes: 100_000,
    endpoints: {
      directory: 'https://collections.example.test/colp/v0.1/directory',
      collection: 'https://collections.example.test/colp/v0.1/collections/{collectionId}',
      snapshot: 'https://collections.example.test/colp/v0.1/collections/{collectionId}/snapshot',
    },
    ...overrides,
  };
}

test('builds an immutable valid candidate without unmounted endpoints or profile claims', () => {
  const candidate = createPublicationManifestCandidate(config());
  assert.deepEqual(candidate.claimedProfiles, []);
  assert.deepEqual(candidate.manifest.mounts[0].profiles, ['core']);
  assert.deepEqual(candidate.manifest.mounts[0].endpoints, {});
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(Object.isFrozen(candidate.manifest.mounts[0]), true);
  assert.equal(createValidatorRegistry().validate('manifest', candidate.manifest).valid, true);
  assert.deepEqual(validateManifestSemantics(candidate.manifest), { valid: true, issues: [] });
});

test('declares every implemented endpoint without treating completeness as Profile evidence', () => {
  const candidate = createPublicationManifestCandidate(
    config(),
    ['directory', 'collection', 'snapshot'],
  );
  assert.deepEqual(candidate.manifest.mounts[0].profiles, ['core']);
  assert.deepEqual(candidate.claimedProfiles, []);
  assert.deepEqual(Object.keys(candidate.manifest.mounts[0].endpoints).sort(), [
    'collection',
    'directory',
    'snapshot',
  ]);
  assert.equal(candidate.mediaTypes.directory, 'application/vnd.collection-protocol.catalog+json;version=0.1');
  assert.equal(candidate.mediaTypes.collection, 'application/vnd.collection-protocol.collection+json;version=0.1');
  assert.equal(candidate.mediaTypes.snapshot, 'application/vnd.collection-protocol.snapshot+json;version=0.1');
});

test('claimedProfiles is the documented cache-projection label for 0, 1 and 2 Profile claims', () => {
  // The candidate wires claimedProfiles through deriveClaimedProfiles, so the derived
  // label can never diverge from the validated manifest profile list.
  const candidate = createPublicationManifestCandidate(config());
  assert.deepEqual(
    candidate.claimedProfiles,
    deriveClaimedProfiles(candidate.manifest.mounts[0].profiles),
  );

  // 0 claims: the baseline core-only manifest is the stable "unclaimed" cache partition.
  assert.deepEqual(deriveClaimedProfiles(['core']), []);
  // Exactly 1 claim appends a profile, so the label carries the full validated list and
  // can never be confused with the unclaimed baseline.
  assert.deepEqual(deriveClaimedProfiles(['core', 'publication']), ['core', 'publication']);
  // 2 claims (publication + sync, requires Sync Manifest capability configuration).
  assert.deepEqual(
    deriveClaimedProfiles(['core', 'publication', 'sync']),
    ['core', 'publication', 'sync'],
  );
});

test('builds a valid 0.2 candidate with the exact top-level effect-page template', () => {
  const configured = config({ endpoints: {
    ...config().endpoints,
    syncEffectPages: 'https://collections.example.test/colp/v0.1/sync/effects/{effectId}/pages/{pageNumber}',
  } });
  const candidate = createPublicationManifestCandidateV02(configured,
    ['directory', 'collection', 'snapshot', 'syncEffectPages']);
  assert.equal(candidate.manifest.protocol, 'https://know-n.com/colp/spec/0.2');
  assert.deepEqual(candidate.manifest.protocolVersions, ['0.1', '0.2']);
  assert.equal(candidate.manifest.syncEffectPages, configured.endpoints.syncEffectPages);
  assert.equal('syncEffectPages' in candidate.manifest.mounts[0]!.endpoints, false);
  assert.equal(createValidatorRegistry().validate('manifestV02', candidate.manifest).valid, true);
});

test('fails closed for unsafe origins, relative endpoints, and wrong variables', () => {
  assert.throws(() => createPublicationManifestCandidate(config({ origin: 'https://example.test/path' })), /exact absolute origin/u);
  assert.throws(() => createPublicationManifestCandidate(config({ origin: 'http://example.test' })), /must use https/u);
  assert.throws(() => createPublicationManifestCandidate(config({
    endpoints: { ...config().endpoints, snapshot: '/snapshot/{collectionId}' },
  })), /absolute URL template/u);
  assert.throws(() => createPublicationManifestCandidate(config({
    endpoints: { ...config().endpoints, collection: 'https://collections.example.test/colp/v0.1/collections/{slug}' },
  })), /invalid template variables/u);
  assert.throws(() => createPublicationManifestCandidate(config({
    endpoints: { ...config().endpoints, directory: 'https://other.example.test/colp/v0.1/directory' },
  })), /configured origin/u);
  assert.throws(() => createPublicationManifestCandidate(config({
    endpoints: { ...config().endpoints, snapshot: 'https://user@collections.example.test/colp/v0.1/collections/{collectionId}/snapshot' },
  })), /configured origin/u);
});

test('loads fail-closed publication deployment configuration', () => {
  assert.throws(() => loadConfig({
    DATABASE_URL: 'postgres://localhost/known',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    PUBLICATION_ORIGIN: 'https://user@example.test',
  }), /PUBLICATION_ORIGIN/u);
  const loaded = loadConfig({
    DATABASE_URL: 'postgres://localhost/known',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    PUBLICATION_ORIGIN: 'https://collections.example.test',
  });
  assert.equal(loaded.publication.endpoints.snapshot, 'https://collections.example.test/colp/v0.1/collections/{collectionId}/snapshot');
});
