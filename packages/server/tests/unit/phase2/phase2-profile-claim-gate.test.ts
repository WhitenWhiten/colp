import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundledConformanceEvidence,
  conformanceRequirements,
  createDeploymentConformancePlan,
  runDeploymentConformanceProbes,
} from '@know-n/colp/conformance';
import Fastify from 'fastify';
import { afterEach, describe, test } from 'vitest';
import type { PublicationConfig } from '../../../src/bootstrap/config.js';
import {
  claimPhase2PublicationProfiles,
  createPublicationManifestCandidate,
  PHASE2_DEPLOYMENT_CONFORMANCE_PLAN,
  PHASE2_DEPLOYMENT_CONFORMANCE_SCOPE,
  verifyPhase2PublicationEvidence,
  type PublicationManifestConfig,
} from '../../../src/modules/publication/index.js';
import {
  createPhase2ReleaseRequirementMapping,
  readPhase2PublicationEvidenceFile,
} from '../../../scripts/evidence/phase2-release-gate.js';
import { registerPublicationManifestRoutes } from '../../../src/transport/product/publication-manifest-routes.js';
import { createUnitOnlySyntheticPhase2Target } from '../../support/phase2-colp-deployment.js';

const SOURCE_REVISION = '0123456789abcdef0123456789abcdef01234567';
const SOURCE_DIGEST = 'a'.repeat(64);
const NOW = new Date('2026-07-24T08:00:00.000Z');
const PHASE2_SCOPE = PHASE2_DEPLOYMENT_CONFORMANCE_SCOPE;
const PHASE2_PLAN = PHASE2_DEPLOYMENT_CONFORMANCE_PLAN;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe('P2-16 evidence boundary', () => {
  test('accepts only a current source-bound artifact and returns a detached deep-frozen token', () => {
    const artifact = acceptanceEvidence();
    const verified = verifyPhase2PublicationEvidence(artifact, expectedIdentity());

    assert.equal(verified.sourceRevision, SOURCE_REVISION);
    assert.equal(verified.sourceDigest, SOURCE_DIGEST);
    assert.equal(verified.evidenceDigest, artifact.evidenceDigest);
    assert.equal(Object.isFrozen(verified), true);
    assert.equal(Object.isFrozen(verified.evidence), true);
    assert.equal(Object.isFrozen(verified.evidence.probes.cachePartition), true);
    assert.notEqual(verified.evidence, artifact);

    artifact.target.collectionId = 'caller-mutated';
    assert.equal(verified.evidence.target.collectionId, 'phase2-publication-target');
  });

  test('rejects source revision and source digest mismatch independently', () => {
    const artifact = acceptanceEvidence();
    assert.throws(() => verifyPhase2PublicationEvidence(artifact, {
      ...expectedIdentity(), sourceRevision: 'f'.repeat(40),
    }), /source identity/u);
    assert.throws(() => verifyPhase2PublicationEvidence(artifact, {
      ...expectedIdentity(), sourceDigest: 'b'.repeat(64),
    }), /source identity/u);
  });

  test('rejects stale, future, forged, partial, and failed evidence', () => {
    assert.throws(() => verifyPhase2PublicationEvidence(acceptanceEvidence({
      generatedAt: '2026-07-22T07:59:59.000Z',
    }), expectedIdentity()), /stale/u);
    assert.throws(() => verifyPhase2PublicationEvidence(acceptanceEvidence({
      generatedAt: '2026-07-24T08:00:00.001Z',
    }), expectedIdentity()), /future/u);

    const forged = acceptanceEvidence();
    forged.target.collectionId = 'forged-after-digest';
    assert.throws(() => verifyPhase2PublicationEvidence(forged, expectedIdentity()), /digest/u);

    const partial = acceptanceEvidence() as Record<string, unknown>;
    delete partial.requests;
    assert.throws(() => verifyPhase2PublicationEvidence(partial, expectedIdentity()), /fields/u);

    for (const mutate of [
      (value: MutableEvidence) => { value.accepted = false; },
      (value: MutableEvidence) => { value.clientChallenge.applied = false; },
      (value: MutableEvidence) => { delete value.probes.cachePartition; },
      (value: MutableEvidence) => { value.probes.purgeTelemetry!.passed = false; },
      (value: MutableEvidence) => { value.manifest.claimedPublication = true; },
    ]) {
      const value = acceptanceEvidence();
      mutate(value);
      value.evidenceDigest = digestEvidence(value);
      assert.throws(() => verifyPhase2PublicationEvidence(value, expectedIdentity()));
    }
  });

  test('rejects mutable-object tricks rather than invoking accessors', () => {
    let accessed = false;
    const artifact = acceptanceEvidence() as Record<string, unknown>;
    Object.defineProperty(artifact, 'accepted', {
      enumerable: true,
      get() {
        accessed = true;
        return true;
      },
    });
    assert.throws(() => verifyPhase2PublicationEvidence(artifact, expectedIdentity()), /accessors/u);
    assert.equal(accessed, false);
    assert.throws(
      () => verifyPhase2PublicationEvidence(new Date() as unknown, expectedIdentity()),
      /plain JSON/u,
    );
  });

  test('fails closed for absent, invalid, directory, and corrupt evidence paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'known-phase2-evidence-'));
    temporaryDirectories.push(directory);
    const corrupt = join(directory, 'corrupt.json');
    const valid = join(directory, 'evidence.json');
    await writeFile(corrupt, '{', 'utf8');
    await writeFile(valid, JSON.stringify(acceptanceEvidence()), 'utf8');

    const verified = await readPhase2PublicationEvidenceFile(valid, expectedIdentity());
    assert.equal(verified.evidenceDigest, acceptanceEvidence().evidenceDigest);
    assert.equal(Object.isFrozen(verified), true);
    await assert.rejects(readPhase2PublicationEvidenceFile('', expectedIdentity()), /path/u);
    await assert.rejects(
      readPhase2PublicationEvidenceFile(join(directory, 'missing.json'), expectedIdentity()),
    );
    await assert.rejects(readPhase2PublicationEvidenceFile(directory, expectedIdentity()), /regular/u);
    await assert.rejects(readPhase2PublicationEvidenceFile(corrupt, expectedIdentity()), /valid JSON/u);
  });
});

test('COLP derives the exact authoritative-write plus Publication deployment plan', () => {
  assert.deepEqual(createDeploymentConformancePlan(PHASE2_SCOPE), PHASE2_PLAN);
  assert.deepEqual(PHASE2_PLAN.profiles, ['core', 'publication']);
  assert.deepEqual(PHASE2_PLAN.capabilities, ['core-authoritative-writes']);
  assert.deepEqual(PHASE2_PLAN.probeIds, [
    'core.id-ledger-persistence',
    'core.pre-write-validation',
    'core.parent-cycle-transaction',
    'core.node-subtree-transaction',
    'publication.http-contracts',
  ]);
  for (const unrelated of [
    'core.sync-extension-persistence',
    'core.ai-provenance-transaction',
    'core.profile-id-persistence',
    'core.profile-id-key-rotation',
    'core.secret-redaction',
    'core.managed-bookmarks-transaction',
  ]) assert.equal(PHASE2_PLAN.probeIds.includes(unrelated as never), false, unrelated);
});

test('the release map is dynamically derived from the exact Core and Publication MUST/MUST_NOT set', () => {
  const expected = expectedRequirementIds();
  const packageRequired = conformanceRequirements
    .filter((requirement) => ['core', 'publication'].includes(requirement.profile)
      && ['MUST', 'MUST_NOT'].includes(requirement.level))
    .map((requirement) => requirement.id)
    .sort();
  const mapping = createPhase2ReleaseRequirementMapping();

  assert.equal(expected.length, 74);
  assert.deepEqual(packageRequired, expected);
  assert.deepEqual(mapping.requirements.map(({ id }) => id), expected);
  assert.equal(mapping.expected, expected.length);
  assert.equal(mapping.mapped, expected.length);
  assert.equal(mapping.passed, expected.length);
  assert.equal(mapping.complete, mapping.passed === expected.length);
  assert.equal(Object.isFrozen(mapping), true);
  assert.equal(Object.isFrozen(mapping.requirements), true);
  for (const requirement of mapping.requirements) {
    assert.ok(requirement.implementation.length > 0, `${requirement.id} implementation mapping`);
    assert.ok(requirement.tests.length > 0, `${requirement.id} test mapping`);
  }
});

test('tracked unverified package evidence cannot claim a Profile or satisfy release', async () => {
  const verified = verifyPhase2PublicationEvidence(acceptanceEvidence(), expectedIdentity());
  const deploymentEvidence = await runDeploymentConformanceProbes(
    createUnitOnlySyntheticPhase2Target(),
    PHASE2_SCOPE,
  );
  if (createPhase2ReleaseRequirementMapping().complete) return;

  assert.equal(bundledConformanceEvidence.schemaVersion, 2);
  assert.equal(bundledConformanceEvidence.passedRequirementIds.length, 0);
  assert.throws(
    () => claimPhase2PublicationProfiles({ evidence: verified, deploymentEvidence }),
    /lack complete|evidence/u,
  );
  assert.deepEqual(createPublicationManifestCandidate(manifestConfig(), [
    'directory', 'collection', 'snapshot',
  ]).manifest.mounts[0].profiles, ['core']);
});

test('missing evidence leaves real discovery unclaimed by default', async () => {
  const app = Fastify({ logger: false });
  registerPublicationManifestRoutes(app, manifestConfig());
  const response = await app.inject({
    method: 'GET',
    url: '/.well-known/collection-protocol',
    headers: {
      accept: 'application/vnd.collection-protocol.manifest+json;version=0.1',
      'collection-protocol-version': '0.1',
    },
  });
  await app.close();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().mounts[0].profiles, ['core']);
});

test('forged or copied evidence and claim objects cannot reach the Manifest', async () => {
  const verified = verifyPhase2PublicationEvidence(acceptanceEvidence(), expectedIdentity());
  const deploymentEvidence = await runDeploymentConformanceProbes(
    createUnitOnlySyntheticPhase2Target(),
    PHASE2_SCOPE,
  );
  assert.throws(() => claimPhase2PublicationProfiles({
    evidence: structuredClone(verified),
    deploymentEvidence,
  }), /returned by verify/u);
  assert.throws(() => claimPhase2PublicationProfiles({
    evidence: verified,
    deploymentEvidence: structuredClone(deploymentEvidence),
  }), /returned by runDeploymentConformanceProbes|evidence/u);
  const partialDeploymentEvidence = await runDeploymentConformanceProbes(
    createUnitOnlySyntheticPhase2Target(),
    { profiles: ['core', 'publication'], capabilities: [] },
  );
  assert.throws(() => claimPhase2PublicationProfiles({
    evidence: verified,
    deploymentEvidence: partialDeploymentEvidence,
  }), /wrong scope|incomplete/u);
  assert.throws(() => createPublicationManifestCandidate(
    manifestConfig(), ['directory', 'collection', 'snapshot'], {
      profiles: ['core', 'publication'],
      sourceRevision: SOURCE_REVISION,
      sourceDigest: SOURCE_DIGEST,
      evidenceDigest: acceptanceEvidence().evidenceDigest,
      generatedAt: '2026-07-24T07:59:00.000Z',
    } as never,
  ), /issued by claimPhase2PublicationProfiles/u);
});

function acceptanceEvidence(
  overrides: Partial<MutableEvidence> = {},
): MutableEvidence {
  const conditional = { getStatus: 200, headStatus: 200, notModifiedStatus: 304, etag: '"p2"' };
  const value: MutableEvidence = {
    evidence: 'phase2_publication_black_box_acceptance',
    format: 'known.phase2.publication-acceptance.v1',
    sourceRevision: SOURCE_REVISION,
    sourceDigest: SOURCE_DIGEST,
    generatedAt: '2026-07-24T07:59:00.000Z',
    target: {
      origin: 'https://publication.example.test',
      manifestUrl: 'https://publication.example.test/.well-known/collection-protocol',
      collectionId: 'phase2-publication-target',
      postgres: { engine: 'postgresql', version: 'PostgreSQL 18', database: 'known_test' },
    },
    manifest: {
      serverUuid: '019f92b9-e2b2-7db3-ba14-355bab1bc845',
      mountId: 'publication',
      deployedProfiles: ['core'],
      claimedPublication: false,
      endpoints: {
        directory: 'https://publication.example.test/colp/v0.1/directory',
        collection: 'https://publication.example.test/colp/v0.1/collections/{collectionId}',
        snapshot: 'https://publication.example.test/colp/v0.1/collections/{collectionId}/snapshot',
      },
      conditional: { ...conditional, cacheControl: 'public, max-age=300' },
    },
    clientChallenge: { applied: true, addedProfile: 'publication' },
    traversal: {
      directoryCollectionCount: 1,
      directoryContainsTarget: true,
      metadataCollectionId: 'phase2-publication-target',
      snapshotCollectionId: 'phase2-publication-target',
      snapshotNodeCount: 10_001,
      snapshotHttpPages: 21,
    },
    cache: {
      manifestRevalidated: true,
      publicResponsesHaveCachePolicy: true,
      endpointConditionals: {
        manifest: { ...conditional }, directory: { ...conditional },
        metadata: { ...conditional }, snapshot: { ...conditional },
      },
    },
    latency: {
      requestCount: 2, requestP50Ms: 1, requestP95Ms: 2, requestMaxMs: 3,
      snapshotTraversalMs: 10,
      thresholds: {
        expectedSnapshotNodes: 10_000, maxRequestP95Ms: 1_000,
        maxSnapshotTraversalMs: 30_000,
      },
    },
    probes: Object.fromEntries([
      'cachePartition', 'cursorRotationRestart', 'mutationFences',
      'goneRetention', 'purgeTelemetry',
    ].map((name) => [name, { passed: true, durationMs: 1, detail: { probe: name } }])) as MutableEvidence['probes'],
    requests: [
      requestEvidence('raw', 'https://publication.example.test/.well-known/collection-protocol'),
      requestEvidence('colp-client', 'https://publication.example.test/colp/v0.1/directory'),
    ],
    accepted: true,
    evidenceDigest: '',
    ...overrides,
  };
  value.evidenceDigest = digestEvidence(value);
  return value;
}

function requestEvidence(phase: 'raw' | 'colp-client', url: string) {
  return {
    phase, method: 'GET', url, status: 200, durationMs: 1,
    etag: '"p2"', cacheControl: 'public, max-age=300', vary: 'Accept', link: null,
  };
}

function digestEvidence(value: MutableEvidence): string {
  const payload = { ...value };
  delete (payload as { evidenceDigest?: string }).evidenceDigest;
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('base64url');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function expectedIdentity() {
  return { sourceRevision: SOURCE_REVISION, sourceDigest: SOURCE_DIGEST, now: NOW };
}

function manifestConfig(): PublicationConfig & PublicationManifestConfig {
  return {
    origin: 'https://publication.example.test', mountPath: '/colp/v0.1/',
    serverUuid: '019f92b9-e2b2-7db3-ba14-355bab1bc845', title: 'Known Collections',
    maxPageSize: 500, maxSnapshotNodes: 100_000,
    cursorKeys: {
      active: { id: 'phase2-profile-v1', secret: Buffer.alloc(32, 71).toString('base64') },
      retained: [],
    },
    endpoints: {
      directory: 'https://publication.example.test/colp/v0.1/directory',
      collection: 'https://publication.example.test/colp/v0.1/collections/{collectionId}',
      snapshot: 'https://publication.example.test/colp/v0.1/collections/{collectionId}/snapshot',
    },
  };
}

function expectedRequirementIds(): string[] {
  return conformanceRequirements
    .filter(({ profile, level }) => ['core', 'publication'].includes(profile)
      && ['MUST', 'MUST_NOT'].includes(level))
    .map(({ id }) => id)
    .sort();
}

interface MutableEvidence {
  evidence: string;
  format: string;
  sourceRevision: string;
  sourceDigest: string;
  generatedAt: string;
  target: Record<string, unknown>;
  manifest: Record<string, unknown>;
  clientChallenge: { applied: boolean; addedProfile: string | null };
  traversal: Record<string, unknown>;
  cache: Record<string, unknown>;
  latency: Record<string, unknown>;
  probes: Record<string, { passed: boolean; durationMs: number; detail: unknown }>;
  requests: Array<Record<string, unknown>>;
  accepted: boolean;
  evidenceDigest: string;
}
