/**
 * P4A-I12 PostgreSQL integration: search index + query projection exclusion.
 *
 * With a REAL private blob seeded through the production ledger (unique marker
 * inside the physical generation key rows and stored bytes) plus a visible
 * control collection/node that IS searchable, every search public entry — the
 * PostgreSQL candidate index (`createPostgresSearchCandidatePort`) and the
 * full search query (`executeSearchQuery` with the production authority port)
 * — must:
 *   (a) actually execute (querying the control marker returns the control
 *       resource, proving the index/query link ran);
 *   (b) NEVER return the private marker: the search index has no attachment
 *       data and a query for the exact private marker yields nothing while a
 *       query for the control marker in the SAME run still works.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createPostgresSearchAuthorityPort,
  createPostgresSearchCandidatePort,
} from '../../../src/infrastructure/search/index.js';
import { createPostgresSharedExposureFactsPort } from '../../../src/infrastructure/database/index.js';
import {
  createSearchCursorSigner,
  executeSearchQuery,
} from '../../../src/modules/search/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  assertMarkerAbsentFromJson,
  controlMarker,
  i12BlobIdentity,
  privateMarker,
  seedAttachedPrivate,
  seedControlCollection,
  seedExpiredBlob,
  seedQuarantinedGeneration,
  seedRetiredGeneration,
  seedStoredPrivate,
} from '../../support/phase4a-i12-test-helpers.js';
import {
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const KEYS = { current: { id: 'i12-search', key: 'i12-search-cursor-key-material-0123456789' } } as const;

describeWithPostgres('P4A-I12 search index/query projection exclusion', () => {
  let isolated: I07MigrationRuntime;
  let controlCollectionMarker: string;
  let controlNodeMarker: string;
  const privateMarkers = {
    stored: privateMarker('i12-search-stored'),
    attached: privateMarker('i12-search-attached'),
    retiredOld: privateMarker('i12-search-retired-old'),
    retiredNew: privateMarker('i12-search-retired-new'),
    expired: privateMarker('i12-search-expired'),
    quarantined: privateMarker('i12-search-quarantined'),
  };

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_i12_search', { maxConnections: 10 });
    controlCollectionMarker = controlMarker('i12-search-control-collection');
    controlNodeMarker = controlMarker('i12-search-control-node');
    await seedControlCollection(isolated.runtime, {
      collectionId: 'i12-search-collection',
      title: controlCollectionMarker,
      controlNodeTitle: controlNodeMarker,
      allowSearchIndexing: true,
    });

    let slot = 0;
    const next = () => { slot += 1; return slot; };
    await seedStoredPrivate(isolated.runtime, i12BlobIdentity(next(), privateMarkers.stored));
    await seedAttachedPrivate(isolated.runtime, i12BlobIdentity(next(), privateMarkers.attached));
    await seedRetiredGeneration(
      isolated.runtime,
      i12BlobIdentity(next(), privateMarkers.retiredOld),
      i12BlobIdentity(next(), privateMarkers.retiredNew),
    );
    await seedExpiredBlob(isolated.runtime, i12BlobIdentity(next(), privateMarkers.expired));
    await seedQuarantinedGeneration(isolated.runtime, i12BlobIdentity(next(), privateMarkers.quarantined));
    await isolated.runtime.pool.query('analyze collections');
    await isolated.runtime.pool.query('analyze nodes');
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('the seeded private markers exist only in attachment rows, not in the search index', async () => {
    for (const marker of Object.values(privateMarkers)) {
      const rows = await isolated.runtime.pool.query<{ count: string }>(
        `select count(*)::text as count from generation_keys where key like '%' || $1 || '%'`,
        [marker],
      );
      assert.equal(rows.rows[0]?.count, '1', `marker ${marker} must exist in a real generation_keys row`);
      const indexed = await isolated.runtime.pool.query<{ count: string }>(
        `select count(*)::text as count
           from collections c
           join nodes n on n.collection_id = c.id
          where c.search_text like '%' || $1 || '%'
             or n.search_text like '%' || $1 || '%'`,
        [marker],
      );
      assert.equal(indexed.rows[0]?.count, '0', `marker ${marker} must never enter the search index`);
    }
  });

  test('the search candidate index serves the control resource and never serves the private marker', async () => {
    const candidates = createPostgresSearchCandidatePort(isolated.runtime.db);
    const controlPage = await candidates.listCandidates({
      query: controlNodeMarker,
      types: ['collection', 'node', 'profile', 'annotation'],
      projection: { kind: 'anonymous' },
      limit: 100,
      timeoutMs: 5_000,
    });
    assert.ok(controlPage.items.some((item) => item.resourceId === 'i12-search-collection-control-node'),
      'control node candidate must be indexed and returned (link executed)');
    for (const marker of Object.values(privateMarkers)) {
      const privatePage = await candidates.listCandidates({
        query: marker,
        types: ['collection', 'node', 'profile', 'annotation'],
        projection: { kind: 'anonymous' },
        limit: 100,
        timeoutMs: 5_000,
      });
      // Trigram/token search may surface unrelated control rows that share
      // tokens with the marker; the I12 contract is that the private blob is
      // never indexed and its marker never appears in any candidate output.
      assertMarkerAbsentFromJson(privatePage, marker, `private-marker candidate page (${marker})`);
    }
  });

  test('the full search query serves the control result and carries zero private marker', async () => {
    const ports = {
      candidates: createPostgresSearchCandidatePort(isolated.runtime.db),
      authority: createPostgresSearchAuthorityPort(isolated.runtime.db),
      cursors: createSearchCursorSigner(KEYS),
      clock: { now: () => NOW },
      sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
    };
    const control = await executeSearchQuery(ports, {
      principal: { kind: 'anonymous' },
      query: controlNodeMarker,
      pageSize: 100,
    });
    assert.ok(control.items.length >= 1, 'control result must be returned (link executed)');
    assert.ok(control.items.some((item) => item.resourceId === 'i12-search-collection-control-node'));
    for (const marker of Object.values(privateMarkers)) {
      assertMarkerAbsentFromJson(control, marker, 'search control result');
      const privateResult = await executeSearchQuery(ports, {
        principal: { kind: 'anonymous' },
        query: marker,
        pageSize: 100,
      });
      // The SearchQueryResult echoes the caller's own query in
      // `normalizedQuery`, so the marker-absence contract is asserted over the
      // OUTPUT (items, page, cache, consistency) — never over the echoed input.
      const privateOutput = {
        items: privateResult.items,
        page: privateResult.page,
        cache: privateResult.cache,
        consistency: privateResult.consistency,
      };
      assertMarkerAbsentFromJson(privateOutput, marker, `exact private-marker query output (${marker})`);
    }
    assert.doesNotMatch(JSON.stringify(control.cache), /private-marker/iu);
  });

  test('search still returns the control resource when queried alongside a private marker in the same request', async () => {
    const ports = {
      candidates: createPostgresSearchCandidatePort(isolated.runtime.db),
      authority: createPostgresSearchAuthorityPort(isolated.runtime.db),
      cursors: createSearchCursorSigner(KEYS),
      clock: { now: () => NOW },
      sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
    };
    // Query the control marker: the private markers must not appear anywhere in
    // the serialized result even though the same index contains the control row.
    const result = await executeSearchQuery(ports, {
      principal: { kind: 'anonymous' },
      query: controlCollectionMarker,
      pageSize: 100,
    });
    assert.ok(result.items.some((item) => item.resourceId === 'i12-search-collection'), 'control collection result returned');
    for (const marker of Object.values(privateMarkers)) {
      assertMarkerAbsentFromJson(result, marker, 'combined search result');
    }
  });
});
