import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig, type AppConfig } from '../../support/test-config.js';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresSavedResourceReadUnitOfWork, createPostgresSavedResourceUnitOfWork } from '../../../src/infrastructure/reading-progress/index.js';
import { createSavedResourceCursorSigner } from '../../../src/modules/reading-progress/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { createPostgresBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';

const ORIGIN = 'https://app.example.test';
describeWithPostgres('P2B-16 real Saved Resource HTTP + PostgreSQL', () => {
  let isolated: IsolatedPostgresRuntime; let runtime: DatabaseRuntime; let config: AppConfig;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  beforeAll(async () => { isolated = await createIsolatedPostgresRuntime('phase2b_saved_http'); runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest'); factory = createPostgresBetterAuthTestFactory({ db: runtime.db }); config = loadConfig({ DATABASE_URL: isolated.databaseUrl,
      PRODUCT_ORIGIN: ORIGIN, ALLOWED_ORIGINS: ORIGIN, OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_CLIENT_ID: 'known-web', OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      NODE_ENV: 'test', LOG_LEVEL: 'silent' }); }, 120_000);
  afterAll(async () => isolated?.close());

  function app() { const identityUnitOfWork = createPostgresIdentityUnitOfWork(runtime.db, { oidcTransactionSecrets: config.oidcTransactionSecrets });
    return buildApiApp({ config, identityUnitOfWork, browserSessionAuthority: factory.authority,
      savedResourceUnitOfWork: createPostgresSavedResourceUnitOfWork(runtime.db),
      savedResourceReadUnitOfWork: createPostgresSavedResourceReadUnitOfWork(runtime.db, { cursorSigner:
        createSavedResourceCursorSigner({ current: { id: 'saved-http-v1', key: 'saved-http-postgres-secret' } }) }) }); }
  async function login(subject: string) {
    const client = await issueTestSession({
      factory,
      subject,
      displayName: subject,
      handle: `sav_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    });
    return { cookie: client.cookie, csrf: client.csrfToken, id: client.accountId, subject_id: client.subjectId };
  }

  async function insertCollection(ownerSubjectId: string, prefix: string, titles: readonly string[]) {
    const connection = await runtime.pool.connect(); try { await connection.query('begin');
      await connection.query(`insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node')`,
        [`${prefix}-c`, `${prefix}-root`]);
      for (let index = 0; index < titles.length; index += 1) await connection.query(
        `insert into resource_id_ledger(resource_id,resource_type) values ($1,'node')`, [`${prefix}-n${index + 1}`]);
      await connection.query(`insert into collections(id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,policy_revision,commit_ordinal)
        values ($1,$2,$3,'bookmarks','private',$4,'r1','c1','p1',1)`,
      [`${prefix}-c`, ownerSubjectId, `${prefix} private title`, `${prefix}-root`]);
      await connection.query(`insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,tags,visibility,position_token,resource_revision,children_revision)
        values ($1,$2,null,'folder',true,'Root',null,'[]','inherit',null,'r-root','c-root')`, [`${prefix}-root`, `${prefix}-c`]);
      for (let index = 0; index < titles.length; index += 1) await connection.query(
        `insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,tags,visibility,position_token,resource_revision,children_revision)
         values ($1,$2,$3,'bookmark',false,$4,$5,'[]','inherit',$6,$7,$8)`,
        [`${prefix}-n${index + 1}`, `${prefix}-c`, `${prefix}-root`, titles[index],
          `https://example.test/${prefix}/${index + 1}`, `P${index + 1}`, `r${index + 1}`, `c${index + 1}`]);
      await connection.query('commit');
    } catch (error) { await connection.query('rollback'); throw error; } finally { connection.release(); }
  }

  test('saves, exactly replays, batch-hydrates and unsaves through real routes', async () => {
    const api = app(); try { const client = await login(`saved-owner-${randomUUID()}`);
      const fixture = await runtime.pool.connect(); try { await fixture.query('begin');
        await fixture.query(`insert into resource_id_ledger(resource_id,resource_type) values
          ('saved-c','collection'),('saved-root','node'),('saved-n','node')`);
        await fixture.query(`insert into collections(id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,policy_revision,commit_ordinal)
          values ('saved-c',$1,'Saved Collection','bookmarks','private','saved-root','r1','c1','p1',1)`, [client.subject_id]);
        await fixture.query(`insert into nodes(id,collection_id,parent_id,kind,is_root,title,url,tags,visibility,position_token,resource_revision,children_revision)
          values ('saved-root','saved-c',null,'folder',true,'Root',null,'[]','inherit',null,'r2','c2'),
          ('saved-n','saved-c','saved-root','bookmark',false,'Hydrated title','https://example.test/saved','[]','inherit','A','r3','c3')`);
        await fixture.query('commit');
      } catch (error) { await fixture.query('rollback'); throw error; } finally { fixture.release(); }
      const commandId = randomUUID(); const headers = { cookie: client.cookie, origin: ORIGIN, 'x-csrf-token': client.csrf, 'known-command-id': commandId };
      const before = await runtime.pool.query<{ saved: number; audit: number }>(`select
        (select count(*)::int from saved_resources where account_id=$1) saved,
        (select count(*)::int from audit_events where principal_id=$1) audit`, [client.id]);
      const first = await api.inject({ method: 'PUT', url: '/api/v1/saved-resources/node/saved-n', headers });
      const afterFirst = await runtime.pool.query<{ saved: number; audit: number }>(`select
        (select count(*)::int from saved_resources where account_id=$1) saved,
        (select count(*)::int from audit_events where principal_id=$1) audit`, [client.id]);
      const replay = await api.inject({ method: 'PUT', url: '/api/v1/saved-resources/node/saved-n', headers });
      const afterReplay = await runtime.pool.query<{ saved: number; audit: number }>(`select
        (select count(*)::int from saved_resources where account_id=$1) saved,
        (select count(*)::int from audit_events where principal_id=$1) audit`, [client.id]);
      assert.equal(first.statusCode, 201); assert.equal(replay.statusCode, 201); assert.equal(replay.body, first.body);
      assert.deepEqual(afterFirst.rows[0], { saved: before.rows[0]!.saved + 1, audit: before.rows[0]!.audit + 1 });
      assert.deepEqual(afterReplay.rows[0], afterFirst.rows[0]);
      const list = await api.inject({ method: 'GET', url: '/api/v1/saved-resources?resourceType=node&collectionId=saved-c', headers: { cookie: client.cookie } });
      assert.equal(list.statusCode, 200); assert.equal(list.json().items[0].target.title, 'Hydrated title');
      assert.equal((await runtime.pool.query(`select count(*)::int count from product_command_receipts where command_id=$1`, [commandId])).rows[0].count, 1);
      const removed = await api.inject({ method: 'DELETE', url: '/api/v1/saved-resources/node/saved-n', headers: { ...headers, 'known-command-id': randomUUID() } });
      assert.equal(removed.statusCode, 204); assert.equal(removed.headers['cache-control'], 'private, no-store');
    } finally { await api.close(); }
  });

  test('isolates accounts and traverses the live set monotonically across target and saved-state changes', async () => {
    const api = app(); try {
      const accountA = await login(`saved-a-${randomUUID()}`);
      const accountB = await login(`saved-b-${randomUUID()}`);
      const prefixA = `a${randomUUID().replaceAll('-', '').slice(0, 8)}`;
      const prefixB = `b${randomUUID().replaceAll('-', '').slice(0, 8)}`;
      await insertCollection(accountA.subject_id, prefixA, ['A newest', 'A second', 'A title changes', 'A deleted', 'A final']);
      await insertCollection(accountB.subject_id, prefixB, ['B only distinct title']);
      await runtime.pool.query(`insert into collection_members(collection_id,subject_id,role) values ($1,$2,'viewer')`,
        [`${prefixB}-c`, accountA.subject_id]);
      await runtime.pool.query(`insert into saved_resources(account_id,resource_type,resource_id,saved_at,updated_at) values
        ($1,'node',$2,'2026-07-25T11:00:00Z','2026-07-25T11:00:00Z'),
        ($1,'node',$3,'2026-07-25T10:00:00Z','2026-07-25T10:00:00Z'),
        ($1,'node',$4,'2026-07-25T09:00:00Z','2026-07-25T09:00:00Z'),
        ($1,'node',$5,'2026-07-25T08:00:00Z','2026-07-25T08:00:00Z'),
        ($1,'node',$6,'2026-07-25T07:00:00Z','2026-07-25T07:00:00Z'),
        ($1,'node',$8,'2026-07-25T07:30:00Z','2026-07-25T07:30:00Z'),
        ($7,'node',$8,'2026-07-25T06:00:00Z','2026-07-25T06:00:00Z')`,
      [accountA.id, `${prefixA}-n1`, `${prefixA}-n2`, `${prefixA}-n3`, `${prefixA}-n4`, `${prefixA}-n5`, accountB.id, `${prefixB}-n1`]);

      const first = await api.inject({ method: 'GET', url: '/api/v1/saved-resources?limit=2', headers: { cookie: accountA.cookie } });
      assert.equal(first.statusCode, 200); assert.equal(first.headers['cache-control'], 'private, no-store');
      const firstBody = first.json() as { items: Array<{ resourceId: string; savedAt: string; target: { title: string | null } }>; page: { nextCursor: string | null } };
      assert.deepEqual(firstBody.items.map((item) => item.resourceId), [`${prefixA}-n1`, `${prefixA}-n2`]);

      await runtime.pool.query(`update nodes set title='A renamed without reorder' where id=$1`, [`${prefixA}-n3`]);
      await runtime.pool.query(`update nodes set deleted_at=current_timestamp where id=$1`, [`${prefixA}-n4`]);
      await runtime.pool.query(`delete from collection_members where collection_id=$1 and subject_id=$2`,
        [`${prefixB}-c`, accountA.subject_id]);
      await runtime.pool.query(`update saved_resources set deleted_at='2026-07-25T13:00:00Z',updated_at='2026-07-25T13:00:00Z'
        where account_id=$1 and resource_id=$2 and deleted_at is null`, [accountA.id, `${prefixA}-n5`]);
      await runtime.pool.query(`insert into saved_resources(account_id,resource_type,resource_id,saved_at,updated_at)
        values ($1,'collection',$2,'2026-07-25T12:00:00Z','2026-07-25T12:00:00Z')`, [accountA.id, `${prefixA}-c`]);

      const second = await api.inject({ method: 'GET', url: `/api/v1/saved-resources?cursor=${encodeURIComponent(firstBody.page.nextCursor!)}`,
        headers: { cookie: accountA.cookie } });
      assert.equal(second.statusCode, 200); const secondBody = second.json() as typeof firstBody;
      assert.deepEqual(secondBody.items.map((item) => item.resourceId), [`${prefixA}-n3`, `${prefixA}-n4`]);
      assert.equal(secondBody.items[0]!.target.title, 'A renamed without reorder');
      assert.deepEqual(secondBody.items[1]!.target, { availability: 'unavailable', collectionId: null, title: null, url: null });
      const third = await api.inject({ method: 'GET', url: `/api/v1/saved-resources?cursor=${encodeURIComponent(secondBody.page.nextCursor!)}`,
        headers: { cookie: accountA.cookie } });
      assert.equal(third.statusCode, 200); const thirdBody = third.json() as typeof firstBody;
      assert.deepEqual(thirdBody.items.map((item) => item.resourceId), [`${prefixB}-n1`]);
      assert.deepEqual(thirdBody.items[0]!.target, { availability: 'unavailable', collectionId: null, title: null, url: null });
      const all = [...firstBody.items, ...secondBody.items, ...thirdBody.items];
      assert.equal(new Set(all.map((item) => item.resourceId)).size, all.length);
      assert.deepEqual(all.map((item) => item.savedAt), [...all.map((item) => item.savedAt)].sort().reverse());
      assert.equal(thirdBody.page.nextCursor, null);

      const other = await api.inject({ method: 'GET', url: '/api/v1/saved-resources', headers: { cookie: accountB.cookie } });
      assert.equal(other.statusCode, 200); assert.deepEqual((other.json() as typeof firstBody).items.map((item) => item.target.title), ['B only distinct title']);
      assert.equal(other.body.includes(prefixA), false);
    } finally { await api.close(); }
  });
});
