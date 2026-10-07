import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  EventEnvelopeRegistry,
  OutboxRouter,
  PostgresOutboxRepository,
  PublicationCachePurgeProviderError,
  PUBLICATION_CACHE_PURGE_EVENT_TYPE,
  PUBLICATION_CACHE_PURGE_EVENT_VERSION,
  PUBLICATION_CACHE_PURGE_HANDLER_NAME,
  VersionedOutboxWorker,
  createExponentialRetryPolicy,
  createPostgresPublicationPublicProfileHandleResolver,
  createPublicationCachePurgeRoutes,
  publicationCachePurgeEnvelopeRegistrations,
  type PublicationCachePurgeProvider,
} from '../../../src/infrastructure/outbox/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateFixtureTables,
} from '../../support/postgres-test-runtime.js';

const logger = { info() {}, warn() {}, error() {} };

describeWithPostgres('publication cache purge PostgreSQL delivery', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('publication_cache_purge');
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
  });

  beforeEach(async () => {
    await truncateFixtureTables(runtime.pool, `truncate table outbox_delivery_receipts,
      outbox_projection_watermarks, outbox_events, nodes, collections,
      resource_id_ledger cascade`);
  });

  afterAll(async () => isolated?.close());

  async function insertPurge(options: {
    readonly suffix: string;
    readonly authoritativeCollection?: boolean;
  }): Promise<{ readonly outboxId: string; readonly eventId: string; readonly collectionId: string }> {
    const outboxId = `purge-outbox-${options.suffix}`;
    const eventId = `purge-event-${options.suffix}`;
    const collectionId = `purge-collection-${options.suffix}`;
    const rootId = `purge-root-${options.suffix}`;
    await runtime.pool.query(
      `insert into resource_id_ledger(resource_id, resource_type) values
       ($1, 'outbox'), ($2, 'domain-event')`,
      [outboxId, eventId],
    );
    if (options.authoritativeCollection) {
      const client = await runtime.pool.connect();
      try {
        await client.query('begin');
        await client.query('set constraints all deferred');
        await client.query(`insert into resource_id_ledger(resource_id, resource_type) values
          ($1, 'collection'), ($2, 'node')`, [collectionId, rootId]);
        await client.query(`insert into collections
          (id, owner_subject_id, title, kind, visibility, root_node_id,
           publication_slug, published_at, resource_revision, content_revision,
           policy_revision, commit_ordinal)
          values ($1, 'owner', 'Published', 'bookmarks', 'public', $2,
            $3, '2026-07-24T00:00:00Z', 'resource-1', 'content-7', 'policy-4', 7)`,
        [collectionId, rootId, `slug-${options.suffix}`]);
        await client.query(`insert into nodes
          (id, collection_id, kind, is_root, title, resource_revision, children_revision)
          values ($1, $2, 'folder', true, 'Root', 'root-resource-1', 'children-1')`,
        [rootId, collectionId]);
        await client.query('commit');
      } catch (error: unknown) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    }
    await runtime.pool.query(`insert into outbox_events(
      outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
      aggregate_type, aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal,
      occurred_at, payload_json, state, attempt_count, available_at, lease_generation
    ) values (
      $1, $2, $3, $4, $5, 'delivery_each_event', 'collection', $6, $6,
      'content-7', 7, '2026-07-24T00:00:00Z', $7::jsonb, 'pending', 0,
      current_timestamp, 0
    )`, [
      outboxId,
      eventId,
      PUBLICATION_CACHE_PURGE_EVENT_TYPE,
      PUBLICATION_CACHE_PURGE_EVENT_VERSION,
      PUBLICATION_CACHE_PURGE_HANDLER_NAME,
      collectionId,
      JSON.stringify({
        collectionId,
        contentRevision: 'content-7',
        policyRevision: 'policy-4',
        publicationSlug: `slug-${options.suffix}`,
        sourceEventType: 'node.updated',
        sourceEventVersion: 1,
        visibility: 'public',
      }),
    ]);
    return { outboxId, eventId, collectionId };
  }

  function worker(
    provider: PublicationCachePurgeProvider,
    resolvePublicProfileHandle?: ReturnType<typeof createPostgresPublicationPublicProfileHandleResolver>,
  ) {
    return new VersionedOutboxWorker({
      repository: new PostgresOutboxRepository(runtime.pool),
      router: new OutboxRouter(createPublicationCachePurgeRoutes({
        provider,
        publicationOrigin: 'https://collections.example.test',
        productOrigin: 'https://app.example.test',
        timeoutMs: 500,
        ...(resolvePublicProfileHandle === undefined ? {} : { resolvePublicProfileHandle }),
        ...(resolvePublicProfileHandle === undefined ? {} : {
          isCanonicalPublicProfileHandle: (value: string) => /^[a-z0-9._~-]{1,64}$/u.test(value),
        }),
      })),
      envelopes: new EventEnvelopeRegistry(publicationCachePurgeEnvelopeRegistrations()),
      logger,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 500,
      handlerTimeoutMs: 500,
      retryPolicy: createExponentialRetryPolicy({
        baseDelayMs: 10, maxDelayMs: 10, maxAttempts: 3, jitterRatio: 0,
      }),
    });
  }

  test('recovers after a crash following the provider effect with one stable idempotency key', async () => {
    const row = await insertPurge({ suffix: 'crash' });
    const applied = new Set<string>();
    const observedKeys: string[] = [];
    let calls = 0;
    const provider: PublicationCachePurgeProvider = {
      async purge(request) {
        calls += 1;
        observedKeys.push(request.idempotencyKey);
        if (!applied.has(request.idempotencyKey)) {
          applied.add(request.idempotencyKey);
          throw new PublicationCachePurgeProviderError(
            'retryable',
            'worker crashed after provider accepted the purge',
          );
        }
      },
    };

    assert.equal(await worker(provider).runOnce(), true);
    const retryable = await runtime.pool.query<{
      state: string; attempt_count: number; receipt_count: number;
    }>(`select state, attempt_count,
      (select count(*)::int from outbox_delivery_receipts
        where handler_name = $2 and domain_event_id = $3) receipt_count
      from outbox_events where outbox_id = $1`, [
      row.outboxId, PUBLICATION_CACHE_PURGE_HANDLER_NAME, row.eventId,
    ]);
    assert.deepEqual(retryable.rows[0], {
      state: 'retryable', attempt_count: 1, receipt_count: 0,
    });

    await runtime.pool.query(
      `update outbox_events set available_at = current_timestamp - interval '1 second'
       where outbox_id = $1`,
      [row.outboxId],
    );
    assert.equal(await worker(provider).runOnce(), true);
    const completed = await runtime.pool.query<{
      state: string; attempt_count: number; receipt_count: number;
    }>(`select state, attempt_count,
      (select count(*)::int from outbox_delivery_receipts
        where handler_name = $2 and domain_event_id = $3) receipt_count
      from outbox_events where outbox_id = $1`, [
      row.outboxId, PUBLICATION_CACHE_PURGE_HANDLER_NAME, row.eventId,
    ]);
    assert.deepEqual(completed.rows[0], {
      state: 'completed', attempt_count: 2, receipt_count: 1,
    });
    assert.equal(calls, 2);
    assert.equal(applied.size, 1);
    assert.equal(observedKeys[0], observedKeys[1]);
  });

  test('uses a real PostgreSQL lease generation to fence the crashed owner', async () => {
    const row = await insertPurge({ suffix: 'lease' });
    const firstRepository = new PostgresOutboxRepository(runtime.pool);
    const secondRepository = new PostgresOutboxRepository(runtime.pool);
    const first = await firstRepository.claim(10_000);
    assert.ok(first);
    assert.equal(first.outboxId, row.outboxId);
    assert.equal(first.leaseGeneration, '1');

    await runtime.pool.query(
      `update outbox_events set locked_until = current_timestamp - interval '1 second'
       where outbox_id = $1`,
      [row.outboxId],
    );
    const takeover = await secondRepository.claim(10_000);
    assert.ok(takeover);
    assert.equal(takeover.outboxId, row.outboxId);
    assert.equal(takeover.leaseGeneration, '2');
    assert.equal(takeover.attemptCount, 2);
    assert.equal(await firstRepository.heartbeat(first, 10_000), false);
    assert.equal(await firstRepository.complete(first), false);
    assert.equal(await firstRepository.fail(first, 'late crash', 10, 3), 'lease_lost');
    assert.equal(await secondRepository.complete(takeover), true);
    assert.equal(await secondRepository.hasDeliveryReceipt(takeover), true);
  });

  test('dead-letters a permanent provider error without undoing committed publication facts', async () => {
    const row = await insertPurge({ suffix: 'permanent', authoritativeCollection: true });
    assert.equal(await worker({
      async purge() {
        throw new PublicationCachePurgeProviderError('permanent', 'invalid provider request');
      },
    }).runOnce(), true);

    const state = await runtime.pool.query<{
      state: string;
      attempt_count: number;
      dead_lettered_at: Date | null;
      last_error: string;
      visibility: string;
      publication_slug: string;
      content_revision: string;
      policy_revision: string;
    }>(`select o.state, o.attempt_count, o.dead_lettered_at, o.last_error,
      c.visibility, c.publication_slug, c.content_revision, c.policy_revision
      from outbox_events o join collections c on c.id = o.aggregate_id
      where o.outbox_id = $1`, [row.outboxId]);
    assert.equal(state.rows[0]?.state, 'dead_letter');
    assert.equal(state.rows[0]?.attempt_count, 1);
    assert.ok(state.rows[0]?.dead_lettered_at instanceof Date);
    assert.match(state.rows[0]?.last_error ?? '', /invalid provider request/u);
    assert.deepEqual({
      visibility: state.rows[0]?.visibility,
      publicationSlug: state.rows[0]?.publication_slug,
      contentRevision: state.rows[0]?.content_revision,
      policyRevision: state.rows[0]?.policy_revision,
    }, {
      visibility: 'public',
      publicationSlug: 'slug-permanent',
      contentRevision: 'content-7',
      policyRevision: 'policy-4',
    });
  });

  test('resolves the authoritative collection owner handle and purges the canonical Profile URL', async () => {
    await runtime.pool.query(`
      insert into accounts(id, subject_id, status) values
        ('IiIiIiIiIiIiIiIiIiIiIg', 'purge-profile-owner', 'active');
      insert into profiles(account_id, display_name) values
        ('IiIiIiIiIiIiIiIiIiIiIg', 'Purge Owner');
      insert into profile_handles(handle, account_id) values
        ('purge_owner', 'IiIiIiIiIiIiIiIiIiIiIg')
    `);
    const row = await insertPurge({ suffix: 'profile-url', authoritativeCollection: true });
    await runtime.pool.query(
      `update collections set owner_subject_id = 'purge-profile-owner' where id = $1`,
      [row.collectionId],
    );
    let requestUrls: readonly string[] = [];
    const provider: PublicationCachePurgeProvider = {
      async purge(request) { requestUrls = request.urls; },
    };
    const resolver = createPostgresPublicationPublicProfileHandleResolver(runtime);
    assert.equal(await worker(provider, resolver).runOnce(), true);
    assert.ok(requestUrls.includes('https://app.example.test/u/purge_owner'));
  });
});
