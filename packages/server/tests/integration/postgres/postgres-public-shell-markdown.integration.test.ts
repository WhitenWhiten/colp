import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import { createPostgresSharedExposureFactsPort, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createWebShellCache,
  PUBLIC_SHELL_MARKDOWN_CONTENT_TYPE,
  toPublicShellMarkdownNode,
} from '../../../src/infrastructure/http/index.js';
import { createPostgresPublicProfileFactsReadPort } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresPublicationMetadataReadPort,
  createPostgresPublicationNodeCountReadPort,
  createPostgresPublicationSnapshotReadPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  createPublicationCursorKeyring,
  getPublicationSnapshotPage,
  PublicationNotFoundError,
  PUBLICATION_SNAPSHOT_MAX_LIMIT,
} from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  PUBLIC_SHELL_CACHE_CONTROL,
  PUBLIC_SHELL_CDN_CACHE_CONTROL,
  PUBLIC_SHELL_CONTENT_TYPE,
  PUBLIC_SHELL_VARY,
} from '../../../src/transport/public-shell-routes.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { PUBLIC_SHELL_FIXTURE } from '../../unit/publication/public-shell-fixture.js';

describeWithPostgres('T-21 public collection markdown', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('public_shell_md');
    await runMigrations(isolated.runtime.db, 'latest');
    await seedPublicShellMarkdownFixtures(isolated);
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('Accept text/markdown returns structured markdown; HTML Accept stays HTML; unknown slug is 404 markdown', async () => {
    const app = buildMarkdownApp(isolated);
    try {
      const markdown = await app.inject({
        method: 'GET',
        url: '/c/shell-md-public',
        headers: { accept: 'text/markdown' },
      });
      assert.equal(markdown.statusCode, 200);
      assert.equal(markdown.headers['content-type'], PUBLIC_SHELL_MARKDOWN_CONTENT_TYPE);
      assert.equal(markdown.headers['cache-control'], PUBLIC_SHELL_CACHE_CONTROL);
      assert.equal(markdown.headers['cloudflare-cdn-cache-control'], PUBLIC_SHELL_CDN_CACHE_CONTROL);
      assert.equal(markdown.headers.vary, PUBLIC_SHELL_VARY);
      assert.match(markdown.headers.vary ?? '', /Accept/u);
      assert.match(markdown.body, /^# Shell Markdown$/mu);
      assert.match(markdown.body, /Curated by Ada Curator/u);
      assert.match(markdown.body, /A seeded markdown collection\./u);
      assert.match(markdown.body, /^## Papers$/mu);
      assert.match(markdown.body, /- \[Example paper\]\(https:\/\/example\.test\/paper\)/u);
      assert.match(markdown.body, /\/colp\/v0\.1\/collections\/shell-md-public\/snapshot/u);
      assert.match(markdown.body, /\/llms\.txt/u);

      const html = await app.inject({
        method: 'GET',
        url: '/c/shell-md-public',
        headers: { accept: 'text/html' },
      });
      assert.equal(html.statusCode, 200);
      assert.equal(html.headers['content-type'], PUBLIC_SHELL_CONTENT_TYPE);
      assert.match(html.body, /<title>Shell Markdown — Know-N<\/title>/u);

      const unknown = await app.inject({
        method: 'GET',
        url: '/c/definitely-not-a-slug',
        headers: { accept: 'text/markdown' },
      });
      assert.equal(unknown.statusCode, 404);
      assert.equal(unknown.headers['content-type'], PUBLIC_SHELL_MARKDOWN_CONTENT_TYPE);
      assert.equal(unknown.headers.vary, PUBLIC_SHELL_VARY);
      assert.match(unknown.body, /\/sitemap\.xml/u);
      assert.match(unknown.body, /\/llms\.txt/u);
      assert.doesNotMatch(unknown.body, /Shell Markdown/u);
    } finally {
      await app.close();
    }
  });
});

function buildMarkdownApp(isolated: IsolatedPostgresRuntime) {
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused/known',
    PRODUCT_ORIGIN: 'https://known.example',
    PUBLICATION_ORIGIN: 'https://known.example',
    LOG_LEVEL: 'silent',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    KNOWN_FEATURE_PUBLIC_SHELL_META: 'true',
    WEB_SHELL_ORIGIN: 'http://web:80',
  });
  const owners = createPostgresPublicProfileFactsReadPort(isolated.runtime);
  const nodeCount = createPostgresPublicationNodeCountReadPort(isolated.runtime);
  const cursors = createPublicationCursorKeyring({
    active: { id: 'shell-md-v1', secret: Buffer.alloc(32, 71).toString('base64') },
    retained: [],
  });
  const snapshotQuery = {
    reads: createPostgresPublicationSnapshotReadPort(isolated.runtime),
    cursors,
    origin: config.publication.origin,
    sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
    accessPolicy: createPostgresAccessPolicyFactsPort(isolated.runtime.db),
  };
  const app = buildApiApp({
    config,
    exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
    publicationMetadataQuery: {
      reads: createPostgresPublicationMetadataReadPort(isolated.runtime),
      origin: config.publication.origin,
    },
    publicationSnapshotQuery: snapshotQuery,
    publicShell: {
      cache: createWebShellCache({
        origin: 'http://web:80',
        fetch: async () => new Response(PUBLIC_SHELL_FIXTURE, {
          status: 200, headers: { etag: '"shell"' },
        }),
      }),
      loadNodeCountBySlug: (slug) => nodeCount.loadByPublicationSlug(slug),
      loadOwnerDisplayName: async (ownerSubjectId) => {
        const owner = await owners.findByOwnerSubjectId(ownerSubjectId);
        return owner?.displayName ?? null;
      },
      loadSnapshotNodes: async (collectionId, signal) => {
        try {
          const page = await getPublicationSnapshotPage(snapshotQuery, {
            collectionId,
            principal: { kind: 'anonymous' },
            query: { limit: PUBLICATION_SNAPSHOT_MAX_LIMIT },
          }, signal);
          return page.snapshot.nodes
            .map(toPublicShellMarkdownNode)
            .filter((node): node is NonNullable<typeof node> => node !== null);
        } catch (error) {
          if (error instanceof PublicationNotFoundError) return null;
          throw error;
        }
      },
    },
  });
  app.addHook('onClose', () => cursors.destroy());
  return app;
}

async function seedPublicShellMarkdownFixtures(isolated: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(
      `insert into accounts(id, subject_id, status) values ('01SHELLMDACCOUNT00000A', 'shell-md-owner', 'active')`,
    );
    await client.query(
      `insert into profiles(account_id, display_name) values ('01SHELLMDACCOUNT00000A', 'Ada Curator')`,
    );
    await client.query(
      `insert into profile_handles(handle, account_id) values ('ada_md_curator', '01SHELLMDACCOUNT00000A')`,
    );
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       values ('shell-md-public', 'collection'), ('shell-md-root', 'node'),
              ('shell-md-folder', 'node'), ('shell-md-bookmark', 'node')`,
    );
    await client.query(
      `insert into collections
        (id, owner_subject_id, title, summary, kind, visibility, root_node_id, resource_revision,
         content_revision, policy_revision, publication_slug, published_at, updated_at)
       values ('shell-md-public', 'shell-md-owner', 'Shell Markdown', 'A seeded markdown collection.',
               'bookmarks', 'public', 'shell-md-root', 'r1', 'c1', 'p1', 'shell-md-public',
               '2026-07-01T00:00:00Z', '2026-07-23T00:00:00Z')`,
    );
    await client.query(
      `insert into nodes
        (id, collection_id, parent_id, kind, is_root, title, url, visibility, position_token,
         resource_revision, children_revision)
       values
         ('shell-md-root', 'shell-md-public', null, 'folder', true, 'Shell Markdown', null,
          'inherit', null, 'r1', 'ch1'),
         ('shell-md-folder', 'shell-md-public', 'shell-md-root', 'folder', false, 'Papers', null,
          'inherit', 'a', 'r1', 'ch1'),
         ('shell-md-bookmark', 'shell-md-public', 'shell-md-folder', 'bookmark', false, 'Example paper',
          'https://example.test/paper', 'inherit', 'a', 'r1', 'ch1')`,
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
