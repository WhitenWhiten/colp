import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { composePublicProfileProjection } from '../../../src/bootstrap/public-profile-projection.js';
import { loadConfig } from '../../support/test-config.js';
import { createPostgresSharedExposureFactsPort, runMigrations } from '../../../src/infrastructure/database/index.js';
import { createWebShellCache } from '../../../src/infrastructure/http/index.js';
import { createPostgresPublicProfileFactsReadPort } from '../../../src/infrastructure/identity/index.js';
import { createPostgresPublicationDirectoryReadPort } from '../../../src/infrastructure/publication/index.js';
import { createPublicationCursorKeyring } from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { PUBLIC_SHELL_FIXTURE } from '../../unit/publication/public-shell-fixture.js';

describeWithPostgres('M-09 public profile shell PostgreSQL authority', () => {
  let isolated: IsolatedPostgresRuntime;
  const cursors = createPublicationCursorKeyring({
    active: { id: 'profile-shell-pg-v1', secret: Buffer.alloc(32, 83).toString('base64') },
    retained: [],
  });

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('public_profile_shell', { maxConnections: 6 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seed(isolated);
  }, 120_000);

  afterAll(async () => {
    cursors.destroy();
    await isolated?.close();
  });

  test('real public-profile projection yields public links, thin noindex, and unknown 404', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://unused/known',
      PRODUCT_ORIGIN: 'https://known.example',
      PUBLICATION_ORIGIN: 'https://known.example',
      LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      KNOWN_FEATURE_PUBLIC_PROFILE_SHELL: 'true',
      WEB_SHELL_ORIGIN: 'http://web:80',
    });
    const query = composePublicProfileProjection({
      profiles: createPostgresPublicProfileFactsReadPort(isolated.runtime),
      collections: createPostgresPublicationDirectoryReadPort(isolated.runtime),
      cursors,
      sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
    });
    const app = buildApiApp({
      config,
      publicProfileQuery: query,
      publicShell: {
        cache: createWebShellCache({
          origin: 'http://web:80',
          fetch: async () => new Response(PUBLIC_SHELL_FIXTURE, { status: 200 }),
        }),
        loadNodeCountBySlug: async () => null,
        loadOwnerDisplayName: async () => null,
      },
      exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
    });
    try {
      const published = await app.inject({ method: 'GET', url: '/u/ada_shell' });
      assert.equal(published.statusCode, 200);
      assert.match(published.body, /<h1>Ada Shell<\/h1>/u);
      assert.match(published.body, /href="\/c\/profile-shell-public"/u);
      assert.doesNotMatch(published.body, /profile-shell-unlisted|profile-shell-private/u);
      assert.doesNotMatch(published.body, /name="robots"/u);

      const thin = await app.inject({ method: 'GET', url: '/u/thin_shell' });
      assert.equal(thin.statusCode, 200);
      assert.match(thin.body, /name="robots" content="noindex"/u);

      const unknown = await app.inject({ method: 'GET', url: '/u/unknown_shell' });
      assert.equal(unknown.statusCode, 404);
      assert.doesNotMatch(unknown.body, /Ada Shell/u);
    } finally {
      await app.close();
    }
  });
});

async function seed(isolated: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(`
      insert into accounts(id, subject_id, status) values
        ('IiIiIiIiIiIiIiIiIiIiIg', 'profile-shell-owner', 'active'),
        ('EREREREREREREREREREREQ', 'profile-shell-thin-owner', 'active');
      insert into profiles(account_id, display_name, about) values
        ('IiIiIiIiIiIiIiIiIiIiIg', 'Ada Shell', 'A public PostgreSQL bio.'),
        ('EREREREREREREREREREREQ', 'Thin Shell', 'No public collections.');
      insert into profile_handles(handle, account_id) values
        ('ada_shell', 'IiIiIiIiIiIiIiIiIiIiIg'),
        ('thin_shell', 'EREREREREREREREREREREQ')
    `);
    const rows = [
      ['profile-shell-public-id', 'profile-shell-public-root', 'public', 'profile-shell-public', true],
      ['profile-shell-unlisted-id', 'profile-shell-unlisted-root', 'unlisted', 'profile-shell-unlisted', true],
      ['profile-shell-private-id', 'profile-shell-private-root', 'private', null, false],
    ] as const;
    for (const [id, rootId, visibility, slug, published] of rows) {
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
        [id, rootId],
      );
      await client.query(
        `insert into collections
          (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
           content_revision, policy_revision, publication_slug, published_at, updated_at)
         values ($1, 'profile-shell-owner', $2, 'bookmarks', $3, $4, 'r1', 'c1', 'p1', $5, $6, $7)`,
        [id, `Title ${visibility}`, visibility, rootId, slug,
          published ? '2026-08-20T00:00:00Z' : null,
          visibility === 'public' ? '2026-08-22T00:00:00Z' : '2026-08-21T00:00:00Z'],
      );
      await client.query(
        `insert into nodes
          (id, collection_id, kind, is_root, title, visibility, resource_revision, children_revision)
         values ($1, $2, 'folder', true, 'Root', 'inherit', 'nr1', 'ch1')`,
        [rootId, id],
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
