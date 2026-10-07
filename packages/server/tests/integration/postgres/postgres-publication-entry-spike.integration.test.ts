import assert from 'node:assert/strict';
import { PUBLICATION_SNAPSHOT_MEDIA_TYPE } from '@know-n/colp/server';
import type { Snapshot } from '@know-n/colp/types';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresPublicationEntrySnapshotQueryPorts,
  expectedPostgresPublicationEntryIds,
  loadPostgresPublicationEntryThresholds,
  POSTGRES_PUBLICATION_ENTRY_TARGET,
  runPostgresPublicationEntryEvidence,
  seedPostgresPublicationEntryFixture,
  type PostgresPublicationEntryEvidence,
} from '../../../scripts/evidence/postgres-publication-entry.js';
import { createPublicationCursorKeyring } from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('Phase 2 PostgreSQL Publication entry spike', () => {
  let isolated: IsolatedPostgresRuntime;
  let evidence: PostgresPublicationEntryEvidence;
  let httpTraversal: HttpTraversalEvidence;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2_publication_entry', {
      maxConnections: 8,
      applicationName: 'known-phase2-publication-entry',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    const thresholds = loadPostgresPublicationEntryThresholds();
    await seedPostgresPublicationEntryFixture(isolated.runtime, thresholds.nodeCount);
    httpTraversal = await traverseProductionHttpRoute(
      isolated,
      thresholds.nodeCount,
      thresholds.pageSize,
    );
    evidence = await runPostgresPublicationEntryEvidence(isolated.runtime, { seedFixture: false });
    console.info(JSON.stringify(evidence, null, 2));
  }, 240_000);

  afterAll(async () => {
    await isolated?.close();
  });

  test('assembles an exact 10k COLP Publication Snapshot from validated pages', () => {
    assert.ok(evidence.environment.nodeCount >= 10_000);
    assert.equal(evidence.traversal.nodeCount, evidence.environment.nodeCount + 1);
    assert.equal(evidence.traversal.duplicateCount, 0);
    assert.deepEqual(evidence.traversal.missingIds, []);
    assert.deepEqual(evidence.traversal.unexpectedIds, []);
    assert.equal(evidence.traversal.strictlyOrdered, true);
    assert.equal(evidence.traversal.structurallyValidPages, evidence.traversal.pageCount);
    assert.equal(evidence.traversal.assembledSemanticsValid, true);
    assert.equal(evidence.pass.exactTraversal, true);
    assert.equal(evidence.pass.schemaAndSemantics, true);
  });

  test('follows production Fastify next Links through the exact 10k PostgreSQL traversal', () => {
    assert.equal(httpTraversal.nodeCount, evidence.environment.nodeCount + 1);
    assert.equal(httpTraversal.duplicateCount, 0);
    assert.deepEqual(httpTraversal.missingIds, []);
    assert.deepEqual(httpTraversal.unexpectedIds, []);
    assert.equal(httpTraversal.strictlyOrdered, true);
    assert.equal(httpTraversal.followedLinkCount, httpTraversal.pageCount - 1);
  });

  test('uses per-page REPEATABLE READ and fences content, policy, and tampered continuations', () => {
    assert.ok(evidence.traversal.transactionIsolation.length > 1);
    assert.ok(evidence.traversal.transactionIsolation.every((value) => value === 'repeatable read'));
    assert.deepEqual(evidence.fences, {
      contentRevision: 'snapshot_expired',
      policyRevision: 'snapshot_expired',
      tamperedCursor: 'snapshot_expired',
    });
    assert.equal(evidence.pass.mvccAndFences, true);
    assert.deepEqual(evidence.concurrentSnapshot, {
      writerCompletedWhileReaderPaused: true,
      writerMs: evidence.concurrentSnapshot.writerMs,
      readerContentRevision: 'c2',
      readerNodeTitle: 'Publication Node 1 updated',
      nextContentRevision: 'c3',
      nextNodeTitle: 'Publication Node 1 updated concurrent',
    });
  });

  test('covers root-only, tombstone, limit+1, final-page, and cross-Collection boundaries', () => {
    assert.deepEqual(evidence.boundaries, {
      rootOnlyRootId: 'p2-root',
      rootOnlyCandidateIds: [],
      liveLimitPlusOneIds: ['p2-n000001', 'p2-n000003', 'p2-n000004'],
      finalPageIds: ['p2-f099'],
      otherCollectionIds: ['p2-other-node'],
    });
  });

  test('meets the paging latency and serialization-memory budgets', () => {
    assert.ok(evidence.traversal.pageLatencyMs.p95 <= evidence.thresholds.pageP95Ms);
    assert.ok(evidence.traversal.elapsedMs <= evidence.thresholds.fullTraversalMs);
    assert.ok(evidence.traversal.maxPageBytes <= evidence.thresholds.maxPageBytes);
    assert.ok(evidence.traversal.heapDeltaBytes <= evidence.thresholds.maxHeapDeltaBytes);
    assert.equal(evidence.pass.latency, true);
    assert.equal(evidence.pass.serializationMemory, true);
  });

  test('uses the live keyset index and does not block an unrelated Collection writer', () => {
    assert.deepEqual(evidence.plans.map((plan) => plan.location), ['first', 'middle', 'final']);
    for (const plan of evidence.plans) {
      assert.ok(plan.indexNames.includes('nodes_live_editor_keyset_idx'));
      assert.equal(plan.hasSort, false);
      assert.equal(plan.hasNodesSequentialScan, false);
      assert.ok(plan.returnedRows <= plan.rowLimit);
      assert.ok(plan.sharedBufferBlocks > 0);
      assert.ok(plan.executionMs <= evidence.thresholds.planExecutionMs);
    }
    assert.ok(evidence.writers.otherCollectionMs <= evidence.thresholds.writerTransactionMs);
    assert.equal(evidence.pass.plans, true);
    assert.equal(evidence.pass.writers, true);
    assert.equal(evidence.pass.overall, true);
  });
});

interface HttpTraversalEvidence {
  readonly pageCount: number;
  readonly followedLinkCount: number;
  readonly nodeCount: number;
  readonly duplicateCount: number;
  readonly missingIds: readonly string[];
  readonly unexpectedIds: readonly string[];
  readonly strictlyOrdered: boolean;
}

async function traverseProductionHttpRoute(
  isolated: IsolatedPostgresRuntime,
  nodeCount: number,
  pageSize: number,
): Promise<HttpTraversalEvidence> {
  const key = createPublicationCursorKeyring({
    active: { id: 'http-evidence-v1', secret: Buffer.alloc(32, 41).toString('base64') },
    retained: [],
  });
  let app: ReturnType<typeof buildApiApp> | undefined;
  const ids: string[] = [];
  let pageCount = 0;
  let followedLinkCount = 0;
  let url = `/colp/v0.1/collections/${POSTGRES_PUBLICATION_ENTRY_TARGET.collectionId}/snapshot?limit=${pageSize}`;
  const maximumPages = Math.ceil((nodeCount + 1) / pageSize) + 2;
  try {
    app = buildApiApp({
      config: loadConfig({
        DATABASE_URL: isolated.databaseUrl,
        PRODUCT_ORIGIN: 'https://known.example',
        PUBLICATION_ORIGIN: 'https://known.example',
        LOG_LEVEL: 'silent',
        OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      }),
      exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
      publicationSnapshotQuery: createPostgresPublicationEntrySnapshotQueryPorts(isolated.runtime, key),
    });
    while (true) {
      if (pageCount >= maximumPages) throw new Error('Publication HTTP traversal exceeded its page bound');
      const response = await app.inject({
        method: 'GET',
        url,
        headers: {
          accept: `${PUBLICATION_SNAPSHOT_MEDIA_TYPE};version=0.1`,
          'collection-protocol-version': '0.1',
        },
      });
      if (response.statusCode !== 200) {
        throw new Error(`Publication HTTP traversal failed with status ${response.statusCode}`);
      }
      const page = response.json() as Snapshot;
      ids.push(...page.nodes.map((node) => node.id));
      pageCount += 1;
      const link = response.headers.link;
      if (link === undefined) break;
      if (typeof link !== 'string') throw new Error('Publication HTTP traversal received repeated Link headers');
      const target = /^<([^>]+)>;\s*rel="next"$/u.exec(link)?.[1];
      if (target === undefined) throw new Error('Publication HTTP traversal received an invalid next Link');
      const next = new URL(target);
      if (next.origin !== 'https://known.example') {
        throw new Error('Publication HTTP traversal next Link changed origin');
      }
      url = `${next.pathname}${next.search}`;
      followedLinkCount += 1;
    }
  } finally {
    await app?.close();
    key.destroy();
  }
  const expected = expectedPostgresPublicationEntryIds(nodeCount);
  const returnedSet = new Set(ids);
  const expectedSet = new Set(expected);
  return {
    pageCount,
    followedLinkCount,
    nodeCount: ids.length,
    duplicateCount: ids.length - returnedSet.size,
    missingIds: expected.filter((id) => !returnedSet.has(id)),
    unexpectedIds: ids.filter((id) => !expectedSet.has(id)),
    strictlyOrdered: ids.length === expected.length && ids.every((id, index) => id === expected[index]),
  };
}
