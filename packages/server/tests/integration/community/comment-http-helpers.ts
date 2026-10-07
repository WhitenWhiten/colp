import { loadConfig } from '../../support/test-config.js';
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
import {
  createPostgresModerationCommandUnitOfWork,
  createPostgresModerationQueryPorts,
} from '../../../src/infrastructure/governance/postgres-moderation.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  createPostgresBetterAuthTestFactory,
  type PostgresBetterAuthTestFactory,
} from '../../support/better-auth-test-factory.js';
import type { IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

/**
 * Shared fixture for the community comment HTTP integration suites: app
 * composition with every community unit of work wired, plus the collection /
 * bookmark / comment seeders the comment tests drive directly through SQL.
 * The getter defers `isolated` so each suite keeps its own schema lifecycle.
 */
export function createCommentHttpFixture(getIsolated: () => IsolatedPostgresRuntime) {
  function testConfig(extra: Record<string, string> = {}): ReturnType<typeof loadConfig> {
    return loadConfig({ ...process.env, DATABASE_URL: getIsolated().databaseUrl,
      NODE_ENV: 'test', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 9).toString('base64'),
      ...extra });
  }

  async function startApp(
    config: ReturnType<typeof loadConfig>,
    options: { readonly governance?: boolean } = {},
  ): Promise<{
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
      }),
      ...(options.governance
        ? {
            moderationCommandUnitOfWork: createPostgresModerationCommandUnitOfWork(isolated.runtime.db),
            moderationQueryPorts: createPostgresModerationQueryPorts(isolated.runtime.db),
          }
        : {}),
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    return { app, origin, factory };
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

  async function seedBookmark(nodeId: string, collectionId: string, parentId: string): Promise<void> {
    await getIsolated().runtime.pool.query(
      `insert into resource_id_ledger(resource_id,resource_type,committed_at)
       values($1,'node',current_timestamp)`, [nodeId]);
    await getIsolated().runtime.pool.query(`insert into nodes(
      id,collection_id,parent_id,kind,is_root,title,url,position_token,
      resource_revision,children_revision,created_at,updated_at)
      values($1,$2,$3,'bookmark',false,'Bookmark','https://example.com/one','a0','r1','ch1',
        current_timestamp,current_timestamp)`, [nodeId, collectionId, parentId]);
  }

  /** Durable comment row with caller-controlled ordering timestamps. */
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

  return {
    testConfig,
    startApp,
    seedCollection,
    seedBookmark,
    seedCommentRow,
    rawGet,
  };
}

export function isProductClientError(error: unknown, status: number, code: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { status?: unknown; problem?: { error?: { code?: unknown } } };
  return value.status === status && value.problem?.error?.code === code;
}
