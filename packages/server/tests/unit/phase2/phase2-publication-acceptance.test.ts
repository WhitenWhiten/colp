import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { FetchImplementation } from '@know-n/colp/client';
import { describe, test, vi } from 'vitest';
import {
  PHASE2_PUBLICATION_REQUIRED_PROBES,
  createKnownPhase2DeploymentProbeSuite,
  createPhase2DeploymentTarget,
  createUnclaimedPublicationChallengeFetch,
  runPhase2PublicationAcceptance,
  type Phase2PublicationDeploymentTargetOptions,
  type Phase2RequiredProbeResult,
} from '../../../scripts/acceptance/phase2-publication-acceptance.js';
import { startPhase2FastifyDeploymentTarget } from '../../../scripts/acceptance/phase2-fastify-deployment-target.js';
import { POSTGRES_PUBLICATION_ENTRY_TARGET } from '../../../scripts/evidence/postgres-publication-entry.js';

const MANIFEST_URL = 'https://publication.example.test/.well-known/collection-protocol';
const ACCEPTANCE_COLLECTION_ID = POSTGRES_PUBLICATION_ENTRY_TARGET.collectionId;
const ACCEPTANCE_PUBLICATION_SLUG = POSTGRES_PUBLICATION_ENTRY_TARGET.publicationSlug;

function passed(detail: Record<string, string> = {}): Promise<Phase2RequiredProbeResult> {
  return Promise.resolve({ passed: true, detail });
}

function targetOptions(): Phase2PublicationDeploymentTargetOptions {
  return {
    manifestUrl: MANIFEST_URL,
    sourceRevision: '0123456789abcdef',
    sourceDigest: 'a'.repeat(64),
    collectionId: ACCEPTANCE_COLLECTION_ID,
    postgres: {
      async verify() {
        return { engine: 'postgresql', version: 'PostgreSQL 18', database: 'known_test' };
      },
    },
    fetch: vi.fn() as FetchImplementation,
    cachePartitionProbe: () => passed({ partition: 'public/member' }),
    cursorRotationRestartProbe: () => passed({ rotation: 'restart-retained' }),
    mutationFenceProbe: () => passed({ fences: 'content/policy' }),
    goneRetentionProbe: () => passed({ retention: '410' }),
    purgeTelemetryProbe: () => passed({ telemetry: 'failure-observed' }),
  };
}

describe('Phase 2 Publication acceptance target', () => {
  test('closes and freezes the complete deployment/probe contract', () => {
    const options = targetOptions();
    const target = createPhase2DeploymentTarget(options);

    assert.equal(Object.isFrozen(target), true);
    assert.equal(Object.isFrozen(target.probes), true);
    assert.equal(target.manifestUrl, MANIFEST_URL);
    assert.equal(target.sourceRevision, '0123456789abcdef');
    assert.equal(target.sourceDigest, 'a'.repeat(64));
    assert.deepEqual(Object.keys(target.probes), [...PHASE2_PUBLICATION_REQUIRED_PROBES]);
    assert.equal(target.probes.mutationFences, options.mutationFenceProbe);
  });

  test.each([
    ['postgres', 'PostgreSQL'],
    ['cachePartitionProbe', 'cachePartition'],
    ['cursorRotationRestartProbe', 'cursorRotationRestart'],
    ['mutationFenceProbe', 'mutationFences'],
    ['goneRetentionProbe', 'goneRetention'],
    ['purgeTelemetryProbe', 'purgeTelemetry'],
  ] as const)('fails closed when %s is absent', (field, message) => {
    const options = { ...targetOptions(), [field]: undefined };
    assert.throws(
      () => createPhase2DeploymentTarget(options as unknown as Phase2PublicationDeploymentTargetOptions),
      new RegExp(message, 'u'),
    );
  });

  test.each([
    'publication.example.test/.well-known/collection-protocol',
    'http://publication.example.test/.well-known/collection-protocol',
    'https://user:secret@publication.example.test/.well-known/collection-protocol',
    'https://publication.example.test/.well-known/collection-protocol?claim=publication',
    'https://publication.example.test/not-the-discovery-route',
  ])('rejects non-exact or unsafe Manifest URL %s', (manifestUrl) => {
    assert.throws(
      () => createPhase2DeploymentTarget({ ...targetOptions(), manifestUrl }),
      /manifestUrl/u,
    );
  });

  test('rejects a non-function HTTP adapter at target construction', () => {
    assert.throws(
      () => createPhase2DeploymentTarget({
        ...targetOptions(),
        fetch: {} as FetchImplementation,
      }),
      /fetch adapter must be a function/u,
    );
  });

  test('rejects a missing or malformed source digest', () => {
    assert.throws(
      () => createPhase2DeploymentTarget({ ...targetOptions(), sourceDigest: 'stale' }),
      /sourceDigest.*SHA-256/u,
    );
  });

  test('rejects an invalid 10k or latency envelope before touching PostgreSQL', async () => {
    const options = targetOptions();
    const postgres = vi.spyOn(options.postgres, 'verify');
    const target = createPhase2DeploymentTarget(options);

    await assert.rejects(
      runPhase2PublicationAcceptance(target, {
        expectedSnapshotNodes: 9_999,
        maxRequestP95Ms: 1_000,
        maxSnapshotTraversalMs: 30_000,
      }),
      /expectedSnapshotNodes.*10000/u,
    );
    await assert.rejects(
      runPhase2PublicationAcceptance(target, {
        expectedSnapshotNodes: 10_000,
        maxRequestP95Ms: 0,
        maxSnapshotTraversalMs: 30_000,
      }),
      /maxRequestP95Ms/u,
    );
    assert.equal(postgres.mock.calls.length, 0);
  });

  test('fails before HTTP when PostgreSQL identity evidence is incomplete', async () => {
    const options = targetOptions();
    const fetch = vi.fn() as unknown as FetchImplementation;
    const target = createPhase2DeploymentTarget({
      ...options,
      fetch,
      postgres: {
        async verify() {
          return { engine: 'postgresql', version: '', database: '' };
        },
      },
    });
    await assert.rejects(
      runPhase2PublicationAcceptance(target, {
        expectedSnapshotNodes: 10_000,
        maxRequestP95Ms: 1_000,
        maxSnapshotTraversalMs: 30_000,
      }),
      /PostgreSQL readiness probe returned incomplete evidence/u,
    );
    assert.equal(vi.mocked(fetch).mock.calls.length, 0);
  });

  test('formal acceptance rejects ad hoc pass callbacks before HTTP traversal', async () => {
    const options = targetOptions();
    const fetch = vi.fn() as unknown as FetchImplementation;
    const target = createPhase2DeploymentTarget({ ...options, fetch });

    await assert.rejects(
      runPhase2PublicationAcceptance(target, {
        expectedSnapshotNodes: 10_000,
        maxRequestP95Ms: 1_000,
        maxSnapshotTraversalMs: 30_000,
      }),
      /requires the repo-owned Known deployment probe composition/u,
    );
    assert.equal(vi.mocked(fetch).mock.calls.length, 0);
  });

  test('formal acceptance rejects a spread copy of an authorized target', async () => {
    const fetch = vi.fn() as unknown as FetchImplementation;
    const probeSuite = createKnownPhase2DeploymentProbeSuite({
      runtime: {} as never,
      config: {} as never,
      origin: 'https://publication.example.test',
      collectionId: ACCEPTANCE_COLLECTION_ID,
      publicationSlug: ACCEPTANCE_PUBLICATION_SLUG,
      memberHeaders: { cookie: '__Host-known_session=real-session' },
    });
    const authentic = createPhase2DeploymentTarget({
      manifestUrl: MANIFEST_URL,
      sourceRevision: '0123456789abcdef',
      sourceDigest: 'a'.repeat(64),
      collectionId: ACCEPTANCE_COLLECTION_ID,
      postgres: targetOptions().postgres,
      fetch,
      probeSuite,
    });
    const copied = { ...authentic };

    await assert.rejects(
      runPhase2PublicationAcceptance(copied, {
        expectedSnapshotNodes: 10_000,
        maxRequestP95Ms: 1_000,
        maxSnapshotTraversalMs: 30_000,
      }),
      /requires the repo-owned Known deployment probe composition/u,
    );
    assert.equal(vi.mocked(fetch).mock.calls.length, 0);
  });

  test('formal acceptance rejects a spread copy of the authorized probe suite', async () => {
    const fetch = vi.fn() as unknown as FetchImplementation;
    const probeSuite = createKnownPhase2DeploymentProbeSuite({
      runtime: {} as never,
      config: {} as never,
      origin: 'https://publication.example.test',
      collectionId: ACCEPTANCE_COLLECTION_ID,
      publicationSlug: ACCEPTANCE_PUBLICATION_SLUG,
      memberHeaders: { cookie: '__Host-known_session=real-session' },
    });
    const target = createPhase2DeploymentTarget({
      ...targetOptions(),
      fetch,
      probeSuite: { ...probeSuite },
    });
    await assert.rejects(
      runPhase2PublicationAcceptance(target, {
        expectedSnapshotNodes: 10_000,
        maxRequestP95Ms: 1_000,
        maxSnapshotTraversalMs: 30_000,
      }),
      /requires the repo-owned Known deployment probe composition/u,
    );
    assert.equal(vi.mocked(fetch).mock.calls.length, 0);
  });
});

test('the Fastify deployment adapter refuses to listen when PostgreSQL is unavailable', async () => {
  const app = {
    listen: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const database = {
    verifyReady: vi.fn(async () => {
      throw new Error('PostgreSQL is unavailable');
    }),
    pool: { query: vi.fn() },
  };
  const { postgres: _postgres, ...deploymentOptions } = targetOptions();

  await assert.rejects(
    startPhase2FastifyDeploymentTarget({
      ...deploymentOptions,
      app: app as never,
      database: database as never,
      listen: { host: '127.0.0.1', port: 43116 },
      manifestUrl: 'http://127.0.0.1:43116/.well-known/collection-protocol',
    }),
    /PostgreSQL is unavailable/u,
  );
  assert.equal(app.listen.mock.calls.length, 0);
});

test('the Fastify deployment adapter closes an origin-mismatched listener', async () => {
  const app = {
    listen: vi.fn(async () => 'http://127.0.0.1:43117'),
    close: vi.fn(async () => undefined),
  };
  const database = {
    verifyReady: vi.fn(async () => undefined),
    pool: {
      query: vi.fn(async () => ({
        rows: [{ version: 'PostgreSQL 18', database: 'known_test' }],
      })),
    },
  };
  const { postgres: _postgres, ...deploymentOptions } = targetOptions();

  await assert.rejects(
    startPhase2FastifyDeploymentTarget({
      ...deploymentOptions,
      app: app as never,
      database: database as never,
      listen: { host: '127.0.0.1', port: 43117 },
      manifestUrl: 'http://127.0.0.1:43118/.well-known/collection-protocol',
    }),
    /deployment origin.*does not match Manifest origin/u,
  );
  assert.equal(app.close.mock.calls.length, 1);
});

test('the P2-16 challenge adds publication only to a detached client response', async () => {
  const deployedManifest = {
    protocolVersions: ['0.1'],
    serverUuid: '019f92b9-e2b2-7db3-ba14-355bab1bc845',
    mounts: [{
      id: 'known-publication',
      baseUrl: 'https://publication.example.test/colp/v0.1/',
      profiles: ['core'],
      endpoints: {
        directory: 'https://publication.example.test/colp/v0.1/directory',
        collection: 'https://publication.example.test/colp/v0.1/collections/{collectionId}',
        snapshot: 'https://publication.example.test/colp/v0.1/collections/{collectionId}/snapshot',
      },
    }],
  };
  const serialized = JSON.stringify(deployedManifest);
  const implementation = vi.fn(async () => new Response(serialized, {
    status: 200,
    headers: { etag: '"deployed-etag"', 'content-type': 'application/json' },
  })) as FetchImplementation;
  const state = { applied: false };
  const challenged = createUnclaimedPublicationChallengeFetch(MANIFEST_URL, implementation, state);

  const response = await challenged(MANIFEST_URL, { method: 'GET' });
  const body = await response.json() as typeof deployedManifest;
  assert.deepEqual(deployedManifest.mounts[0]?.profiles, ['core']);
  assert.deepEqual(body.mounts[0]?.profiles, ['core', 'publication']);
  assert.equal(state.applied, true);
  assert.equal(response.headers.get('etag'), null);

  const rawResponse = await implementation(MANIFEST_URL, { method: 'GET' });
  assert.equal(await rawResponse.text(), serialized);
});

test('the profile challenge does not rewrite HEAD, errors, or a different endpoint', async () => {
  const implementation = vi.fn(
    async () => new Response('not-a-manifest', { status: 404 }),
  ) as FetchImplementation;
  const state = { applied: false };
  const challenged = createUnclaimedPublicationChallengeFetch(MANIFEST_URL, implementation, state);

  assert.equal((await challenged(MANIFEST_URL, { method: 'HEAD' })).status, 404);
  assert.equal((await challenged('https://publication.example.test/colp/v0.1/directory')).status, 404);
  assert.equal(state.applied, false);
});

test('the CLI exits non-zero instead of skipping when PostgreSQL is absent', () => {
  const environment = { ...process.env };
  delete environment.KNOWN_PHASE2_ACCEPTANCE_ADAPTER;
  delete environment.KNOWN_PHASE2_ACCEPTANCE_OUTPUT;
  delete environment.DATABASE_URL;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve('scripts/phase2-publication-acceptance.mjs')],
    {
      cwd: resolve('.'),
      env: environment,
      encoding: 'utf8',
      timeout: 15_000,
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /FAIL-CLOSED.*DATABASE_URL/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\bskip(?:ped)?\b/iu);
}, 30_000);

// Know-N's browser artifacts are outside the extracted server test scope.
