/**
 * FO-07 review: the batch enqueue must not issue one INSERT round trip per
 * candidate inside the request transaction. `insertItems` now writes bounded
 * multi-row statements (FAVICON_JOB_ITEM_INSERT_BATCH = 512 rows/statement),
 * so a many-node library enqueues in a constant number of statements.
 *
 * Real PostgreSQL + real bootstrap app; the enqueue SQL is captured through a
 * Kysely plugin, exactly like the r14 subtree-delete batching evidence.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresCollectionsUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { issueTestSession, createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { FAVICON_JOB_ITEM_INSERT_BATCH } from '../../../src/infrastructure/collections/favicon-job-items-postgres.js';

const ORIGIN = 'https://app.example.test';
const ISSUER = 'https://issuer.example.test/realms/known';
const NODES = 1_050;

describeWithPostgres('FO-07 batch enqueue is bounded (multi-row inserts)', () => {
  let isolated: IsolatedPostgresRuntime;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let owner: { cookie: string; csrfToken: string; accountId: string; subjectId: string };
  let config: ReturnType<typeof loadConfig>;

  const COLLECTION = Buffer.alloc(16, 91).toString('base64url');
  const ROOT = Buffer.alloc(16, 92).toString('base64url');

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('fo7_enqueue_scale', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
    config = loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN,
      OIDC_ISSUER: ISSUER,
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: `${ISSUER}/auth`,
      OIDC_TOKEN_ENDPOINT: `${ISSUER}/token`,
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      KNOWN_FEATURE_FAVICON_POLICY: 'true',
      FAVICON_CURSOR_HMAC_KEY: Buffer.alloc(32, 42).toString('base64url'),
    });
    factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    owner = await issueTestSession({ factory,
      subject: `fo7s-owner-${randomUUID()}`, handle: `fo7s${randomUUID().replaceAll('-', '').slice(0, 12)}` });

    // Seed one collection with NODES live bookmark nodes (raw SQL bypasses the
    // canonical writer, which the candidate selector does not need).
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
        [COLLECTION, ROOT]);
      await client.query(
        `insert into collections
           (id, owner_subject_id, title, kind, visibility, root_node_id,
            resource_revision, content_revision, policy_revision, commit_ordinal)
         values ($1, $2, 'FO-07 scale', 'bookmarks', 'private', $3, 'r1', 'c1', 'p1', 1)`,
        [COLLECTION, owner.subjectId, ROOT]);
      await client.query(
        `insert into nodes (id, collection_id, kind, is_root, title, resource_revision, children_revision)
         values ($1, $2, 'folder', true, 'Root', 'r1', 'ch1')`, [ROOT, COLLECTION]);
      await client.query(
        `insert into collection_members(collection_id, subject_id, role, granted_at)
         values ($1, $2, 'owner', now())`, [COLLECTION, owner.subjectId]);
      for (let i = 0; i < NODES; i += 1) {
        const id = `fo7s-node-${String(i).padStart(6, '0')}`;
        await client.query(
          `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'node') on conflict do nothing`,
          [id]);
        await client.query(
          `insert into nodes (
             id, collection_id, parent_id, kind, is_root, title, url, position_token,
             resource_revision, children_revision, created_at, updated_at
           ) values ($1, $2, $3, 'bookmark', false, $4, $5, $1, $6, 'ch1', now(), now())`,
          [id, COLLECTION, ROOT, `Node ${i}`, `https://scale${i}.example.org/${i}`, `res-${i}`]);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }, 240_000);

  afterAll(async () => isolated?.close());

  function buildAppWithCountedDb(captured: Array<{ sql: string }>) {
    const baseExecutor = isolated.runtime.db.getExecutor();
    const countedDb = isolated.runtime.db.withPlugin({
      transformQuery(args) {
        const compiled = baseExecutor.compileQuery(args.node, args.queryId);
        captured.push({ sql: compiled.sql });
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    return buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(countedDb),
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(countedDb),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(countedDb, {
        productOrigin: ORIGIN,
      }),
      browserSessionAuthority: factory.authority,
      faviconStore: { async put() {}, async get() { return null; }, async delete() {} },
    });
  }

  test('fill_missing enqueue writes bounded multi-row statements and keeps the exact total', async () => {
    const captured: Array<{ sql: string }> = [];
    const app = buildAppWithCountedDb(captured);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const created = await api('POST', `${address}/api/v1/me/favicon-jobs`, {
        cookie: owner.cookie, csrf: owner.csrfToken, commandId: randomUUID(),
        body: { operation: 'fill_missing', policyRevision: '1' },
      });
      assert.equal(created.status, 202, JSON.stringify(created.json));
      const jobId = (created.json as { jobId: string }).jobId;

      const job = (await isolated.runtime.pool.query(
        `select operation, total from favicon_jobs where id = $1`, [jobId])).rows[0] as
        { operation: string; total: string };
      assert.equal(job.operation, 'fill_missing');
      assert.equal(Number(job.total), NODES, 'every live bookmark is covered');

      const itemInserts = captured.filter((entry) => /insert into "favicon_job_items"/i.test(entry.sql));
      const expectedStatements = Math.ceil(NODES / FAVICON_JOB_ITEM_INSERT_BATCH);
      assert.equal(itemInserts.length, expectedStatements,
        `fill_missing for ${NODES} nodes must need ceil(NODES/${FAVICON_JOB_ITEM_INSERT_BATCH})=${expectedStatements} multi-row statements, got ${itemInserts.length}`);
      for (const statement of itemInserts) {
        // Max 512 rows per statement (16 columns each → ≤ 8192 params).
        const rows = statement.sql.match(/\)\s*\(/gu)?.length ?? 0;
        assert.ok(rows <= FAVICON_JOB_ITEM_INSERT_BATCH, `statement has ${rows} rows, cap ${FAVICON_JOB_ITEM_INSERT_BATCH}`);
      }

      const count = (await isolated.runtime.pool.query(
        `select count(*)::int n from favicon_job_items where job_id = $1`, [jobId])).rows[0]?.n as number;
      assert.equal(count, NODES);
    } finally { await app.close(); }
  });
});

function api(method: string, url: string, options: {
  cookie?: string; csrf?: string; commandId?: string; body?: unknown;
} = {}): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.Cookie = options.cookie;
  if (options.csrf !== undefined) {
    headers.Origin = ORIGIN;
    headers['X-CSRF-Token'] = options.csrf;
  }
  if (options.commandId !== undefined) headers['Known-Command-Id'] = options.commandId;
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        if (text.length > 0) {
          try { json = JSON.parse(text) as unknown; } catch { json = text; }
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}