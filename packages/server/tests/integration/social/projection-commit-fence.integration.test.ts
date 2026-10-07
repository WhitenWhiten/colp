import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { beforeAll, afterAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresSocialFeedWorkerRepository } from '../../../src/infrastructure/social/feed-worker-postgres.js';
import { createPostgresPublicActivityWorkerRepository } from '../../../src/infrastructure/social/public-activity-worker-postgres.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedProfileAndCollection } from '../../support/social-feed-fixture.js';

/**
 * RUNTIME-02: a social projection must be fenced on the lease at the moment it
 * commits, not merely when it starts.
 *
 * Two arrangements, each aimed at a different weakness of the pre-fix code:
 *
 * - `takeover` bumps `lease_generation` from a second connection while the
 *   projecting transaction holds uncommitted projection rows. A generation
 *   mismatch is visible to any reader, so this is the coarse guard. The
 *   pre-fix Feed/Activity code already caught it in its final SELECT; Follow,
 *   which had no final SELECT, did not.
 * - `expired` lets real wall-clock time pass the seeded `locked_until` while the
 *   projecting transaction is still open. PostgreSQL freezes
 *   `current_timestamp` at transaction start, so the pre-fix final
 *   `locked_until > current_timestamp` SELECT still reported ownership and
 *   committed the rows. Only the commit-time fence — which locks the outbox row
 *   and evaluates `clock_timestamp()` in a statement of its own — can observe
 *   the expiry. This arrangement is deliberately red against the pre-fix
 *   production code for all three projection paths, so a green run cannot be
 *   vacuous for Feed and Activity either.
 */
describeWithPostgres('RUNTIME-02 projection commit lease fence', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('projection_commit_fence', { maxConnections: 6 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());
  for (const kind of ['follow', 'feed', 'activity'] as const) {
    test.each(['owned', 'takeover', 'expired'] as const)(`${kind} commits only a current owner: %s`, async (change) => {
      const id = randomUUID();
      const recipient = `recipient-${id}`, actor = `actor-${id}`, collectionId = `col-${id}`;
      const eventId = `event-${id}`, outboxId = `outbox-${id}`, now = new Date();
      const pool = isolated.runtime.pool;
      await seedProfileAndCollection(isolated, recipient, actor, collectionId);
      await pool.query(`insert into follows(actor_profile_id,target_profile_id,followed_at)
        values($1,$2,current_timestamp-interval '1 minute')`, [recipient, actor]);
      const handler = kind === 'follow' ? 'social_feed_follow_activity'
        : kind === 'feed' ? 'social.publish-collection-change' : 'social.publish-public-activity';
      await pool.query(`insert into resource_id_ledger(resource_id,resource_type)
        values($1,'social-domain-event'),($2,'social-outbox')`, [eventId, outboxId]);
      // The lease outlives the transaction start but not the arranged delay, so
      // the pre-fix transaction-start `current_timestamp` check still passes.
      await pool.query(`insert into outbox_events(outbox_id,domain_event_id,event_type,event_version,
        handler_name,handler_mode,aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,
        commit_ordinal,occurred_at,payload_json,state,attempt_count,available_at,lease_generation,locked_until)
        values($1,$2,$3,1,$4,'delivery_each_event','collection',$5,$6,'c1',$7,$8,'{}','leased',
          1,current_timestamp,1,current_timestamp+interval '250 milliseconds')`,
      [outboxId,eventId,kind === 'follow' ? 'social.follow-created' : 'social.collection-change',
        handler,collectionId,kind === 'follow' ? actor : collectionId,kind === 'follow' ? null : '1',now]);
      let written = false;
      const observedPool = { async connect() {
        const client = await pool.connect();
        return { async query(statement: string, parameters?: unknown[]) {
          if (!written && /insert into social_(?:feed_items|public_activity)\(/u.test(statement)) {
            written = true;
            // Schedule the discriminating change strictly between the
            // projection INSERT and the transaction's final lease read.
            if (change === 'takeover') {
              await pool.query('update outbox_events set lease_generation=2 where outbox_id=$1', [outboxId]);
            } else if (change === 'expired') {
              await new Promise((resolve) => setTimeout(resolve, 400));
            }
          }
          return client.query(statement, parameters);
        }, release() { client.release(); } };
      } } as unknown as Pool;
      const attempt = { outboxId, leaseGeneration: '1' };
      const signal = new AbortController().signal;
      const event = { eventId, eventVersion: 1 as const, collectionId, ownerProfileId: actor,
        publicationRevision: 'c1', discoverabilityRecheckKey: `publication.collection:${collectionId}`,
        producerDiscoverability: null, commitOrdinal: '1', occurredAt: now };
      const feed = createPostgresSocialFeedWorkerRepository(observedPool);
      const result = kind === 'follow'
        ? await feed.projectFollowActivity({ attempt, signal, event: {
            eventId,eventVersion:1,actorProfileId:recipient,targetProfileId:actor,occurredAt:now,
          } })
        : kind === 'feed'
          ? await feed.projectCollectionChange({ attempt, signal, event, maxRecipients: 100 })
          : await createPostgresPublicActivityWorkerRepository(observedPool).projectCollectionChange({ attempt, signal, event });
      assert.equal(written, true, 'actual projection writes must precede the arranged lease change');
      assert.equal(result.disposition, change === 'owned' ? 'applied' : 'lease_lost');
      const rows = await pool.query(`select
        (select count(*) from social_feed_items where source_event_id=$1)::int as feed,
        (select count(*) from social_public_activity where source_event_id=$1)::int as activity,
        (select count(*) from social_feed_watermarks where aggregate_scope=$2)::int as watermarks,
        (select count(*) from outbox_events where outbox_id<>$3 and payload_json->>'collectionId'=$2)::int as intents`,
      [eventId, collectionId, outboxId]);
      if (change !== 'owned') assert.deepEqual(rows.rows[0], { feed: 0, activity: 0, watermarks: 0, intents: 0 });
    }, 30_000);
  }
});
