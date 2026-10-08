import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createWebShellCache } from '../../../src/infrastructure/http/index.js';
import {
  createPostgresPublicationMetadataReadPort,
  createPostgresPublicationNodeCountReadPort,
} from '../../../src/infrastructure/publication/index.js';
import { createPostgresPublicProfileFactsReadPort } from '../../../src/infrastructure/identity/index.js';
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

describeWithPostgres('T-10 public HTML shell injection', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('public_shell_html');
    await runMigrations(isolated.runtime.db, 'latest');
    await seedPublicShellFixtures(isolated);
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('serves injected HTML and headers for a published public collection', async () => {
    const app = buildShellApp(isolated);
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/c/shell-public',
        headers: { accept: 'text/html' },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], PUBLIC_SHELL_CONTENT_TYPE);
      assert.equal(response.headers['cache-control'], PUBLIC_SHELL_CACHE_CONTROL);
      assert.equal(response.headers['cloudflare-cdn-cache-control'], PUBLIC_SHELL_CDN_CACHE_CONTROL);
      assert.equal(response.headers.vary, PUBLIC_SHELL_VARY);
      assert.match(response.body, /<title>Shell Public — Know-N<\/title>/u);
      assert.match(response.body, /<meta name="description" content="A seeded public collection\." \/>/u);
      assert.match(response.body, /<link rel="canonical" href="https:\/\/know-n\.com\/c\/shell-public" \/>/u);
      assert.match(response.body, /<html lang="zh-CN">/u);
      assert.match(response.body, /<meta property="og:locale" content="zh_CN" \/>/u);
      assert.equal([...response.body.matchAll(/property="og:locale"/gu)].length, 1);
      assert.match(response.body, /<meta property="og:url" content="https:\/\/know-n\.com\/c\/shell-public" \/>/u);
      assert.match(response.body, /"@type": "CollectionPage"/u);
      assert.match(response.body, /"numberOfItems": 1/u);
      assert.match(response.body, /<h1>Shell Public<\/h1>/u);
      assert.match(response.body, /Curated by Ada Curator · 1 items/u);
      assert.match(response.body, /href="\/colp\/v0\.1\/collections\/shell-public\/snapshot"/u);

      const share = await app.inject({ method: 'GET', url: '/share/shell-public' });
      assert.equal(share.statusCode, 200);
      assert.match(share.body, /<link rel="canonical" href="https:\/\/know-n\.com\/c\/shell-public" \/>/u);
      assert.match(share.body, /og:url" content="https:\/\/know-n\.com\/share\/shell-public"/u);

      const unknown = await app.inject({ method: 'GET', url: '/c/definitely-not-a-slug' });
      assert.equal(unknown.statusCode, 404);
      assert.match(unknown.body, /<title>Know-N<\/title>/u);
      assert.doesNotMatch(unknown.body, /Shell Public — Know-N/u);
    } finally {
      await app.close();
    }
  });
});

function buildShellApp(isolated: IsolatedPostgresRuntime) {
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
  return buildApiApp({
    config,
    exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
    publicationMetadataQuery: {
      reads: createPostgresPublicationMetadataReadPort(isolated.runtime),
      origin: config.publication.origin,
    },
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
    },
  });
}

async function seedPublicShellFixtures(isolated: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(
      `insert into accounts(id, subject_id, status) values ('01SHELLPUBLICACCOUNT0A', 'shell-owner', 'active')`,
    );
    await client.query(
      `insert into profiles(account_id, display_name) values ('01SHELLPUBLICACCOUNT0A', 'Ada Curator')`,
    );
    await client.query(
      `insert into profile_handles(handle, account_id) values ('ada_curator', '01SHELLPUBLICACCOUNT0A')`,
    );
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type)
       values ('shell-public', 'collection'), ('shell-public-root', 'node')`,
    );
    await client.query(
      `insert into collections
        (id, owner_subject_id, title, summary, kind, visibility, root_node_id, resource_revision,
         content_revision, policy_revision, publication_slug, published_at, updated_at,
         payload_json, payload_schema_version, payload_authority_status)
       values ('shell-public', 'shell-owner', 'Shell Public', 'A seeded public collection.',
               'bookmarks', 'public', 'shell-public-root', 'r1', 'c1', 'p1', 'shell-public',
               '2026-07-01T00:00:00Z', '2026-07-23T00:00:00Z',
               '{"extensions":{"language":"zh-cn"}}'::jsonb, 1, 'backfilled')`,
    );
    await client.query(
      `insert into nodes
        (id, collection_id, kind, is_root, title, visibility, resource_revision, children_revision)
       values ('shell-public-root', 'shell-public', 'folder', true, 'Shell Public', 'inherit', 'r1', 'ch1')`,
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
