import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createPostgresSharedExposureFactsPort, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  runPhase2PublicationAcceptance,
  createKnownPhase2DeploymentProbeSuite,
  type Phase2PublicationAcceptanceEvidence,
} from '../../../scripts/acceptance/phase2-publication-acceptance.js';
import {
  startPhase2FastifyDeploymentTarget,
  type StartedPhase2FastifyDeploymentTarget,
} from '../../../scripts/acceptance/phase2-fastify-deployment-target.js';
import {
  POSTGRES_PUBLICATION_ENTRY_TARGET,
  loadPostgresPublicationEntryThresholds,
  seedPostgresPublicationEntryFixture,
} from '../../../scripts/evidence/postgres-publication-entry.js';
import {
  createPostgresProductPublicCollectionLocatorReadPort,
  createPostgresProductPublicCollectionViewCountReadPort,
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationMetadataReadPort,
  createPostgresPublicationSnapshotReadPort,
} from '../../../src/infrastructure/publication/index.js';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import { createPublicationCursorKeyring } from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { reserveTcpPort } from '../../support/runtime-process.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
} from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';

describeWithPostgres('Phase 2 Publication black-box acceptance', () => {
  let isolated: IsolatedPostgresRuntime;
  let deployment: StartedPhase2FastifyDeploymentTarget;
  let evidence: Phase2PublicationAcceptanceEvidence;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2_acceptance', {
      maxConnections: 10,
      applicationName: 'known-phase2-acceptance',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    const thresholds = loadPostgresPublicationEntryThresholds();
    await seedPostgresPublicationEntryFixture(isolated.runtime, thresholds.nodeCount);

    const port = await reserveTcpPort();
    const origin = `http://127.0.0.1:${port}`;
    const config = loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      PRODUCT_ORIGIN: origin,
      PUBLICATION_ORIGIN: origin,
      PUBLICATION_MAX_PAGE_SIZE: '500',
      NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      LOG_LEVEL: 'silent',
    });
    const cursors = createPublicationCursorKeyring({
      active: { id: 'phase2-acceptance-v2', secret: Buffer.alloc(32, 81).toString('base64') },
      retained: [
        { id: 'phase2-acceptance-v1', secret: Buffer.alloc(32, 80).toString('base64') },
      ],
    });
    const snapshot = {
      reads: createPostgresPublicationSnapshotReadPort(isolated.runtime),
      accessPolicy: createPostgresAccessPolicyFactsPort(isolated.runtime.db),
      cursors,
      origin,
      sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
    };
    const identityUnitOfWork = createIdentityMemoryUnitOfWork(
      createIdentityMemoryState(new Date()),
    );
    const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
    const member = await issueTestSession({
      factory,
      subject: 'phase2-acceptance-member',
      handle: 'phase2-acceptance-member',
    });
    await isolated.runtime.pool.query(
      `insert into collection_members(collection_id, subject_id, role)
       values ($1, $2, 'viewer')`,
      [POSTGRES_PUBLICATION_ENTRY_TARGET.collectionId, member.subjectId],
    );
    const app = buildApiApp({
      config,
      readiness: isolated.runtime,
      exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      publicationSnapshotQuery: snapshot,
      publicationDirectoryQuery: {
        reads: createPostgresPublicationDirectoryReadPort(isolated.runtime),
        cursors,
        origin,
        maxPageSize: 500,
      },
      publicationMetadataQuery: {
        reads: createPostgresPublicationMetadataReadPort(isolated.runtime),
        origin,
      },
      productPublicCollectionQuery: {
        locators: createPostgresProductPublicCollectionLocatorReadPort(isolated.runtime),
        viewCounts: createPostgresProductPublicCollectionViewCountReadPort(isolated.runtime),
        snapshot,
        cursors,
        owners: {
          async findByOwnerSubjectId(ownerSubjectId) {
            return { profileId: 'IiIiIiIiIiIiIiIiIiIiIg', handle: 'owner', displayName: 'Owner',
              avatarUrl: null, ownerSubjectId };
          },
        },
      },
    });
    app.addHook('onClose', () => cursors.destroy());
    const probeSuite = createKnownPhase2DeploymentProbeSuite({
      runtime: isolated.runtime,
      config,
      origin,
      collectionId: POSTGRES_PUBLICATION_ENTRY_TARGET.collectionId,
      publicationSlug: POSTGRES_PUBLICATION_ENTRY_TARGET.publicationSlug,
      memberHeaders: { cookie: member.cookie },
    });

    deployment = await startPhase2FastifyDeploymentTarget({
      app,
      database: isolated.runtime,
      listen: { host: '127.0.0.1', port },
      manifestUrl: `${origin}/.well-known/collection-protocol`,
      sourceRevision: 'phase2-acceptance-integration-fixture',
      sourceDigest: 'b'.repeat(64),
      collectionId: POSTGRES_PUBLICATION_ENTRY_TARGET.collectionId,
      probeSuite,
    });
    evidence = await runPhase2PublicationAcceptance(deployment.target, {
      // The canonical fixture has 10k descendants plus its root node.
      expectedSnapshotNodes: thresholds.nodeCount + 1,
      maxRequestP95Ms: thresholds.pageP95Ms,
      maxSnapshotTraversalMs: thresholds.fullTraversalMs,
    });
    console.info(JSON.stringify(evidence, null, 2));
  }, 900_000);

  afterAll(async () => {
    await deployment?.close();
    await isolated?.close();
  });

  test('uses the pinned COLP client from raw discovery through Directory, Metadata, and 10k Snapshot', () => {
    assert.equal(evidence.accepted, true);
    assert.equal(evidence.target.collectionId, POSTGRES_PUBLICATION_ENTRY_TARGET.collectionId);
    assert.equal(evidence.target.postgres.engine, 'postgresql');
    assert.equal(evidence.traversal.directoryContainsTarget, true);
    assert.equal(evidence.traversal.metadataCollectionId, POSTGRES_PUBLICATION_ENTRY_TARGET.collectionId);
    assert.equal(evidence.traversal.snapshotCollectionId, POSTGRES_PUBLICATION_ENTRY_TARGET.collectionId);
    assert.equal(evidence.traversal.snapshotNodeCount, 10_001);
    assert.ok(evidence.traversal.snapshotHttpPages > 1);
  });

  test('records GET, HEAD, 304 for every endpoint plus multi-page client cache and latency evidence', () => {
    assert.deepEqual(evidence.manifest.conditional, {
      getStatus: 200,
      headStatus: 200,
      notModifiedStatus: 304,
      etag: evidence.manifest.conditional.etag,
      cacheControl: evidence.manifest.conditional.cacheControl,
    });
    assert.match(evidence.manifest.conditional.etag, /^"[^"]+"$/u);
    assert.match(evidence.manifest.conditional.cacheControl, /public/u);
    assert.equal(evidence.cache.manifestRevalidated, true);
    assert.equal(evidence.cache.publicResponsesHaveCachePolicy, true);
    assert.deepEqual(Object.keys(evidence.cache.endpointConditionals), [
      'manifest',
      'directory',
      'metadata',
      'snapshot',
    ]);
    for (const conditional of Object.values(evidence.cache.endpointConditionals)) {
      assert.equal(conditional.getStatus, 200);
      assert.equal(conditional.headStatus, 200);
      assert.equal(conditional.notModifiedStatus, 304);
      assert.match(conditional.etag, /^"[^"]+"$/u);
    }
    assert.equal(evidence.requests.filter(({ phase, method, status }) =>
      phase === 'raw' && method === 'HEAD' && status === 200).length, 4);
    assert.equal(evidence.requests.filter(({ phase, method, status }) =>
      phase === 'raw' && method === 'GET' && status === 304).length, 4);
    assert.ok(evidence.requests.every(({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0));
    assert.ok(evidence.latency.requestP95Ms <= evidence.latency.thresholds.maxRequestP95Ms);
    assert.ok(evidence.latency.snapshotTraversalMs <= evidence.latency.thresholds.maxSnapshotTraversalMs);
  });

  test('keeps the deployed Profile unclaimed while recording the isolated client challenge', () => {
    assert.equal(evidence.manifest.deployedProfiles.includes('core'), true);
    assert.equal(evidence.manifest.deployedProfiles.includes('publication'), false);
    assert.equal(evidence.manifest.claimedPublication, false);
    assert.deepEqual(evidence.clientChallenge, { applied: true, addedProfile: 'publication' });
  });

  // COLP Server drops Know-N's real-stack browser probe (see the runner).
  test('requires and captures every cache/cursor/fence/retention/purge probe', () => {
    assert.deepEqual(Object.keys(evidence.probes), [
      'cachePartition',
      'cursorRotationRestart',
      'mutationFences',
      'goneRetention',
      'purgeTelemetry',
    ]);
    for (const outcome of Object.values(evidence.probes)) {
      assert.equal(outcome.passed, true);
      assert.ok(Number.isFinite(outcome.durationMs));
    }
    assert.deepEqual(evidence.probes.mutationFences.detail, {
      contentRevision: 'snapshot_expired',
      policyRevision: 'snapshot_expired',
      tamperedCursor: 'snapshot_expired',
      exactTraversal: true,
      schemaAndSemantics: true,
      pageP95Ms: (evidence.probes.mutationFences.detail as { pageP95Ms: number }).pageP95Ms,
      fullTraversalMs: (evidence.probes.mutationFences.detail as { fullTraversalMs: number }).fullTraversalMs,
    });
    assert.equal((evidence.probes.goneRetention.detail as { status: number }).status, 410);
    assert.equal((evidence.probes.goneRetention.detail as { headStatus: number }).headStatus, 410);
    assert.equal((evidence.probes.goneRetention.detail as {
      survivedRestart: boolean;
    }).survivedRestart, true);
    assert.equal((evidence.probes.cursorRotationRestart.detail as {
      restartVerified: boolean;
    }).restartVerified, true);
    assert.equal((evidence.probes.cursorRotationRestart.detail as {
      retiredCursorRejected: boolean;
    }).retiredCursorRejected, true);
    assert.equal((evidence.probes.cachePartition.detail as {
      isolated: boolean;
    }).isolated, true);
    assert.equal((evidence.probes.purgeTelemetry.detail as {
      finalState: string;
    }).finalState, 'dead_letter');
    assert.ok((evidence.probes.purgeTelemetry.detail as {
      latencyMs: readonly number[];
    }).latencyMs.length > 0);
  });

  test('emits immutable, digest-addressed evidence bound to the source revision', () => {
    assert.equal(evidence.sourceRevision, 'phase2-acceptance-integration-fixture');
    assert.equal(evidence.sourceDigest, 'b'.repeat(64));
    assert.match(evidence.evidenceDigest, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(Object.isFrozen(evidence), true);
    assert.equal(Object.isFrozen(evidence.requests), true);
    assert.equal(Object.isFrozen(evidence.probes), true);
  });
});
