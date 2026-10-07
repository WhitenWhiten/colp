import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createPostgresSharedExposureFactsPort, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresPublicationMetadataReadPort,
  createPostgresPublicationSnapshotReadPort,
} from '../../../src/infrastructure/publication/index.js';
import { createPublicationCursorKeyring } from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('Phase 2 PostgreSQL Publication Metadata evidence', () => {
  let isolated: IsolatedPostgresRuntime;
  let currentNow = new Date('2026-07-24T00:00:00Z');

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2_publication_metadata');
    await runMigrations(isolated.runtime.db, 'latest');
    await seedMetadataFixtures(isolated);
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('keeps readable Metadata and Snapshot rooted in the same live PostgreSQL facts', async () => {
    const app = buildTestApp(isolated, () => currentNow);
    try {
      const metadata = await app.inject({ method: 'GET', url: '/colp/v0.1/collections/metadata-live' });
      const snapshot = await app.inject({ method: 'GET', url: '/colp/v0.1/collections/metadata-live/snapshot' });
      assert.equal(metadata.statusCode, 200);
      assert.equal(snapshot.statusCode, 200);
      assert.equal(metadata.json().collection.rootNodeId, snapshot.json().collection.rootNodeId);
      assert.equal(metadata.json().collection.revision, snapshot.json().collection.revision);

      const deletedMetadata = await app.inject({
        method: 'GET', url: '/colp/v0.1/collections/metadata-deleted',
      });
      const deletedSnapshot = await app.inject({
        method: 'GET', url: '/colp/v0.1/collections/metadata-deleted/snapshot',
      });
      assert.equal(deletedMetadata.statusCode, 404);
      assert.equal(deletedSnapshot.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  test('retains canonical deletion across application restart and expires from durable deleted_at', async () => {
    const colp = {
      accept: 'application/vnd.collection-protocol.collection+json;version=0.1',
      'collection-protocol-version': '0.1',
    };
    currentNow = new Date('2026-07-24T00:00:00Z');
    const first = buildTestApp(isolated, () => currentNow);
    const firstGone = await first.inject({ method: 'GET', url: '/c/metadata-deleted', headers: colp });
    assert.equal(firstGone.statusCode, 410);
    await first.close();

    const restarted = buildTestApp(isolated, () => currentNow);
    try {
      const afterRestart = await restarted.inject({ method: 'GET', url: '/c/metadata-deleted', headers: colp });
      assert.equal(afterRestart.statusCode, 410);
      assert.equal(afterRestart.headers.link, undefined);

      const privateHistory = await restarted.inject({
        method: 'GET', url: '/c/metadata-private-deleted', headers: colp,
      });
      assert.equal(privateHistory.statusCode, 404);

      currentNow = new Date('2026-07-31T00:00:00Z');
      const expired = await restarted.inject({ method: 'GET', url: '/c/metadata-deleted', headers: colp });
      assert.equal(expired.statusCode, 404);
    } finally {
      await restarted.close();
    }
  });
});

function buildTestApp(isolated: IsolatedPostgresRuntime, now: () => Date) {
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused/known',
    PRODUCT_ORIGIN: 'https://known.example',
    PUBLICATION_ORIGIN: 'https://known.example',
    LOG_LEVEL: 'silent',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
  });
  const cursors = createPublicationCursorKeyring({
    active: { id: 'metadata-pg-v1', secret: Buffer.alloc(32, 61).toString('base64') },
    retained: [],
  });
  const reads = createPostgresPublicationSnapshotReadPort(isolated.runtime);
  const app = buildApiApp({
    config,
    exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
    publicationMetadataQuery: {
      reads: createPostgresPublicationMetadataReadPort(isolated.runtime),
      origin: config.publication.origin,
      now,
    },
    publicationSnapshotQuery: {
      reads,
      cursors,
      origin: config.publication.origin,
      now,
      // P4A-R06: the snapshot projection consults the exposure-eligibility gate
      // over the collection's logical blob facts through the approved port.
      sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
      accessPolicy: {
        async loadCollectionFacts(input) {
          const result = await isolated.runtime.pool.query<{
            id: string;
            owner_subject_id: string;
            visibility: 'private' | 'protected' | 'public' | 'unlisted';
            policy_revision: string;
            deleted_at: Date | null;
          }>(
            `select id, owner_subject_id, visibility, policy_revision, deleted_at
               from collections where id = $1`,
            [input.collectionId],
          );
          const row = result.rows[0];
          return row === undefined ? null : {
            collectionId: row.id,
            ownerSubjectId: row.owner_subject_id,
            visibility: row.visibility,
            policyRevision: row.policy_revision,
            membershipRole: null,
            deleted: row.deleted_at !== null,
          };
        },
      },
    },
  });
  app.addHook('onClose', () => cursors.destroy());
  return app;
}

async function seedMetadataFixtures(isolated: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    const fixtures = [
      ['metadata-live', 'metadata-live', 'public', null, null],
      ['metadata-deleted', 'metadata-deleted', 'public', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'],
      ['metadata-private-deleted', 'metadata-private-deleted', 'private', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'],
    ] as const;
    for (const [id, slug, visibility, collectionDeletedAt, rootDeletedAt] of fixtures) {
      const rootId = `${id}-root`;
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
        [id, rootId],
      );
      await client.query(
        `insert into collections
          (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
           content_revision, policy_revision, publication_slug, published_at, deleted_at, updated_at)
         values ($1, 'metadata-owner', $1, 'bookmarks', $2, $3, 'r1', 'c1', 'p1', $4,
                 '2026-07-01T00:00:00Z', $5::timestamptz, '2026-07-01T00:00:00Z')`,
        [id, visibility, rootId, slug, collectionDeletedAt],
      );
      await client.query(
        `insert into nodes
          (id, collection_id, kind, is_root, title, visibility, resource_revision, children_revision, deleted_at)
         values ($1, $2, 'folder', true, $2, 'inherit', 'r1', 'ch1', $3::timestamptz)`,
        [rootId, id, rootDeletedAt],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
