import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createPostgresReportOutboxConsumer } from '../../../src/infrastructure/outbox/reports-events.js';
import { OutboxContinuationRequested, OutboxDeliveryError } from '../../../src/infrastructure/outbox/router.js';

const signal = new AbortController().signal;
const context = { signal, idempotencyKey: 'event-1' } as const;

describe('report outbox cache effects', () => {
  test('series and edition changes rotate the current report namespace', async () => {
    const rotated: string[] = [];
    const queries: string[] = [];
    const pool = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes('SELECT slug FROM')) return { rows: [{ slug: 'weekly-news' }], rowCount: 1 };
        return { rows: [{ slug: 'weekly-news' }], rowCount: 1 };
      },
    };
    const consumer = createPostgresReportOutboxConsumer(pool, {
      cacheInvalidator: {
        async rotateSeries(slug: string) { rotated.push(slug); },
        async rotateSource() {},
        async rotateDirectory() {},
      } as never,
    });
    await consumer.seriesChanged({ seriesId: 'series-1' }, context);
    await consumer.editionChanged({ editionId: 'edition-1', seriesId: 'series-1' }, context);
    assert.deepEqual(rotated, ['weekly-news', 'weekly-news']);
    assert.equal(queries.length, 2);
  });

  test('source invalidation drains deterministic keyset pages instead of rejecting a 1000+ fan-out', async () => {
    const pages: string[][] = [];
    let queryCount = 0;
    const first = Array.from({ length: 1_000 }, (_, index) => ({ slug: `report-${String(index).padStart(4, '0')}` }));
    const pool = {
      async query(sql: string) {
        if (!sql.includes('SELECT DISTINCT')) return { rows: [], rowCount: 0 };
        queryCount += 1;
        return queryCount === 1 ? { rows: first, rowCount: first.length } : { rows: [{ slug: 'report-1000' }], rowCount: 1 };
      },
    };
    const consumer = createPostgresReportOutboxConsumer(pool, {
      cacheInvalidator: {
        async rotateSeries() {},
        async rotateSource(_signal: AbortSignal, slugs: readonly string[]) { pages.push([...slugs]); },
        async rotateDirectory() {},
      } as never,
    });
    await consumer.sourceInvalidated({ collectionId: 'collection-1' }, context);
    assert.deepEqual(pages.map((page) => page.length), [1_000, 1]);
    assert.equal(pages[1]?.[0], 'report-1000');
  });

  test('purge remains effective when the series row has already disappeared', async () => {
    let providerCalls = 0;
    let rotations = 0;
    const pool = { async query() { return { rows: [], rowCount: 0 }; } };
    const consumer = createPostgresReportOutboxConsumer(pool, {
      cacheInvalidator: {
        async rotateSeries() { rotations += 1; },
        async rotateSource() {},
        async rotateDirectory() {},
      } as never,
      publicSurfacePurge: { async purge() { providerCalls += 1; } },
    });
    await consumer.publicSurfacePurge({ seriesId: 'series-1', slug: 'weekly-news', revision: 'r1', surfaces: ['html'] }, context);
    assert.equal(rotations, 1);
    assert.equal(providerCalls, 1);
  });

  test('source invalidation uses the public purge provider when Redis is unavailable', async () => {
    const purges: Array<{ seriesId: string; slug: string; idempotencyKey: string }> = [];
    let pages = 0;
    const pool = {
      async query(sql: string) {
        if (sql.includes('SELECT collection_id, after_slug')) return { rows: [], rowCount: 0 };
        if (sql.includes('SELECT DISTINCT')) {
          pages += 1;
          return pages === 1 ? {
            rows: [
              { seriesId: 'public-series', slug: 'public-report', visibility: 'public' },
              { seriesId: 'private-series', slug: 'private-report', visibility: 'private' },
              { seriesId: 'unlisted-series', slug: 'unlisted-report', visibility: 'unlisted' },
            ], rowCount: 3,
          } : { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const consumer = createPostgresReportOutboxConsumer(pool, {
      publicSurfacePurge: {
        async purge(request) {
          purges.push({ seriesId: request.seriesId, slug: request.slug, idempotencyKey: request.idempotencyKey });
        },
      },
    });
    await consumer.sourceInvalidated({
      collectionId: 'collection-1', policyRevision: 'policy-7',
    }, context);
    assert.deepEqual(purges.map(({ seriesId, slug }) => ({ seriesId, slug })), [
      { seriesId: 'public-series', slug: 'public-report' },
      { seriesId: 'unlisted-series', slug: 'unlisted-report' },
    ]);
    assert.equal(new Set(purges.map((purge) => purge.idempotencyKey)).size, 2);
  });

  test('source public purge provider failures remain retryable', async () => {
    const pool = {
      async query(sql: string) {
        if (sql.includes('SELECT collection_id, after_slug')) return { rows: [], rowCount: 0 };
        if (sql.includes('SELECT DISTINCT')) {
          return { rows: [{ seriesId: 'public-series', slug: 'public-report', visibility: 'public' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const consumer = createPostgresReportOutboxConsumer(pool, {
      publicSurfacePurge: { async purge() { throw new Error('provider unavailable'); } },
    });
    await assert.rejects(
      consumer.sourceInvalidated({ collectionId: 'collection-1', policyRevision: 'policy-7' }, context),
      (error: unknown) => error instanceof OutboxDeliveryError && error.failureKind === 'retryable',
    );
  });

  test('durable source cursor requests one worker continuation per full page', async () => {
    const first = Array.from({ length: 1_000 }, (_, index) => ({ slug: `report-${String(index).padStart(4, '0')}` }));
    let cursor: string | null = null;
    let pageCalls = 0;
    const rotated: number[] = [];
    const pool = {
      async query(sql: string) {
        if (sql.includes('SELECT collection_id, after_slug')) return { rows: [{ collection_id: 'collection-1', after_slug: cursor }], rowCount: 1 };
        if (sql.includes('SELECT DISTINCT')) {
          pageCalls += 1;
          return pageCalls === 1 ? { rows: first, rowCount: first.length } : { rows: [{ slug: 'report-1000' }], rowCount: 1 };
        }
        if (sql.includes('UPDATE digest_source_invalidation_progress')) {
          cursor = 'report-0999';
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('DELETE FROM digest_source_invalidation_progress')) {
          cursor = null;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const consumer = createPostgresReportOutboxConsumer(pool, {
      cacheInvalidator: {
        async rotateSeries() {},
        async rotateSource(_signal: AbortSignal, slugs: readonly string[]) { rotated.push(slugs.length); },
        async rotateDirectory() {},
      } as never,
    });
    const continuationContext = {
      ...context,
      envelope: { event_id: 'source-event-1' },
      attempt: { outboxId: 'outbox-1', leaseGeneration: '1' },
    } as never;
    await assert.rejects(
      consumer.sourceInvalidated({ collectionId: 'collection-1' }, continuationContext),
      OutboxContinuationRequested,
    );
    await consumer.sourceInvalidated({ collectionId: 'collection-1' }, continuationContext);
    assert.deepEqual(rotated, [1_000, 1]);
    assert.equal(cursor, null);
  });
});
