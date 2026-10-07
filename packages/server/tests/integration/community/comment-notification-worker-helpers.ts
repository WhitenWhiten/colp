import { randomUUID } from 'node:crypto';
import { createProductCommunityClient } from '../../../generated/openapi/product-v1.client.js';
import { loadConfig } from '../../support/test-config.js';
import type { WorkerRuntime } from '../../../src/bootstrap/worker.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresCommunityCommentCommandUnitOfWork,
  createPostgresCommunityCommentManageUnitOfWork,
  createPostgresCommunityCommentQueryUnitOfWork,
  createPostgresCommunityNotificationCommandUnitOfWork,
  createPostgresCommunityNotificationQueryUnitOfWork,
  createPostgresCommunityRankingQueryUnitOfWork,
  createPostgresCommunityTargetQueryUnitOfWork,
  createPostgresCommunityVoteCommandUnitOfWork,
} from '../../../src/infrastructure/community/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  createPostgresBetterAuthTestFactory,
  type PostgresBetterAuthTestFactory,
} from '../../support/better-auth-test-factory.js';
import { issueTestSession, type AuthenticatedTestClient } from '../../support/product-http-harness.js';
import type { IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

export type CommunityWorker = NonNullable<WorkerRuntime['outbox']>;

export interface IssuedUser extends AuthenticatedTestClient {
  readonly handle: string;
}

export interface CommunityOutboxRow {
  readonly outbox_id: string;
  readonly domain_event_id: string;
  readonly aggregate_id: string;
  readonly aggregate_scope: string;
  readonly state: string;
}

/**
 * Shared fixture for the comment notification worker suites: app composition
 * plus the outbox-drain / inbox-count helpers the tests drive through SQL.
 * The getter defers `isolated` so each suite keeps its own schema lifecycle.
 */
export function createCommentNotificationFixture(getIsolated: () => IsolatedPostgresRuntime) {
  function baseEnv(): Record<string, string | undefined> {
    return { ...process.env, DATABASE_URL: getIsolated().databaseUrl,
      NODE_ENV: 'test', LOG_LEVEL: 'silent', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 9).toString('base64') };
  }

  function testConfig(): ReturnType<typeof loadConfig> {
    return loadConfig(baseEnv());
  }

  function workerConfig(): ReturnType<typeof loadConfig> {
    return loadConfig({ ...baseEnv(),
      WORKER_CONCURRENCY: '2', WORKER_BATCH_SIZE: '2',
      WORKER_POLL_INTERVAL_MS: '5', WORKER_LEASE_DURATION_MS: '500',
      WORKER_HEARTBEAT_INTERVAL_MS: '100', WORKER_HANDLER_TIMEOUT_MS: '450',
      FEED_REBUILD_TIMEOUT_MS: '400', NOTIFICATION_RECOVERY_TIMEOUT_MS: '400' });
  }

  async function startApp(config: ReturnType<typeof loadConfig>): Promise<{
    app: { close(): Promise<unknown> };
    origin: string;
    factory: PostgresBetterAuthTestFactory;
  }> {
    const isolated = getIsolated();
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db,
      { oidcTransactionSecrets: config.oidcTransactionSecrets });
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    const app = buildApiApp({ config, identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
      communityTargetQueryUnitOfWork: createPostgresCommunityTargetQueryUnitOfWork(isolated.runtime.db),
      communityVoteCommandUnitOfWork: createPostgresCommunityVoteCommandUnitOfWork(isolated.runtime.db),
      communityRankingQueryUnitOfWork: createPostgresCommunityRankingQueryUnitOfWork(isolated.runtime.db),
      communityCommentQueryUnitOfWork: createPostgresCommunityCommentQueryUnitOfWork(isolated.runtime.db),
      communityCommentCommandUnitOfWork: createPostgresCommunityCommentCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }),
      communityCommentManageUnitOfWork: createPostgresCommunityCommentManageUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }),
      communityNotificationQueryUnitOfWork: createPostgresCommunityNotificationQueryUnitOfWork(isolated.runtime.db),
      communityNotificationCommandUnitOfWork: createPostgresCommunityNotificationCommandUnitOfWork(isolated.runtime.db, {
        etagHmacKey: config.community.cursorHmacKey,
      }) });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    return { app, origin, factory };
  }

  async function issueUser(factory: PostgresBetterAuthTestFactory, role: string): Promise<IssuedUser> {
    const handle = `cnw${role}${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const client = await issueTestSession({ factory,
      subject: `cnw-${role}-${randomUUID()}`, handle });
    return { ...client, handle };
  }

  function communityClient(origin: string, config: ReturnType<typeof loadConfig>,
    user?: IssuedUser) {
    return user === undefined
      ? createProductCommunityClient({ origin })
      : createProductCommunityClient({ origin, sessionCookie: user.cookie,
        originHeader: config.productOrigin, csrfToken: user.csrfToken });
  }

  async function seedCollection(
    collectionId: string,
    ownerSubjectId: string,
    visibility: 'public' | 'unlisted' | 'private' | 'protected',
    slug: string,
  ): Promise<string> {
    const rootId = `root-${collectionId}`;
    const client = await getIsolated().runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger(resource_id,resource_type,committed_at)
         values($1,'collection',current_timestamp),($2,'node',current_timestamp)`,
        [collectionId, rootId],
      );
      await client.query(`insert into collections(
        id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
        root_node_id,root_node_is_root,resource_revision,content_revision,policy_revision,
        commit_ordinal,created_at,updated_at)
        values($1,$2,$6,'bookmarks',$5,$4,current_timestamp,$3,true,
          'r1','c1','p1',1,current_timestamp,current_timestamp)`,
      [collectionId, ownerSubjectId, rootId, slug, visibility, 'Comment target']);
      await client.query(`insert into nodes(
        id,collection_id,parent_id,kind,is_root,title,url,position_token,
        resource_revision,children_revision,created_at,updated_at)
        values($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',
          current_timestamp,current_timestamp)`, [rootId, collectionId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return rootId;
  }

  /**
   * Durable comment row written WITHOUT an outbox event — fixture parents
   * stay silent so each test controls exactly which notification events
   * exist (HTTP replies are the only producers).
   */
  async function seedCommentRow(row: {
    id: string;
    targetKind: 'collection' | 'bookmark' | 'digest_series' | 'digest_edition';
    targetId: string;
    collectionId?: string | null;
    seriesId?: string | null;
    generation: string;
    rootId?: string;
    replyToId?: string | null;
    depth?: number;
    authorAccountId: string;
    body?: string | null;
    state?: 'visible' | 'hidden' | 'deleted';
    minutesAgo?: number;
  }): Promise<void> {
    const depth = row.depth ?? 0;
    const created = `current_timestamp - interval '${row.minutesAgo ?? 0} minutes'`;
    const client = await getIsolated().runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into resource_id_ledger(resource_id,resource_type,committed_at)
         values($1,'community_comment',current_timestamp)`, [row.id]);
      await client.query(`insert into community_comments(
        comment_id,target_kind,target_id,target_collection_id,target_series_id,
        target_generation,root_id,reply_to_id,depth,author_account_id,body,state,
        revision,created_at,updated_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,${created},${created})`, [
        row.id, row.targetKind, row.targetId, row.collectionId ?? null, row.seriesId ?? null,
        row.generation, row.rootId ?? row.id, row.replyToId ?? null, depth,
        row.authorAccountId, row.body ?? null, row.state ?? 'visible',
      ]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function rawGet(origin: string, path: string, cookie?: string): Promise<{
    status: number;
    etag: string | null;
    body: { error?: { code?: string } };
  }> {
    const response = await fetch(`${origin}${path}`, {
      headers: cookie === undefined ? {} : { cookie },
    });
    return {
      status: response.status,
      etag: response.headers.get('etag'),
      body: await response.json(),
    };
  }

  async function forceReady(): Promise<void> {
    await getIsolated().runtime.pool.query(`update outbox_events set available_at=current_timestamp
      where state='retryable'`);
  }

  /** Drain one worker instance until no claimable event remains. */
  async function drainWorker(target: CommunityWorker, limit = 100): Promise<void> {
    for (let index = 0; index < limit; index += 1) {
      await forceReady();
      if (!await target.runOnce()) return;
    }
    throw new Error('community notification worker drain exceeded its bounded test budget');
  }

  /** The community.comment-created outbox rows produced for one comment. */
  async function outboxRowsForComment(commentId: string): Promise<readonly CommunityOutboxRow[]> {
    const result = await getIsolated().runtime.pool.query<CommunityOutboxRow>(
      `select outbox_id, domain_event_id, aggregate_id, aggregate_scope, state
       from outbox_events
       where event_type='community.comment-created' and aggregate_id=$1
       order by aggregate_scope`, [commentId]);
    return result.rows;
  }

  async function notificationCountForEvent(domainEventId: string): Promise<number> {
    const result = await getIsolated().runtime.pool.query<{ count: number }>(
      `select count(*)::int count from notifications where source_event_id=$1`,
      [domainEventId]);
    return result.rows[0]!.count;
  }

  async function notificationCountForRecipient(recipientAccountId: string,
    notificationType = 'comment_reply'): Promise<number> {
    const result = await getIsolated().runtime.pool.query<{ count: number }>(
      `select count(*)::int count from notifications
       where recipient_account_id=$1 and notification_type=$2`,
      [recipientAccountId, notificationType]);
    return result.rows[0]!.count;
  }

  /** Requeue one completed outbox row exactly like a redelivery after lease loss. */
  async function replayEvent(outboxId: string): Promise<void> {
    await getIsolated().runtime.pool.query(`update outbox_events set state='retryable',
      available_at=current_timestamp, locked_until=null, completed_at=null, last_error=null
      where outbox_id=$1`, [outboxId]);
  }

  async function setChannelPreference(accountId: string,
    channel: 'in_app' | 'email' | 'community', enabled: boolean): Promise<void> {
    await getIsolated().runtime.pool.query(`insert into notification_preferences(
      recipient_account_id,channel,enabled) values($1,$2,$3)
      on conflict(recipient_account_id,channel) do update set enabled=excluded.enabled,
      state_revision=notification_preferences.state_revision+1,updated_at=current_timestamp`,
    [accountId, channel, enabled]);
  }

  async function setCollectionVisibility(collectionId: string,
    visibility: 'public' | 'unlisted' | 'private' | 'protected'): Promise<void> {
    await getIsolated().runtime.pool.query(`update collections set visibility=$2 where id=$1`,
      [collectionId, visibility]);
  }

  return {
    baseEnv,
    testConfig,
    workerConfig,
    startApp,
    issueUser,
    communityClient,
    seedCollection,
    seedCommentRow,
    rawGet,
    forceReady,
    drainWorker,
    outboxRowsForComment,
    notificationCountForEvent,
    notificationCountForRecipient,
    replayEvent,
    setChannelPreference,
    setCollectionVisibility,
  };
}
