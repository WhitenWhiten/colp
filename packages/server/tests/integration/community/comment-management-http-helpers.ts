import { randomUUID } from 'node:crypto';
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
import { buildApiApp } from '../../../src/transport/app.js';
import {
  createPostgresBetterAuthTestFactory,
  type PostgresBetterAuthTestFactory,
} from '../../support/better-auth-test-factory.js';
import {
  issueTestSession,
  type AuthenticatedTestClient,
} from '../../support/product-http-harness.js';
import type { IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

export const COMMENT_ETAG = /^"community-comment:[A-Za-z0-9_-]{32}"$/u;
export const CURATION_ETAG = /^"community-curation:[A-Za-z0-9_-]{32}"$/u;
export const SETTINGS_ETAG = /^"community-comment-settings:[A-Za-z0-9_-]{32}"$/u;

export interface ErrorWire {
  error?: { code?: string; currentEtag?: string | null };
}
export interface TargetWire {
  kind: string;
  id: string;
  collectionId: string | null;
  seriesId: string | null;
  generation: string;
}
export interface CommentWire extends ErrorWire {
  id: string;
  target: TargetWire;
  rootId: string;
  replyToId: string | null;
  depth: number;
  body: string | null;
  state: string;
  revision: string;
  replyCount: number;
  canEdit: boolean;
  canDelete: boolean;
  canCurate: boolean;
}
export interface CurationWire extends ErrorWire {
  commentId: string;
  hidden: boolean;
  reason: string | null;
  revision: string;
  updatedAt: string;
}
export interface SettingsWire extends ErrorWire {
  target: TargetWire;
  locked: boolean;
  reason: string | null;
  revision: string;
  updatedAt: string;
}
export interface RawResponse<T extends ErrorWire> {
  status: number;
  etag: string | null;
  body: T | null;
}
export type Session = Pick<AuthenticatedTestClient, 'cookie' | 'csrfToken'>;

export const collectionTarget = (collectionId: string): TargetWire => ({
  kind: 'collection', id: collectionId, collectionId: null, seriesId: null,
  generation: 'static-v1',
});
export const commentPath = (commentId: string) => `/api/v1/community/comments/${commentId}`;
export const curationPath = (commentId: string) => `${commentPath(commentId)}/curation`;
export const repliesPath = (commentId: string) => `${commentPath(commentId)}/replies`;
export const settingsPath = (collectionId: string) =>
  `/api/v1/community/comment-settings?kind=collection&id=${collectionId}&generation=static-v1`;
export const settingsBody = (collectionId: string, locked: boolean, reason: string) => ({
  target: collectionTarget(collectionId), locked, reason,
});
export const curationBody = (hidden: boolean, reason: string) => ({ hidden, reason });

export async function rawGet<T extends ErrorWire = ErrorWire>(
  origin: string,
  path: string,
  cookie?: string,
): Promise<RawResponse<T>> {
  const response = await fetch(`${origin}${path}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
  return {
    status: response.status,
    etag: response.headers.get('etag'),
    body: await response.json() as T,
  };
}

/** Session + Origin + CSRF + Known-Command-Id mutation request; If-Match only when given. */
export async function sendMutation<T extends ErrorWire = ErrorWire>(input: {
  origin: string;
  productOrigin: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  client: Session;
  body?: unknown;
  ifMatch?: string;
  commandId?: string;
}): Promise<RawResponse<T>> {
  const headers: Record<string, string> = {
    cookie: input.client.cookie,
    origin: input.productOrigin,
    'x-csrf-token': input.client.csrfToken,
    'known-command-id': input.commandId ?? randomUUID(),
  };
  if (input.ifMatch !== undefined) headers['if-match'] = input.ifMatch;
  let payload: string | undefined;
  if (input.body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(input.body);
  }
  const response = await fetch(`${input.origin}${input.path}`, {
    method: input.method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  });
  return {
    status: response.status,
    etag: response.headers.get('etag'),
    body: await response.json().catch(() => null) as T | null,
  };
}

export async function postComment(
  origin: string,
  productOrigin: string,
  client: Session,
  target: TargetWire,
  body: string,
  replyToId: string | null = null,
): Promise<RawResponse<CommentWire>> {
  return sendMutation<CommentWire>({
    origin, productOrigin, method: 'POST', path: '/api/v1/community/comments',
    client, body: { target, body, replyToId },
  });
}

export const session = (factory: PostgresBetterAuthTestFactory, role: string) =>
  issueTestSession({ factory,
    subject: `cmgmt-${role}-${randomUUID()}`,
    handle: `cm${randomUUID().replaceAll('-', '').slice(0, 12)}` });

/**
 * Shared fixture for the comment management HTTP suites: app composition with
 * every community unit of work wired, plus the isolated-schema seeders. The
 * getter defers `isolated` so each suite keeps its own schema lifecycle.
 */
export function createCommentManagementHttpFixture(getIsolated: () => IsolatedPostgresRuntime) {
  function testConfig(): ReturnType<typeof loadConfig> {
    return loadConfig({ ...process.env, DATABASE_URL: getIsolated().databaseUrl,
      NODE_ENV: 'test', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000', KNOWN_FEATURE_COMMUNITY: 'true',
      COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 9).toString('base64') });
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

  async function setCollectionVisibility(
    collectionId: string,
    visibility: 'public' | 'unlisted' | 'private' | 'protected',
  ): Promise<void> {
    await getIsolated().runtime.pool.query(
      `update collections set visibility=$2, updated_at=current_timestamp where id=$1`,
      [collectionId, visibility]);
  }

  return { testConfig, startApp, seedCollection, setCollectionVisibility };
}
