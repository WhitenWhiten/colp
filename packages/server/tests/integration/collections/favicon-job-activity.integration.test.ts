import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { buildApiApp } from '../../../src/transport/app.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresCollectionsUnitOfWork, createPostgresCanonicalMutationUnitOfWork, createPostgresFaviconBatchItemPort } from '../../../src/infrastructure/collections/index.js';
import { makePng } from '../../support/link-preview-fixtures.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { loadConfig } from '../../support/test-config.js';

describeWithPostgres('favicon job activity discovery and live progress', () => {
  let isolated: IsolatedPostgresRuntime;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let owner: Awaited<ReturnType<typeof issueTestSession>>;
  let other: Awaited<ReturnType<typeof issueTestSession>>;
  let config: ReturnType<typeof loadConfig>;
  const batchId = randomUUID();
  const singleId = randomUUID();
  const foreignId = randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('favicon_activity');
    await runMigrations(isolated.runtime.db, 'latest');
    config = loadConfig({ DATABASE_URL: isolated.databaseUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent',
      PRODUCT_ORIGIN: 'https://app.example.test', ALLOWED_ORIGINS: 'https://app.example.test',
      OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      KNOWN_FEATURE_FAVICON_POLICY: 'true', FAVICON_CURSOR_HMAC_KEY: Buffer.alloc(32, 42).toString('base64url') });
    factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    owner = await issueTestSession({ factory, subject: 'favicon-activity-owner', handle: 'faviconactivityowner' });
    other = await issueTestSession({ factory, subject: 'favicon-activity-other', handle: 'faviconactivityother' });
  }, 120_000);
  afterAll(async () => isolated?.close());

  beforeEach(async () => {
    await isolated.runtime.pool.query('DELETE FROM favicon_jobs');
    await isolated.runtime.pool.query('TRUNCATE favicon_provider_cache, favicon_provider_admission');
    await isolated.runtime.pool.query(`
      INSERT INTO favicon_jobs(id,account_id,owner_subject_id,operation,policy_revision,status,total,created_at,updated_at)
      VALUES ($1,$2,$3,'fill_missing',1,'running',4,now(),now()),
             ($4,$2,$3,'refresh_one',1,'pending',1,now()-interval '1 minute',now()),
             ($5,$6,$7,'fill_missing',1,'pending',99,now(),now())
    `, [batchId, owner.accountId, owner.subjectId, singleId, foreignId, other.accountId, other.subjectId]);
    await isolated.runtime.pool.query(`
      INSERT INTO favicon_job_items(job_id,node_id,collection_id,source_url,source_revision,node_resource_revision,status,error_reason,created_at,updated_at)
      SELECT $1, 'node-' || n, 'collection', 'https://icons.example.org/example.com', 1, 'revision',
        CASE n WHEN 1 THEN 'succeeded' WHEN 2 THEN 'failed' WHEN 3 THEN 'skipped' ELSE 'pending' END,
        CASE WHEN n=2 THEN 'invalid_image' ELSE NULL END,now(),now()
      FROM generate_series(1,4) n
    `, [batchId]);
  });

  function app(enabled = true) {
    return buildApiApp({ config: { ...config, faviconPolicy: { ...config.faviconPolicy, enabled } },
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db),
      browserSessionAuthority: factory.authority });
  }

  test('discovers only the owner\'s jobs and reads committed item progress before cycle counters update', async () => {
    const server = app();
    try {
      const response = await server.inject({ method: 'GET', url: '/api/v1/me/favicon-jobs', headers: { cookie: owner.cookie } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.equal(response.headers['set-cookie'], undefined);
      const result = response.json();
      assert.equal(result.activeJobs, 2);
      assert.equal(result.job.id, batchId, 'batch takes precedence over an older individual refresh');
      assert.deepEqual([result.job.total, result.job.succeeded, result.job.failed, result.job.skipped], [4, 1, 1, 1]);
      assert.deepEqual(result.job.errors, [{ nodeId: 'node-2', reason: 'invalid_image' }]);
      const detail = await server.inject({ method: 'GET', url: `/api/v1/me/favicon-jobs/${batchId}`, headers: { cookie: owner.cookie } });
      assert.equal(detail.json().succeeded, 1, 'individual read also exposes live progress');
      const foreign = await server.inject({ method: 'GET', url: '/api/v1/me/favicon-jobs', headers: { cookie: other.cookie } });
      assert.equal(foreign.json().activeJobs, 1);
      assert.equal(foreign.json().job.id, foreignId);
      const anonymous = await server.inject({ method: 'GET', url: '/api/v1/me/favicon-jobs' });
      assert.equal(anonymous.statusCode, 401);
    } finally { await server.close(); }
  });

  test('discovers individual refreshes and returns an empty snapshot when work finishes', async () => {
    const server = app();
    try {
      await isolated.runtime.pool.query("UPDATE favicon_jobs SET status='succeeded' WHERE id=$1", [batchId]);
      const active = await server.inject({ method: 'GET', url: '/api/v1/me/favicon-jobs', headers: { cookie: owner.cookie } });
      assert.equal(active.json().activeJobs, 1);
      assert.equal(active.json().job.id, singleId);
      await isolated.runtime.pool.query("UPDATE favicon_jobs SET status='succeeded' WHERE id=$1", [singleId]);
      const empty = await server.inject({ method: 'GET', url: '/api/v1/me/favicon-jobs', headers: { cookie: owner.cookie } });
      assert.deepEqual(empty.json(), { activeJobs: 0, job: null });
    } finally { await server.close(); }
  });

  test('feature-off conceals activity and rejects unsupported queries', async () => {
    const disabled = app(false);
    const enabled = app();
    try {
      const off = await disabled.inject({ method: 'GET', url: '/api/v1/me/favicon-jobs', headers: { cookie: owner.cookie } });
      assert.equal(off.statusCode, 404);
      const invalid = await enabled.inject({ method: 'GET', url: '/api/v1/me/favicon-jobs?accountId=other', headers: { cookie: owner.cookie } });
      assert.equal(invalid.statusCode, 400);
    } finally { await disabled.close(); await enabled.close(); }
  });

  test('cached items bypass cooldown, blocked providers sleep, and cold candidates are admitted fairly', async () => {
    const { pool, db } = isolated.runtime;
    const items = createPostgresFaviconBatchItemPort(db);
    const source = 'https://icons.example.org/example.com';
    await pool.query(`INSERT INTO favicon_job_items(job_id,node_id,collection_id,source_url,source_revision,
      node_resource_revision,status,created_at,updated_at)
      SELECT $1, name, 'collection', 'https://icons.example.org/' || name, 1, 'revision', 'pending', now(), now()-interval '1 day'
      FROM unnest(ARRAY['cold-a','cold-b']) name`, [batchId]);
    await pool.query(`INSERT INTO favicon_provider_cache(source_key,body,expires_at)
      VALUES ($1,$2,now()+interval '1 day')`, [createHash('sha256').update(source).digest('hex'), makePng(16, 16)]);
    await pool.query(`INSERT INTO favicon_provider_admission(provider,next_request_at)
      VALUES ('https://icons.example.org',now()+interval '1 minute')`);
    const due = await items.listDueItems({ jobId: batchId, limit: 100, now: new Date() });
    assert.deepEqual(due.map(item => item.nodeId), ['node-4'], 'ready cached bytes outrank blocked older work');
    assert.equal((await items.aggregateItems(batchId)).nextAttemptAt, null, 'a runnable item must not be delayed by another item\'s retry');
    await items.markSucceeded(batchId, 'node-4', new Date());
    assert.deepEqual(await items.listDueItems({ jobId: batchId, limit: 100, now: new Date() }), []);
    assert.ok((await items.aggregateItems(batchId)).nextAttemptAt!.getTime() > Date.now() + 50_000);
    await pool.query("UPDATE favicon_provider_admission SET next_request_at=now()-interval '1 second'");
    const cold = await items.listDueItems({ jobId: batchId, limit: 100, now: new Date() });
    assert.deepEqual(cold.map(item => item.nodeId), ['cold-a'], 'one cold candidate per provider, not a page of doomed requests');
    await items.scheduleRetry(batchId, 'cold-a', 0, new Date(Date.now() + 60_000), 'fetch_failed', new Date());
    const next = await items.listDueItems({ jobId: batchId, limit: 100, now: new Date() });
    assert.deepEqual(next.map(item => item.nodeId), ['cold-b'], 'waiting items cannot starve untouched work');
    await pool.query('DELETE FROM favicon_provider_admission');
    await pool.query("UPDATE favicon_job_items SET next_attempt_at=NULL WHERE node_id='cold-a'");
    const unmetered = await items.listDueItems({ jobId: batchId, limit: 100, now: new Date() });
    assert.equal(unmetered.length, 2, 'a worker without provider admission retains bounded batch processing');
  });
});
