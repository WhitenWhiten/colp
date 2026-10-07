import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresCollectionFollowCommandUnitOfWork,
  createPostgresCollectionFollowQueryUnitOfWork,
} from '../../../src/infrastructure/social/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  CollectionFollowCommandError,
  FollowedCollectionsCursorError,
  createFollowedCollectionsCursorKeyring,
  followCollection,
  queryCollectionFollowState,
  queryFollowedCollections,
  unfollowCollection,
  type CollectionFollowCommandInput,
} from '../../../src/modules/social/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { issueTestSession } from '../../support/product-http-harness.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateFixtureTables,
} from '../../support/postgres-test-runtime.js';

const ACTOR = 'profile-actor';
const OTHER = 'profile-other';
const OWNER = 'profile-owner';
const COLLECTION = 'collection-target';
const COMMAND_ID = '019fa956-0c4e-4190-94df-484c41fd9683';
const OWNER_MESSAGE = 'A Collection owner cannot follow their own collection.';

describeWithPostgres('collection follow relation', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('collection_follow_cf01', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());
  beforeEach(async () => resetFixture());

  function command(overrides: Partial<CollectionFollowCommandInput> = {}): CollectionFollowCommandInput {
    return {
      actor: { principalId: ACTOR, profileId: ACTOR, subjectId: `subject-${ACTOR}` },
      collectionId: COLLECTION,
      commandId: COMMAND_ID,
      ...overrides,
    };
  }

  async function follow(value = command(), options = {}) {
    return createPostgresCollectionFollowCommandUnitOfWork(isolated.runtime.db, options)
      .execute((ports) => followCollection(ports, value));
  }
  async function unfollow(value = command(), options = {}) {
    return createPostgresCollectionFollowCommandUnitOfWork(isolated.runtime.db, options)
      .execute((ports) => unfollowCollection(ports, value));
  }
  async function state(actorProfileId = ACTOR, actorSubjectId = `subject-${ACTOR}`) {
    return createPostgresCollectionFollowQueryUnitOfWork(isolated.runtime.db)
      .execute((ports) => queryCollectionFollowState(ports, {
        actorProfileId, actorSubjectId, collectionId: COLLECTION,
      }));
  }
  function listCursors() {
    return createFollowedCollectionsCursorKeyring({
      active: { id: 'it-followed-collections', secret: Buffer.alloc(32, 41).toString('base64') },
      retained: [],
    });
  }
  async function list(principalId = ACTOR, query: { limit?: number; cursor?: string } = {}) {
    const cursors = listCursors();
    try {
      return await createPostgresCollectionFollowQueryUnitOfWork(isolated.runtime.db, cursors)
        .execute((ports) => queryFollowedCollections(ports, { principalId, ...query }));
    } finally {
      cursors.destroy();
    }
  }

  test('migration owns binding, lifecycle, page index and inactive-account cleanup', async () => {
    const catalog = await isolated.runtime.pool.query<{ name: string }>(`
      select conname name from pg_constraint where conrelid='collection_follows'::regclass
      union all
      select indexname from pg_indexes
       where schemaname=current_schema() and tablename='collection_follows'
      union all
      select tgname from pg_trigger
       where (tgrelid='collection_follows'::regclass or tgname='accounts_remove_inactive_collection_follows')
         and not tgisinternal`);
    const names = new Set(catalog.rows.map((row) => row.name));
    for (const expected of [
      'collection_follows_pkey',
      'collection_follows_collection_fk',
      'collection_follows_follower_profile_fk',
      'collection_follows_followed_at_finite',
      'collection_follows_follower_page_idx',
      'collection_follows_binding_immutable',
      'collection_follows_lifecycle_guard',
      'accounts_remove_inactive_collection_follows',
    ]) assert.ok(names.has(expected), `missing ${expected}`);
  });

  test('PUT public and unlisted succeeds; GET reports real followerCount', async () => {
    const first = await follow();
    assert.equal(first.kind, 'succeeded');
    assert.equal(first.kind === 'succeeded' && first.state.following, true);
    assert.equal(first.kind === 'succeeded' && first.state.followerCount, 1);
    const seen = await state();
    assert.deepEqual(seen && { following: seen.following, followerCount: seen.followerCount }, {
      following: true, followerCount: 1,
    });
    await follow(command({
      actor: { principalId: OTHER, profileId: OTHER, subjectId: `subject-${OTHER}` },
      commandId: '019fa956-0c4e-4190-84df-484c41fd9684',
    }));
    assert.equal((await state())?.followerCount, 2);

    await resetFixture('unlisted');
    assert.equal((await follow()).kind, 'succeeded');
  });

  test('PUT conceals private, protected, soft-deleted and missing as resource_not_found', async () => {
    for (const visibility of ['private', 'protected'] as const) {
      await resetFixture(visibility);
      await assert.rejects(() => follow(), (error: unknown) =>
        error instanceof CollectionFollowCommandError && error.code === 'resource_not_found');
      assert.equal(await state(), null);
    }
    await resetFixture('public');
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(`update nodes set deleted_at=current_timestamp where collection_id=$1`, [COLLECTION]);
      await client.query(`update collections set deleted_at=current_timestamp where id=$1`, [COLLECTION]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await assert.rejects(() => follow(), (error: unknown) =>
      error instanceof CollectionFollowCommandError && error.code === 'resource_not_found');
    await assert.rejects(() => follow(command({ collectionId: 'collection-missing' })),
      (error: unknown) => error instanceof CollectionFollowCommandError
        && error.code === 'resource_not_found');
    assert.equal(await state(), null);
    assert.equal(await followCount(), 0);
  });

  test('owner self-follow is invalid_request with the locked message', async () => {
    await assert.rejects(() => follow(command({
      actor: { principalId: OWNER, profileId: OWNER, subjectId: `subject-${OWNER}` },
    })), (error: unknown) => error instanceof CollectionFollowCommandError
      && error.code === 'invalid_request' && error.message === OWNER_MESSAGE);
    assert.equal(await followCount(), 0);
  });

  test('editor and viewer members may follow', async () => {
    await isolated.runtime.pool.query(
      `insert into collection_members(collection_id,subject_id,role) values($1,$2,'editor'),($1,$3,'viewer')`,
      [COLLECTION, `subject-${ACTOR}`, `subject-${OTHER}`],
    );
    assert.equal((await follow()).kind, 'succeeded');
    assert.equal((await follow(command({
      actor: { principalId: OTHER, profileId: OTHER, subjectId: `subject-${OTHER}` },
      commandId: '019fa956-0c4e-4190-84df-484c41fd9684',
    }))).kind, 'succeeded');
    assert.equal(await followCount(), 2);
  });

  test('repeat PUT/DELETE and same command-id replay do not rewrite', async () => {
    const first = await follow();
    const replay = await follow();
    assert.equal(first.kind, 'succeeded');
    assert.equal(replay.kind, 'replay');
    assert.equal(await followCount(), 1);
    const receipts = (await isolated.runtime.pool.query<{ command_scope: string }>(
      `select command_scope from product_command_receipts`,
    )).rows;
    assert.deepEqual(receipts, [{ command_scope: 'social:collection-follow-relation:v1' }]);

    const removed = await unfollow(command({ commandId: '019fa956-0c4e-4190-84df-484c41fd9685' }));
    const removedAgain = await unfollow(command({ commandId: '019fa956-0c4e-4190-84df-484c41fd9685' }));
    assert.equal(removed.kind, 'succeeded');
    assert.equal(removedAgain.kind, 'replay');
    assert.equal(await followCount(), 0);
  });

  test('DELETE succeeds after the target becomes private and conceals the live count', async () => {
    assert.equal((await follow()).kind, 'succeeded');
    await follow(command({
      actor: { principalId: OTHER, profileId: OTHER, subjectId: `subject-${OTHER}` },
      commandId: '019fa956-0c4e-4190-84df-484c41fd9689',
    }));
    await isolated.runtime.pool.query(`update collections set visibility='private' where id=$1`, [COLLECTION]);
    const removed = await unfollow(command({
      commandId: '019fa956-0c4e-4190-84df-484c41fd9686',
    }));
    assert.equal(removed.kind, 'succeeded');
    // OTHER still follows (real count 1), but an invisible target must not
    // reveal it through the lenient DELETE surface.
    assert.equal(removed.kind === 'succeeded' && removed.state.followerCount, 0);
    assert.equal(await followCount(), 1);
    assert.equal(await state(), null);
  });

  test('owner GET is following false while followerCount still counts', async () => {
    await follow();
    const ownerState = await state(OWNER, `subject-${OWNER}`);
    assert.deepEqual(ownerState && { following: ownerState.following, followerCount: ownerState.followerCount }, {
      following: false, followerCount: 1,
    });
  });

  test('UPDATE collection_follows is rejected; follower inactivation deletes the row', async () => {
    await follow();
    await assert.rejects(() => isolated.runtime.pool.query(
      `update collection_follows set followed_at=followed_at+interval '1 second'
        where collection_id=$1 and follower_profile_id=$2`, [COLLECTION, ACTOR],
    ), (error: unknown) => (error as { constraint?: string }).constraint === 'collection_follows_binding_immutable');
    await isolated.runtime.pool.query(
      `update accounts set status='disabled' where id=$1`, [ACTOR],
    );
    assert.equal(await followCount(), 0);
  });

  test('HTTP anon 401, flag-off 404, PUT/GET/DELETE, and owner 400', async () => {
    const env = {
      ...process.env, DATABASE_URL: isolated.databaseUrl, NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000',
      KNOWN_FEATURE_COLLECTION_FOLLOW: 'true',
    };
    const config = loadConfig(env);
    const identity = createPostgresIdentityUnitOfWork(isolated.runtime.db, {
      oidcTransactionSecrets: config.oidcTransactionSecrets,
    });
    const factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    const actor = await issueTestSession({
      factory,
      subject: `cf-actor-${randomUUID()}`,
      handle: `a${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    const owner = await issueTestSession({
      factory,
      subject: `cf-owner-${randomUUID()}`,
      handle: `o${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
    const collectionId = `cf-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await seedHttpCollection(collectionId, owner.subjectId);
    const commandUnitOfWork = createPostgresCollectionFollowCommandUnitOfWork(isolated.runtime.db);
    const queryCursors = createFollowedCollectionsCursorKeyring(config.collectionFollow.cursorKeys);
    const queryUnitOfWork = createPostgresCollectionFollowQueryUnitOfWork(
      isolated.runtime.db, queryCursors,
    );
    const app = buildApiApp({
      config, identityUnitOfWork: identity, browserSessionAuthority: factory.authority,
      collectionFollowCommandUnitOfWork: commandUnitOfWork,
      collectionFollowQueryUnitOfWork: queryUnitOfWork,
      collectionFollowRateLimiter: createFixedWindowRateLimiter({ maxRequests: 100, windowMs: 60_000 }),
    });
    const followPath = `/api/v1/collections/${collectionId}/follow`;
    const listPath = '/api/v1/me/followed-collections';
    try {
      assert.equal((await app.inject({ method: 'GET', url: followPath })).statusCode, 401);
      assert.equal((await app.inject({ method: 'GET', url: listPath })).statusCode, 401);
      const put = await app.inject({
        method: 'PUT', url: followPath,
        headers: {
          cookie: actor.cookie, origin: config.productOrigin,
          'x-csrf-token': actor.csrfToken, 'known-command-id': randomUUID(),
        },
      });
      assert.equal(put.statusCode, 200);
      assert.equal(put.json().following, true);
      assert.equal(put.json().followerCount, 1);
      const get = await app.inject({ method: 'GET', url: followPath, headers: { cookie: actor.cookie } });
      assert.equal(get.statusCode, 200);
      assert.equal(get.json().followerCount, 1);
      const listed = await app.inject({ method: 'GET', url: listPath, headers: { cookie: actor.cookie } });
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.headers['cache-control'], 'private, no-store');
      assert.equal(listed.json().items.length, 1);
      assert.equal(listed.json().items[0].collectionId, collectionId);
      assert.equal(listed.json().items[0].availability, 'available');
      assert.equal(listed.json().nextCursor, null);
      assert.equal(JSON.stringify(listed.json()).includes('followerCount'), false);
      const ownerPut = await app.inject({
        method: 'PUT', url: followPath,
        headers: {
          cookie: owner.cookie, origin: config.productOrigin,
          'x-csrf-token': owner.csrfToken, 'known-command-id': randomUUID(),
        },
      });
      assert.equal(ownerPut.statusCode, 400);
      assert.equal(ownerPut.json().error.message, OWNER_MESSAGE);
      const del = await app.inject({
        method: 'DELETE', url: followPath,
        headers: {
          cookie: actor.cookie, origin: config.productOrigin,
          'x-csrf-token': actor.csrfToken, 'known-command-id': randomUUID(),
        },
      });
      assert.equal(del.statusCode, 200);
      assert.equal(del.json().following, false);
      const empty = await app.inject({ method: 'GET', url: listPath, headers: { cookie: actor.cookie } });
      assert.deepEqual(empty.json(), { items: [], nextCursor: null });
    } finally {
      await app.close();
      queryCursors.destroy();
    }

    const closed = loadConfig({ ...env, KNOWN_FEATURE_COLLECTION_FOLLOW: 'false' });
    const gated = buildApiApp({
      config: closed, identityUnitOfWork: identity, browserSessionAuthority: factory.authority,
      collectionFollowCommandUnitOfWork: commandUnitOfWork,
      collectionFollowQueryUnitOfWork: queryUnitOfWork,
    });
    try {
      const anon = await gated.inject({ method: 'GET', url: followPath });
      assert.equal(anon.statusCode, 401);
      const authed = await gated.inject({
        method: 'GET', url: followPath, headers: { cookie: actor.cookie },
      });
      assert.equal(authed.statusCode, 404);
      assert.doesNotMatch(authed.body, /feature_temporarily_unavailable/u);
      const listAuthed = await gated.inject({
        method: 'GET', url: '/api/v1/me/followed-collections', headers: { cookie: actor.cookie },
      });
      assert.equal(listAuthed.statusCode, 404);
    } finally {
      await gated.close();
    }
  }, 60_000);

  test('list keyset pages 111 rows; private, soft-deleted and disabled-owner rows grey out instead of vanishing', async () => {
    const ids = Array.from({ length: 110 }, (_, index) => `cf-list-${String(index).padStart(3, '0')}`);
    for (const [index, collectionId] of ids.entries()) {
      await seedCollection(
        collectionId, `subject-${OWNER}`, 'public', `List ${collectionId}`, `list-${collectionId}`,
      );
      await isolated.runtime.pool.query(
        `insert into collection_follows(collection_id,follower_profile_id,followed_at)
         values($1,$2,$3)`,
        [collectionId, ACTOR, new Date(Date.UTC(2026, 7, 26, 12, 0, index))],
      );
    }
    const deletedId = 'cf-list-deleted';
    await seedCollection(
      deletedId, `subject-${OWNER}`, 'public', `List ${deletedId}`, `list-${deletedId}`,
    );
    await isolated.runtime.pool.query(
      `insert into collection_follows(collection_id,follower_profile_id,followed_at)
       values($1,$2,$3)`,
      [deletedId, ACTOR, new Date(Date.UTC(2026, 7, 26, 13, 0, 0))],
    );
    const deletedClient = await isolated.runtime.pool.connect();
    try {
      await deletedClient.query('begin');
      await deletedClient.query(
        `update nodes set deleted_at=current_timestamp where collection_id=$1`, [deletedId],
      );
      await deletedClient.query(
        `update collections set deleted_at=current_timestamp where id=$1`, [deletedId],
      );
      await deletedClient.query('commit');
    } catch (error) {
      await deletedClient.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      deletedClient.release();
    }
    type Item = Awaited<ReturnType<typeof list>>['items'][number];
    const traverse = async () => {
      const collected: Item[] = [];
      let cursor: string | undefined;
      do {
        const page = await list(ACTOR, { limit: 20, ...(cursor ? { cursor } : {}) });
        collected.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return collected;
    };

    const seen = await traverse();
    const expected = [deletedId, ...[...ids].reverse()];
    assert.equal(seen.length, 111);
    assert.deepEqual(seen.map((item) => item.collectionId), expected);
    assert.equal(new Set(seen.map((item) => item.collectionId)).size, 111);
    const deletedRow = seen[0]!;
    assert.equal(deletedRow.availability, 'unavailable');
    assert.equal(deletedRow.summary, null);
    assert.equal(deletedRow.title, `List ${deletedId}`);
    assert.equal(seen.slice(1).every((item) => item.availability === 'available'), true);
    assert.equal((await list(OTHER)).items.length, 0);

    const first = await list(ACTOR, { limit: 20 });
    await assert.rejects(() => list(OTHER, { limit: 20, cursor: first.nextCursor! }),
      FollowedCollectionsCursorError);

    await isolated.runtime.pool.query(
      `update collections set visibility='private', summary='written while public' where id=$1`, [ids[50]],
    );
    const afterPrivate = await traverse();
    assert.equal(afterPrivate.length, 111);
    const greyed = afterPrivate.find((item) => item.collectionId === ids[50]);
    assert.equal(greyed?.availability, 'unavailable');
    assert.equal(greyed?.summary, null);
    assert.equal(greyed?.title, `List ${ids[50]}`);
    assert.equal(greyed?.slug, `list-${ids[50]}`);
    assert.equal(
      afterPrivate.filter((item) => item.availability === 'unavailable')
        .map((item) => item.collectionId).sort().join(','),
      [deletedId, ids[50]].sort().join(','),
    );

    const followsBeforeDisable = await followCount();
    await isolated.runtime.pool.query(
      `update accounts set status='disabled' where id=$1`, [OWNER],
    );
    const afterOwner = await traverse();
    assert.equal(afterOwner.length, 111);
    assert.equal(afterOwner.every((item) => item.availability === 'unavailable'), true);
    assert.equal(afterOwner.every((item) => item.summary === null), true);
    assert.equal(await followCount(), followsBeforeDisable);
  }, 60_000);

  async function followCount(): Promise<number> {
    return Number((await isolated.runtime.pool.query<{ count: string }>(
      `select count(*)::text count from collection_follows`,
    )).rows[0]?.count ?? 0);
  }

  async function seedHttpCollection(collectionId: string, ownerSubjectId: string): Promise<void> {
    await seedCollection(collectionId, ownerSubjectId, 'public', 'HTTP target', `http-${collectionId}`);
  }

  async function seedCollection(
    collectionId: string,
    ownerSubjectId: string,
    visibility: 'public' | 'unlisted' | 'private' | 'protected',
    title: string,
    slug: string,
  ): Promise<void> {
    const rootId = `root-${collectionId}`;
    const client = await isolated.runtime.pool.connect();
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
      [collectionId, ownerSubjectId, rootId, slug, visibility, title]);
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
  }

  async function resetFixture(visibility: 'public' | 'unlisted' | 'private' | 'protected' = 'public'): Promise<void> {
    await truncateFixtureTables(isolated.runtime.pool, `truncate table product_command_receipts,audit_events,
      collection_follows,collection_members,nodes,collections,resource_id_ledger cascade`);
    await isolated.runtime.pool.query(`delete from profile_handles where account_id like 'profile-%'`);
    await isolated.runtime.pool.query(`delete from profiles where account_id like 'profile-%'`);
    await isolated.runtime.pool.query(`delete from accounts where id like 'profile-%'`);
    for (const id of [ACTOR, OTHER, OWNER]) {
      await isolated.runtime.pool.query(
        `insert into accounts(id,subject_id,status) values($1,$2,'active')`, [id, `subject-${id}`],
      );
      await isolated.runtime.pool.query(
        `insert into profiles(account_id,display_name) values($1,$2)`, [id, id],
      );
      await isolated.runtime.pool.query(
        `insert into profile_handles(handle,account_id) values($1,$2)`, [id, id],
      );
    }
    await seedCollection(
      COLLECTION, `subject-${OWNER}`, visibility, 'Follow target', `cf-${COLLECTION}`,
    );
  }
});
