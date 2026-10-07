import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  PUBLICATION_CACHE_PURGE_EVENT_TYPE,
  PUBLICATION_CACHE_PURGE_EVENT_VERSION,
  PUBLICATION_CACHE_PURGE_HANDLER_NAME,
} from '../../../src/infrastructure/outbox/publication-cache-purge.js';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresCanonicalMutationUnitOfWork, createPostgresCollectionsUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createPostgresPublisherCanonicalMutationApplication } from '../../../src/infrastructure/publisher/index.js';
import {
  SOCIAL_COLLECTION_CHANGE_EVENT_TYPE,
  SOCIAL_COLLECTION_CHANGE_EVENT_VERSION,
  SOCIAL_COLLECTION_CHANGE_HANDLER_MODE,
  SOCIAL_COLLECTION_CHANGE_HANDLER_NAME,
  SOCIAL_PUBLIC_ACTIVITY_HANDLER_MODE,
  SOCIAL_PUBLIC_ACTIVITY_HANDLER_NAME,
  type SocialCollectionChangeRouteFaultInjector,
} from '../../../src/infrastructure/outbox/social-collection-change.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  authenticatedMutationHeaders,
  issueTestSession,
  type AuthenticatedTestClient,
} from '../../support/product-http-harness.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateFixtureTables,
} from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://app.example.test';
const ISSUER = 'https://issuer.example.test/realms/known';
const CREATE_COMMAND = '11111111-1111-4111-8111-111111111111';
const PUBLIC_COMMAND = '22222222-2222-4222-8222-222222222222';
const UNLISTED_COMMAND = '33333333-3333-4333-8333-333333333333';
const FAULT_COMMAND = '44444444-4444-4444-8444-444444444444';
const ROLLBACK_COMMAND = '55555555-5555-4555-8555-555555555555';
const DELETE_COMMAND = '66666666-6666-4666-8666-666666666666';

type ApiApp = ReturnType<typeof buildApiApp>;

interface OutboxRow {
  outbox_id: string;
  domain_event_id: string;
  event_type: string;
  event_version: number;
  handler_name: string;
  handler_mode: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_scope: string;
  aggregate_revision: string;
  commit_ordinal: string;
  state: string;
  attempt_count: number;
  payload_json: Record<string, unknown>;
}

describeWithPostgres('P5-09 committed public Collection changes route to social', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_social_collection_change');
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
    factory = createPostgresBetterAuthTestFactory({ db: runtime.db });
  });

  beforeEach(async () => {
    // E1: every case starts from an empty auth surface too (BA rows, mapping,
    // metadata and business fixtures are torn down together, plan §11 E1).
    await truncateFixtureTables(runtime.pool, `truncate table publisher_idempotency, product_command_receipts,
      outbox_events, audit_events, operations, policy_revisions, content_revisions,
      children_revisions, resource_revisions, collection_policies, collection_members,
      nodes, collections, resource_id_ledger, oidc_login_transactions, sessions,
      account_identities, profile_handles, profiles, accounts,
      known_auth_session_metadata, "auth_sessions", "auth_accounts", "auth_users",
      auth_user_account_map cascade`);
  });

  afterAll(async () => isolated?.close());

  function config() {
    return loadConfig({
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
    });
  }

  async function client(): Promise<AuthenticatedTestClient> {
    return issueTestSession({
      factory,
      subject: 'phase5-social-route-owner',
      handle: 'phase5-social-owner',
      displayName: 'Phase 5 Social Owner',
    });
  }

  function app(input: {
    readonly client: AuthenticatedTestClient;
    readonly afterCallbackBeforeCommit?: () => void | Promise<void>;
    readonly socialRouteFaultInjector?: SocialCollectionChangeRouteFaultInjector;
  }): ApiApp {
    return buildApiApp({
      config: config(),
      identityUnitOfWork: createPostgresIdentityUnitOfWork(runtime.db),
      browserSessionAuthority: factory.authority,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db, {
        ...(input.afterCallbackBeforeCommit ? {
          faultInjector: { afterCallbackBeforeCommit: input.afterCallbackBeforeCommit },
        } : {}),
        ...(input.socialRouteFaultInjector ? {
          socialRouteFaultInjector: input.socialRouteFaultInjector,
        } : {}),
      }),
    });
  }

  function headers(client: AuthenticatedTestClient, commandId: string, contentType: string) {
    return authenticatedMutationHeaders({
      client,
      origin: ORIGIN,
      contentType,
      extra: { 'known-command-id': commandId },
    });
  }

  async function createCollection(application: ApiApp, owner: AuthenticatedTestClient) {
    const response = await application.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: headers(owner, CREATE_COMMAND, 'application/json'),
      payload: { kind: 'bookmarks', title: 'Social route secret title', summary: 'secret summary' },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json() as {
      collection: { id: string; etag: string; revision: string };
      root: { id: string };
    };
  }

  async function patchCollection(
    application: ApiApp,
    owner: AuthenticatedTestClient,
    collection: { id: string; etag: string },
    commandId: string,
    patch: Record<string, unknown>,
  ) {
    return application.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collection.id}`,
      headers: {
        ...headers(owner, commandId, 'application/merge-patch+json'),
        'if-match': collection.etag,
      },
      payload: patch,
    });
  }

  async function socialRows(collectionId: string): Promise<OutboxRow[]> {
    const result = await runtime.pool.query<OutboxRow>(
      `select outbox_id, domain_event_id, event_type, event_version, handler_name,
              handler_mode, aggregate_type, aggregate_id, aggregate_scope,
              aggregate_revision, commit_ordinal::text, state, attempt_count, payload_json
       from outbox_events
       where aggregate_scope = $1 and handler_name = $2
       order by commit_ordinal, outbox_id`,
      [collectionId, SOCIAL_COLLECTION_CHANGE_HANDLER_NAME],
    );
    return result.rows;
  }

  function assertClosedSocialRow(
    row: OutboxRow,
    collectionId: string,
    ownerProfileId: string,
    disposition: 'public_candidate' | 'remove',
  ) {
    assert.match(row.domain_event_id, /^[A-Za-z0-9_-]{21}[AQgw]$/u);
    assert.equal(row.event_type, SOCIAL_COLLECTION_CHANGE_EVENT_TYPE);
    assert.equal(row.event_version, SOCIAL_COLLECTION_CHANGE_EVENT_VERSION);
    assert.equal(row.handler_mode, SOCIAL_COLLECTION_CHANGE_HANDLER_MODE);
    assert.equal(row.aggregate_type, 'collection');
    assert.equal(row.aggregate_id, collectionId);
    assert.equal(row.aggregate_scope, collectionId);
    assert.ok(BigInt(row.commit_ordinal) > 0n);
    assert.equal(row.state, 'pending');
    assert.equal(row.attempt_count, 0);
    assert.deepEqual(row.payload_json, {
      collectionId,
      ownerProfileId,
      publicationRevision: row.aggregate_revision,
      discoverabilityRecheckKey: `publication.collection:${collectionId}`,
      producerDiscoverability: disposition,
    });
    const serialized = JSON.stringify(row.payload_json);
    for (const forbidden of [
      'Social route secret title', 'secret summary', 'phase5-social-owner',
      '@example.test', 'membership', 'policyJson', 'private', 'protected', 'unlisted',
    ]) assert.ok(!serialized.includes(forbidden));
  }

  test('real Product HTTP create/update commits closed @2 rows and keeps N/N-1 handlers isolated', async () => {
    const owner = await client();
    const application = app({ client: owner });
    try {
      const created = await createCollection(application, owner);
      let rows = await socialRows(created.collection.id);
      assert.equal(rows.length, 1);
      assertClosedSocialRow(rows[0]!, created.collection.id, owner.accountId, 'remove');

      const madePublic = await patchCollection(application, owner, created.collection,
        PUBLIC_COMMAND, { visibility: 'public', publicationSlug: 'social-public' });
      assert.equal(madePublic.statusCode, 200);
      const publicBody = madePublic.json() as { collection: { id: string; etag: string } };
      rows = await socialRows(created.collection.id);
      assert.equal(rows.length, 2);
      assertClosedSocialRow(rows[1]!, created.collection.id, owner.accountId, 'public_candidate');

      const madeUnlisted = await patchCollection(application, owner, publicBody.collection,
        UNLISTED_COMMAND, { visibility: 'unlisted' });
      assert.equal(madeUnlisted.statusCode, 200);
      rows = await socialRows(created.collection.id);
      assert.equal(rows.length, 3);
      assertClosedSocialRow(rows[2]!, created.collection.id, owner.accountId, 'remove');

      const siblings = await runtime.pool.query<OutboxRow>(
        `select outbox_id, domain_event_id, event_type, event_version, handler_name,
                handler_mode, aggregate_type, aggregate_id, aggregate_scope,
                aggregate_revision, commit_ordinal::text, state, attempt_count, payload_json
         from outbox_events where domain_event_id = $1 order by handler_name`,
        [rows[1]!.domain_event_id],
      );
      assert.deepEqual(siblings.rows.map((row) => row.handler_name), [
        'collection_updated_projection',
        PUBLICATION_CACHE_PURGE_HANDLER_NAME,
        SOCIAL_COLLECTION_CHANGE_HANDLER_NAME,
        SOCIAL_PUBLIC_ACTIVITY_HANDLER_NAME,
      ]);
      assert.deepEqual(siblings.rows.map((row) => `${row.event_type}@${row.event_version}`), [
        'collection.updated@1',
        `${PUBLICATION_CACHE_PURGE_EVENT_TYPE}@${PUBLICATION_CACHE_PURGE_EVENT_VERSION}`,
        'social.collection-change@2',
        'social.collection-change@2',
      ]);
      assert.equal(new Set(siblings.rows.map((row) => row.outbox_id)).size, 4);
      const socialPair = siblings.rows.filter((row) => row.event_type === SOCIAL_COLLECTION_CHANGE_EVENT_TYPE);
      assert.equal(socialPair.length, 2);
      assert.equal(socialPair[0]!.domain_event_id, socialPair[1]!.domain_event_id);
      assert.deepEqual(
        Object.keys(socialPair[0]!.payload_json).sort(),
        Object.keys(socialPair[1]!.payload_json).sort(),
      );
      assert.equal(
        socialPair.find((row) => row.handler_name === SOCIAL_COLLECTION_CHANGE_HANDLER_NAME)?.handler_mode,
        SOCIAL_COLLECTION_CHANGE_HANDLER_MODE,
      );
      assert.equal(
        socialPair.find((row) => row.handler_name === SOCIAL_PUBLIC_ACTIVITY_HANDLER_NAME)?.handler_mode,
        SOCIAL_PUBLIC_ACTIVITY_HANDLER_MODE,
      );
      await runtime.pool.query(
        `update outbox_events set state = 'retryable', attempt_count = 2
         where domain_event_id = $1 and handler_name = $2`,
        [rows[1]!.domain_event_id, SOCIAL_COLLECTION_CHANGE_HANDLER_NAME],
      );
      const isolatedStates = await runtime.pool.query<{ handler_name: string; state: string; attempt_count: number }>(
        `select handler_name, state, attempt_count from outbox_events
         where domain_event_id = $1 order by handler_name`,
        [rows[1]!.domain_event_id],
      );
      assert.deepEqual(isolatedStates.rows, [
        { handler_name: 'collection_updated_projection', state: 'pending', attempt_count: 0 },
        { handler_name: PUBLICATION_CACHE_PURGE_HANDLER_NAME, state: 'pending', attempt_count: 0 },
        { handler_name: SOCIAL_COLLECTION_CHANGE_HANDLER_NAME, state: 'retryable', attempt_count: 2 },
        { handler_name: SOCIAL_PUBLIC_ACTIVITY_HANDLER_NAME, state: 'pending', attempt_count: 0 },
      ]);

      assert.equal((await runtime.pool.query(
        'select count(*)::int count from audit_events where collection_id = $1',
        [created.collection.id],
      )).rows[0].count, 3);
      assert.equal((await runtime.pool.query(
        'select count(*)::int count from product_command_receipts where principal_id = $1',
        [owner.accountId],
      )).rows[0].count, 3);
    } finally {
      await application.close();
    }
  });

  test('uncommitted rows stay invisible and rollback or mapper failure leaves no social/core evidence', async () => {
    const owner = await client();
    const setup = app({ client: owner });
    const created = await createCollection(setup, owner);
    await setup.close();
    const initialCount = (await runtime.pool.query(
      'select count(*)::int count from outbox_events where aggregate_scope = $1',
      [created.collection.id],
    )).rows[0].count;

    let observedBeforeCommit = -1;
    const committing = app({
      client: owner,
      afterCallbackBeforeCommit: async () => {
        observedBeforeCommit = (await runtime.pool.query(
          'select count(*)::int count from outbox_events where aggregate_scope = $1',
          [created.collection.id],
        )).rows[0].count;
      },
    });
    const committed = await patchCollection(committing, owner, created.collection,
      PUBLIC_COMMAND, { visibility: 'public', publicationSlug: 'commit-visible' });
    assert.equal(committed.statusCode, 200);
    assert.equal(observedBeforeCommit, initialCount);
    assert.equal((await runtime.pool.query(
      'select count(*)::int count from outbox_events where aggregate_scope = $1',
      [created.collection.id],
    )).rows[0].count, initialCount + 4);
    await committing.close();

    const publicCollection = (committed.json() as { collection: { id: string; etag: string } }).collection;
    const beforeRollback = await runtime.pool.query('select * from collections where id = $1', [created.collection.id]);
    const rollback = app({
      client: owner,
      afterCallbackBeforeCommit: () => { throw new Error('rollback-after-social-route'); },
    });
    const rolledBack = await patchCollection(rollback, owner, publicCollection,
      ROLLBACK_COMMAND, { title: 'must roll back' });
    assert.equal(rolledBack.statusCode, 500);
    assert.deepEqual((await runtime.pool.query(
      'select * from collections where id = $1', [created.collection.id],
    )).rows, beforeRollback.rows);
    assert.equal((await runtime.pool.query(
      'select count(*)::int count from product_command_receipts where command_id = $1',
      [ROLLBACK_COMMAND],
    )).rows[0].count, 0);
    await rollback.close();

    const routeFailure = app({
      client: owner,
      socialRouteFaultInjector: {
        beforeMap() { throw new Error('social-mapper-fault'); },
      },
    });
    const evidenceBeforeFailure = await runtime.pool.query(
      `select (select count(*)::int from operations) operations,
              (select count(*)::int from audit_events) audits,
              (select count(*)::int from outbox_events) outbox,
              (select count(*)::int from product_command_receipts) receipts`,
    );
    const failed = await patchCollection(routeFailure, owner, publicCollection,
      FAULT_COMMAND, { title: 'must also roll back' });
    assert.equal(failed.statusCode, 500);
    assert.deepEqual((await runtime.pool.query(
      'select * from collections where id = $1', [created.collection.id],
    )).rows, beforeRollback.rows);
    assert.deepEqual((await runtime.pool.query(
      `select (select count(*)::int from operations) operations,
              (select count(*)::int from audit_events) audits,
              (select count(*)::int from outbox_events) outbox,
              (select count(*)::int from product_command_receipts) receipts`,
    )).rows, evidenceBeforeFailure.rows);
    await routeFailure.close();
  });

  test('afterAppend fault rolls back both social handler rows', async () => {
    const owner = await client();
    const setup = app({ client: owner });
    const created = await createCollection(setup, owner);
    await setup.close();
    const publishing = app({ client: owner });
    const publicCollection = await patchCollection(
      publishing,
      owner,
      created.collection,
      PUBLIC_COMMAND,
      { visibility: 'public', publicationSlug: 'after-append-public' },
    );
    assert.equal(publicCollection.statusCode, 200);
    await publishing.close();
    const current = (publicCollection.json() as { collection: { id: string; etag: string } }).collection;
    const before = await runtime.pool.query<{ count: string }>(
      `select count(*)::text count from outbox_events
        where aggregate_scope = $1
          and handler_name in ($2, $3)`,
      [current.id, SOCIAL_COLLECTION_CHANGE_HANDLER_NAME, SOCIAL_PUBLIC_ACTIVITY_HANDLER_NAME],
    );
    const failing = app({
      client: owner,
      socialRouteFaultInjector: {
        afterAppend() { throw new Error('activity-dual-append-fault'); },
      },
    });
    const failed = await patchCollection(failing, owner, current, FAULT_COMMAND, { title: 'must roll back both' });
    assert.equal(failed.statusCode, 500);
    const after = await runtime.pool.query<{ count: string }>(
      `select count(*)::text count from outbox_events
        where aggregate_scope = $1
          and handler_name in ($2, $3)`,
      [current.id, SOCIAL_COLLECTION_CHANGE_HANDLER_NAME, SOCIAL_PUBLIC_ACTIVITY_HANDLER_NAME],
    );
    assert.equal(after.rows[0]!.count, before.rows[0]!.count);
    await failing.close();
  });

  test('real Publisher application/UoW routes protected/private and node deletion without Product receipts', async () => {
    const owner = await client();
    const product = app({ client: owner });
    const created = await createCollection(product, owner);
    const publicResponse = await patchCollection(product, owner, created.collection,
      PUBLIC_COMMAND, { visibility: 'public', publicationSlug: 'publisher-social' });
    assert.equal(publicResponse.statusCode, 200);
    await product.close();
    let current = (publicResponse.json() as {
      collection: { id: string; etag: string; revision: string };
    }).collection;

    const publisher = createPostgresPublisherCanonicalMutationApplication(runtime.db);
    const mutateCollection = async (visibility: 'protected' | 'private' | 'public', sequence: number) => {
      const outcome = await publisher.execute({
        binding: {
          namespace: 'colp.publisher.v0.1.collections.patch',
          principalId: owner.subjectId,
          idempotencyKey: `phase5-social-publisher-${sequence}`,
        },
        collectionId: current.id,
        operationId: `phase5-social-publisher-operation-${sequence}`,
        payload: { visibility },
        mutation: {
          action: 'update',
          target: { collectionId: current.id, resourceId: current.id, resourceKind: 'collection' },
          parentId: null,
          expectedResourceRevision: current.revision,
          fields: { kindFields: { visibility }, extensions: {} },
        },
      });
      assert.equal(outcome.kind, 'executed');
      if (outcome.kind === 'executed') {
        current = { ...current, revision: outcome.mutation.allocation.resourceRevision! };
      }
    };

    await mutateCollection('protected', 1);
    await mutateCollection('private', 2);
    await mutateCollection('public', 3);
    const nodeId = 'phase5-social-publisher-node';
    const createdNode = await publisher.execute({
      binding: { namespace: 'colp.publisher.v0.1.nodes.create', principalId: owner.subjectId,
        idempotencyKey: 'phase5-social-node-create' },
      collectionId: current.id,
      operationId: 'phase5-social-node-create-operation',
      payload: { kind: 'folder' },
      mutation: {
        action: 'create',
        target: { collectionId: current.id, resourceId: nodeId, resourceKind: 'node' },
        parentId: created.root.id,
        fields: { kindFields: { kind: 'folder', title: 'Publisher node secret', url: null,
          description: null, tags: [], visibility: 'inherit' }, extensions: {} },
      },
    });
    assert.equal(createdNode.kind, 'executed');
    assert.equal(createdNode.kind === 'executed'
      ? createdNode.mutation.allocation.commitOrdinal > 0n : false, true);
    const nodeRevision = createdNode.kind === 'executed'
      ? createdNode.mutation.allocation.resourceRevision! : '';
    const productDelete = app({ client: owner });
    const deleteHeaders = headers(owner, DELETE_COMMAND, 'application/json');
    delete deleteHeaders['content-type'];
    const deletedNode = await productDelete.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${current.id}/nodes/${nodeId}?recursive=false`,
      headers: {
        ...deleteHeaders,
        'if-match': `"${nodeRevision}"`,
      },
    });
    assert.equal(deletedNode.statusCode, 200, deletedNode.body);
    await productDelete.close();

    const rows = await socialRows(current.id);
    assert.deepEqual(rows.slice(-5).map((row) => row.payload_json.producerDiscoverability), [
      'remove', 'remove', 'public_candidate', 'public_candidate', 'public_candidate',
    ]);
    assert.equal((await runtime.pool.query(
      `select count(*)::int count from product_command_receipts
       where command_id like 'phase5-social-publisher-%'`,
    )).rows[0].count, 0);
    assert.equal((await runtime.pool.query(
      `select count(*)::int count from publisher_idempotency
       where idempotency_key like 'phase5-social-%'`,
    )).rows[0].count, 4);
  });

  test('owner lifecycle uses identity Profile authority, removes inactive owners, and fails closed when missing', async () => {
    const owner = await client();
    assert.notEqual(owner.accountId, owner.subjectId);
    const product = app({ client: owner });
    const created = await createCollection(product, owner);
    const publicResponse = await patchCollection(product, owner, created.collection,
      PUBLIC_COMMAND, { visibility: 'public', publicationSlug: 'owner-lifecycle-social' });
    assert.equal(publicResponse.statusCode, 200);
    await product.close();
    let current = (publicResponse.json() as {
      collection: { id: string; revision: string };
    }).collection;

    await runtime.pool.query('update accounts set status = $2 where id = $1', [owner.accountId, 'disabled']);
    const publisher = createPostgresPublisherCanonicalMutationApplication(runtime.db);
    const inactive = await publisher.execute({
      binding: { namespace: 'colp.publisher.v0.1.collections.patch', principalId: owner.subjectId,
        idempotencyKey: 'phase5-social-inactive-owner' },
      collectionId: current.id,
      operationId: 'phase5-social-inactive-owner-operation',
      payload: { title: 'inactive owner secret title' },
      mutation: {
        action: 'update',
        target: { collectionId: current.id, resourceId: current.id, resourceKind: 'collection' },
        parentId: null,
        expectedResourceRevision: current.revision,
        fields: { kindFields: { title: 'inactive owner secret title' }, extensions: {} },
      },
    });
    assert.equal(inactive.kind, 'executed');
    assertClosedSocialRow((await socialRows(current.id)).at(-1)!, current.id, owner.accountId, 'remove');
    if (inactive.kind === 'executed') {
      current = { ...current, revision: inactive.mutation.allocation.resourceRevision! };
    }

    await runtime.pool.query('update accounts set status = $2 where id = $1', [owner.accountId, 'active']);
    await runtime.pool.query('delete from profiles where account_id = $1', [owner.accountId]);
    const beforeMissingProfile = await runtime.pool.query(
      `select (select row_to_json(c) from collections c where id = $1) collection,
              (select count(*)::int from operations) operations,
              (select count(*)::int from audit_events) audits,
              (select count(*)::int from outbox_events) outbox`,
      [current.id],
    );
    await assert.rejects(() => publisher.execute({
      binding: { namespace: 'colp.publisher.v0.1.collections.patch', principalId: owner.subjectId,
        idempotencyKey: 'phase5-social-missing-profile' },
      collectionId: current.id,
      operationId: 'phase5-social-missing-profile-operation',
      payload: { title: 'missing profile secret title' },
      mutation: {
        action: 'update',
        target: { collectionId: current.id, resourceId: current.id, resourceKind: 'collection' },
        parentId: null,
        expectedResourceRevision: current.revision,
        fields: { kindFields: { title: 'missing profile secret title' }, extensions: {} },
      },
    }), /stable owner Profile identity is missing/u);
    assert.deepEqual((await runtime.pool.query(
      `select (select row_to_json(c) from collections c where id = $1) collection,
              (select count(*)::int from operations) operations,
              (select count(*)::int from audit_events) audits,
              (select count(*)::int from outbox_events) outbox`,
      [current.id],
    )).rows, beforeMissingProfile.rows);
    assert.equal((await runtime.pool.query(
      'select count(*)::int count from publisher_idempotency where idempotency_key = $1',
      ['phase5-social-missing-profile'],
    )).rows[0].count, 0);
  });
});
