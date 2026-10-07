import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { type CanonicalMutationWritePhase, createPostgresCanonicalMutationUnitOfWork, createPostgresCollectionsUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { PostgresCollectionMutationProjectionSink } from '../../../src/infrastructure/outbox/index.js';
import {
  createSession,
  ensureAccountFromOidcIdentity,
  type IdentityUnitOfWork,
} from '../../../src/modules/identity/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { SESSION_COOKIE_NAME } from '../../../src/transport/session-cookie.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateFixtureTables,
} from '../../support/postgres-test-runtime.js';

const CREATE_COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const UPDATE_COMMAND_ID = '22222222-2222-4222-8222-222222222222';
const PUBLICATION_CREATE_A_COMMAND_ID = '26262626-2626-4626-8626-262626262626';
const PUBLICATION_CREATE_B_COMMAND_ID = '27272727-2727-4727-8727-272727272727';
const PUBLICATION_CREATE_C_COMMAND_ID = '28282828-2828-4828-8828-282828282828';
const PUBLICATION_CREATE_D_COMMAND_ID = '29292929-2929-4929-8929-292929292929';
const PUBLICATION_SEQUENTIAL_A_COMMAND_ID = '30303030-3030-4030-8030-303030303030';
const PUBLICATION_SEQUENTIAL_B_COMMAND_ID = '31313131-3131-4131-8131-313131313131';
const PUBLICATION_CONCURRENT_C_COMMAND_ID = '32323232-3232-4232-8232-323232323232';
const PUBLICATION_CONCURRENT_D_COMMAND_ID = '33333333-4444-4333-8333-333333333333';
const PUBLICATION_WITHDRAW_COMMAND_ID = '34343434-3434-4434-8434-343434343434';
const PUBLICATION_REPUBLISH_COMMAND_ID = '35353535-3535-4535-8535-353535353535';
const PUBLICATION_PRIVATE_METADATA_COMMAND_ID = '36363636-3636-4636-8636-363636363636';
const PUBLICATION_PUBLIC_METADATA_COMMAND_ID = '37373737-3737-4737-8737-373737373737';
const SEARCH_AUTHORITY_CREATE_COMMAND_ID = '38383838-3838-4838-8838-383838383838';
const SEARCH_AUTHORITY_UPDATE_COMMAND_ID = '39393939-3939-4939-8939-393939393939';
const STALE_COMMAND_ID = '33333333-3333-4333-8333-333333333333';
const ROLLBACK_COMMAND_ID = '44444444-4444-4444-8444-444444444444';
const NODE_CREATE_COMMAND_ID = '55555555-5555-4555-8555-555555555555';
const NODE_UPDATE_COMMAND_ID = '66666666-6666-4666-8666-666666666666';
const NODE_STALE_COMMAND_ID = '77777777-7777-4777-8777-777777777777';
const NODE_ROLLBACK_COMMAND_ID = '88888888-8888-4888-8888-888888888888';
const NODE_FOLDER_COMMAND_ID = '99999999-9999-4999-8999-999999999999';
const NODE_INVALID_COMMAND_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NODE_INVALID_PARENT_COMMAND_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NODE_DRIFT_CREATE_COMMAND_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NODE_DRIFT_PATCH_COMMAND_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NODE_MALFORMED_CREATE_COMMAND_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NODE_MALFORMED_PATCH_COMMAND_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const NODE_MOVE_FOLDER_A_COMMAND_ID = '12121212-1212-4212-8212-121212121212';
const NODE_MOVE_FOLDER_B_COMMAND_ID = '13131313-1313-4313-8313-131313131313';
const NODE_MOVE_BOOKMARK_COMMAND_ID = '14141414-1414-4414-8414-141414141414';
const NODE_MOVE_COMMAND_ID = '15151515-1515-4515-8515-151515151515';
const NODE_DELETE_COMMAND_ID = '16161616-1616-4616-8616-161616161616';
const NODE_SAME_PARENT_BOOKMARK_COMMAND_ID = '17171717-1717-4717-8717-171717171717';
const NODE_SAME_PARENT_MOVE_COMMAND_ID = '18181818-1818-4818-8818-181818181818';
const NODE_STALE_MOVE_COMMAND_ID = '19191919-1919-4919-8919-191919191919';
const NODE_CYCLE_MOVE_COMMAND_ID = '20202020-2020-4020-8020-202020202020';
const NODE_NONRECURSIVE_DELETE_COMMAND_ID = '21212121-2121-4121-8121-212121212121';
const NODE_MOVE_FAULT_COMMAND_ID = '22222222-3333-4333-8333-222222222222';
const NODE_MOVE_AUTHORITY_COMMAND_ID = '23232323-2323-4323-8323-232323232323';
const NODE_DELETE_AUTHORITY_COMMAND_ID = '24242424-2424-4424-8424-242424242424';
const NODE_DELETE_STALE_CONTENT_COMMAND_ID = '25252525-2525-4525-8525-252525252525';
const ORIGIN = 'https://app.example.test';
const CREATE_BODY = {
  kind: 'bookmarks',
  title: 'Canonical Product',
  summary: 'created through the canonical HTTP route',
} as const;

type ApiApp = ReturnType<typeof buildApiApp>;

interface Client {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly accountId: string;
  readonly subjectId: string;
}

interface Harness {
  readonly app: ApiApp;
  readonly client: Client;
}

describeWithPostgres('Product collection canonical HTTP routing', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('product_collection_canonical');
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
  });

  beforeEach(async () => {
    await truncateFixtureTables(runtime.pool, `truncate table product_command_receipts, outbox_events, audit_events,
      operations, policy_revisions, content_revisions, children_revisions, resource_revisions,
      collection_policies, collection_members, nodes, collections, resource_id_ledger,
      oidc_login_transactions, sessions, account_identities, profile_handles, profiles, accounts cascade`);
  });

  afterAll(async () => isolated?.close());

  async function buildHarness(options: {
    readonly rollbackFault?: { enabled: boolean };
    readonly canonicalFault?: { phase: CanonicalMutationWritePhase | null };
    readonly afterCallbackBeforeCommit?: () => void | Promise<void>;
  } = {}): Promise<Harness> {
    const config = loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN,
      OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
    const identityUnitOfWork = createPostgresIdentityUnitOfWork(runtime.db);
    const client = await issueSession(identityUnitOfWork, config.oidc.issuer);
    const app = buildApiApp({
      config,
      identityUnitOfWork,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(
        runtime.db,
        {
          ...(options.rollbackFault || options.afterCallbackBeforeCommit ? {
            faultInjector: {
              async afterCallbackBeforeCommit() {
                if (options.rollbackFault?.enabled) throw new Error('rollback-probe');
                await options.afterCallbackBeforeCommit?.();
              },
            },
          } : {}),
          ...(options.canonicalFault ? {
            canonicalFaultInjector: {
              afterPhase(context: { readonly phase: CanonicalMutationWritePhase }) {
                if (options.canonicalFault?.phase === context.phase) {
                  throw new Error(`canonical-${context.phase}-probe`);
                }
              },
            },
          } : {}),
        },
      ),
    });
    return { app, client };
  }

  async function issueSession(
    unitOfWork: IdentityUnitOfWork,
    issuer: string,
  ): Promise<Client> {
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer,
        subject: 'product-canonical-subject',
        email: 'canonical@example.test',
        displayName: 'Canonical Owner',
        handle: 'canonical-owner',
      });
      const secrets = await createSession(ports, { accountId: ensured.account.id });
      return { ensured, secrets };
    });
    return {
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.secrets.rawSessionToken)}`,
      csrfToken: issued.secrets.rawCsrfToken,
      accountId: issued.ensured.account.id,
      subjectId: issued.ensured.account.subjectId,
    };
  }

  function headers(client: Client, commandId: string, mediaType: string | null = 'application/json') {
    return {
      cookie: client.cookie,
      origin: ORIGIN,
      'x-csrf-token': client.csrfToken,
      'known-command-id': commandId,
      ...(mediaType ? { 'content-type': mediaType } : {}),
    };
  }

  async function postCollection(harness: Harness, body = CREATE_BODY, commandId = CREATE_COMMAND_ID) {
    return harness.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: headers(harness.client, commandId),
      payload: body,
    });
  }

  async function readCanonicalState() {
    const tables = [
      'collections', 'nodes', 'collection_members', 'collection_policies',
      'resource_id_ledger',
      'resource_revisions', 'content_revisions', 'policy_revisions', 'children_revisions',
      'operations', 'audit_events', 'outbox_events', 'product_command_receipts',
    ] as const;
    return Object.fromEntries(await Promise.all(tables.map(async (table) => {
      const result = await runtime.pool.query(`select * from ${table} order by 1`);
      return [table, result.rows] as const;
    })));
  }

  test('HTTP create writes complete canonical authority, event, receipt and exact replay', async () => {
    const harness = await buildHarness();
    try {
      const badCsrf = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/collections',
        headers: {
          ...headers(harness.client, STALE_COMMAND_ID),
          'x-csrf-token': 'not-a-real-csrf-token-value____________',
        },
        payload: CREATE_BODY,
      });
      assert.equal(badCsrf.statusCode, 403);
      assert.equal((badCsrf.json() as { error: { code: string } }).error.code, 'csrf_failed');

      const created = await postCollection(harness);
      assert.equal(created.statusCode, 201);
      assert.equal(created.headers['cache-control'], 'private, no-store');
      const body = created.json() as {
        collection: { id: string; rootNodeId: string; revision: string; etag: string; contentRevision: string; policyRevision: string; createdAt: string; updatedAt: string };
        root: { id: string; revision: string; childrenRevision: string; createdAt: string; updatedAt: string };
      };
      assert.equal(created.headers.location, `/api/v1/collections/${body.collection.id}`);
      assert.equal(created.headers.etag, body.collection.etag);

      const replay = await postCollection(harness);
      assert.equal(replay.statusCode, created.statusCode);
      assert.equal(replay.body, created.body);
      assert.equal(replay.headers.location, created.headers.location);
      assert.equal(replay.headers.etag, created.headers.etag);
      assert.equal(replay.headers['cache-control'], created.headers['cache-control']);

      const reused = await postCollection(
        harness,
        { ...CREATE_BODY, title: 'Different fingerprint' },
      );
      assert.equal(reused.statusCode, 409);
      assert.equal((reused.json() as { error: { code: string } }).error.code, 'command_id_reused');

      const collectionResult = await runtime.pool.query(
        'select * from collections where id = $1',
        [body.collection.id],
      );
      assert.equal(collectionResult.rowCount, 1);
      const collection = collectionResult.rows[0];
      assert.deepEqual(collection.payload_json, {
        schemaVersion: 1,
        resourceType: 'collection',
        id: body.collection.id,
        ownerSubjectId: harness.client.subjectId,
        title: CREATE_BODY.title,
        summary: CREATE_BODY.summary,
        kind: CREATE_BODY.kind,
        visibility: 'private',
        allowSearchIndexing: false,
        rootNodeId: body.root.id,
        resourceRevision: body.collection.revision,
        contentRevision: body.collection.contentRevision,
        policyRevision: body.collection.policyRevision,
        commitOrdinal: '1',
        createdAt: body.collection.createdAt,
        updatedAt: body.collection.updatedAt,
        deletedAt: null,
        extensions: {},
      });
      assert.deepEqual(
        {
          ownerSubjectId: collection.owner_subject_id,
          title: collection.title,
          summary: collection.summary,
          kind: collection.kind,
          visibility: collection.visibility,
          allowSearchIndexing: collection.allow_search_indexing,
          rootNodeId: collection.root_node_id,
          resourceRevision: collection.resource_revision,
          contentRevision: collection.content_revision,
          policyRevision: collection.policy_revision,
          commitOrdinal: collection.commit_ordinal,
          deletedAt: collection.deleted_at,
          payloadSchemaVersion: collection.payload_schema_version,
          payloadAuthorityStatus: collection.payload_authority_status,
          createdAt: collection.created_at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
          updatedAt: collection.updated_at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        },
        {
          ownerSubjectId: harness.client.subjectId,
          title: CREATE_BODY.title,
          summary: CREATE_BODY.summary,
          kind: CREATE_BODY.kind,
          visibility: 'private',
          allowSearchIndexing: false,
          rootNodeId: body.root.id,
          resourceRevision: body.collection.revision,
          contentRevision: body.collection.contentRevision,
          policyRevision: body.collection.policyRevision,
          commitOrdinal: '1',
          deletedAt: null,
          payloadSchemaVersion: 1,
          payloadAuthorityStatus: 'backfilled',
          createdAt: body.collection.createdAt,
          updatedAt: body.collection.updatedAt,
        },
      );

      const rootResult = await runtime.pool.query('select * from nodes where id = $1', [body.root.id]);
      assert.equal(rootResult.rowCount, 1);
      const root = rootResult.rows[0];
      assert.deepEqual(root.payload_json, {
        schemaVersion: 1,
        resourceType: 'node',
        id: body.root.id,
        collectionId: body.collection.id,
        parentId: null,
        kind: 'root',
        isRoot: true,
        folderRole: 'root',
        title: CREATE_BODY.title,
        url: null,
        description: null,
        tags: [],
        visibility: 'inherit',
        position: null,
        resourceRevision: body.root.revision,
        childrenRevision: body.root.childrenRevision,
        createdAt: body.root.createdAt,
        updatedAt: body.root.updatedAt,
        deletedAt: null,
        deletedCommitOrdinal: null,
        extensions: {},
      });
      assert.deepEqual(
        {
          collectionId: root.collection_id,
          parentId: root.parent_id,
          kind: root.kind,
          isRoot: root.is_root,
          title: root.title,
          url: root.url,
          description: root.description,
          tags: root.tags,
          visibility: root.visibility,
          positionToken: root.position_token,
          resourceRevision: root.resource_revision,
          childrenRevision: root.children_revision,
          deletedAt: root.deleted_at,
          deletedCommitOrdinal: root.deleted_commit_ordinal,
          payloadSchemaVersion: root.payload_schema_version,
          payloadAuthorityStatus: root.payload_authority_status,
          createdAt: root.created_at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
          updatedAt: root.updated_at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        },
        {
          collectionId: body.collection.id,
          parentId: null,
          kind: 'folder',
          isRoot: true,
          title: CREATE_BODY.title,
          url: null,
          description: null,
          tags: null,
          visibility: 'inherit',
          positionToken: null,
          resourceRevision: body.root.revision,
          childrenRevision: body.root.childrenRevision,
          deletedAt: null,
          deletedCommitOrdinal: null,
          payloadSchemaVersion: 1,
          payloadAuthorityStatus: 'backfilled',
          createdAt: body.root.createdAt,
          updatedAt: body.root.updatedAt,
        },
      );

      const event = (await runtime.pool.query(
        `select event_type, event_version, handler_name, handler_mode, aggregate_type,
          aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal::text, payload_json
          from outbox_events where aggregate_id = $1`,
        [body.collection.id],
      )).rows[0];
      assert.deepEqual(event, {
        event_type: 'collection.created',
        event_version: 1,
        handler_name: 'collection_created_projection',
        handler_mode: 'projection_latest_only',
        aggregate_type: 'collection',
        aggregate_id: body.collection.id,
        aggregate_scope: body.collection.id,
        aggregate_revision: body.collection.revision,
        commit_ordinal: '1',
        payload_json: {
          collectionId: body.collection.id,
          ownerSubjectId: harness.client.subjectId,
          kind: CREATE_BODY.kind,
          rootNodeId: body.root.id,
        },
      });

      const receipt = (await runtime.pool.query(
        `select target_identity, result_status, result_headers, result_media_type,
          convert_from(result_bytes, 'UTF8') result_body, contract_version,
          completed_at is not null completed from product_command_receipts where command_id = $1`,
        [CREATE_COMMAND_ID],
      )).rows[0];
      assert.deepEqual(receipt, {
        target_identity: body.collection.id,
        result_status: 201,
        result_headers: {
          location: `/api/v1/collections/${body.collection.id}`,
          etag: body.collection.etag,
          'cache-control': 'private, no-store',
          'content-type': 'application/json',
        },
        result_media_type: 'application/json',
        result_body: created.body,
        contract_version: '1.0.0',
        completed: true,
      });
    } finally {
      await harness.app.close();
    }
  });

  test('HTTP metadata update preserves exact replay, stale conflict, authority and event contract', async () => {
    const harness = await buildHarness();
    try {
      const created = await postCollection(harness);
      assert.equal(created.statusCode, 201);
      const createdBody = created.json() as {
        collection: { id: string; etag: string; revision: string; contentRevision: string; policyRevision: string; createdAt: string; updatedAt: string };
        root: { id: string };
      };
      const patch = { title: 'Canonical Updated', summary: null };
      const update = await harness.app.inject({
        method: 'PATCH',
        url: `/api/v1/collections/${createdBody.collection.id}`,
        headers: {
          ...headers(harness.client, UPDATE_COMMAND_ID, 'application/merge-patch+json'),
          'if-match': createdBody.collection.etag,
        },
        payload: patch,
      });
      assert.equal(update.statusCode, 200);
      const updateBody = update.json() as {
        collection: Record<string, unknown> & {
          id: string;
          revision: string;
          contentRevision: string;
          etag: string;
          policyRevision: string;
          createdAt: string;
          updatedAt: string;
        };
      };
      assert.equal(update.headers.etag, updateBody.collection.etag);

      const replay = await harness.app.inject({
        method: 'PATCH',
        url: `/api/v1/collections/${createdBody.collection.id}`,
        headers: {
          ...headers(harness.client, UPDATE_COMMAND_ID, 'application/merge-patch+json'),
          'if-match': createdBody.collection.etag,
        },
        payload: patch,
      });
      assert.equal(replay.statusCode, update.statusCode);
      assert.equal(replay.body, update.body);
      assert.equal(replay.headers.etag, update.headers.etag);

      const stale = await harness.app.inject({
        method: 'PATCH',
        url: `/api/v1/collections/${createdBody.collection.id}`,
        headers: {
          ...headers(harness.client, STALE_COMMAND_ID, 'application/merge-patch+json'),
          'if-match': createdBody.collection.etag,
        },
        payload: { title: 'Must not persist' },
      });
      assert.equal(stale.statusCode, 412);
      assert.equal((stale.json() as { error: { code: string } }).error.code, 'precondition_failed');

      const collection = (await runtime.pool.query(
        'select * from collections where id = $1',
        [createdBody.collection.id],
      )).rows[0];
      assert.deepEqual(collection.payload_json, {
        schemaVersion: 1,
        resourceType: 'collection',
        id: createdBody.collection.id,
        ownerSubjectId: harness.client.subjectId,
        title: patch.title,
        summary: patch.summary,
        kind: CREATE_BODY.kind,
        visibility: 'private',
        allowSearchIndexing: false,
        rootNodeId: createdBody.root.id,
        resourceRevision: updateBody.collection.revision,
        contentRevision: updateBody.collection.contentRevision,
        policyRevision: createdBody.collection.policyRevision,
        commitOrdinal: '2',
        createdAt: createdBody.collection.createdAt,
        updatedAt: updateBody.collection.updatedAt,
        deletedAt: null,
        extensions: {},
      });
      assert.deepEqual(
        {
          title: collection.title,
          summary: collection.summary,
          resourceRevision: collection.resource_revision,
          contentRevision: collection.content_revision,
          policyRevision: collection.policy_revision,
          commitOrdinal: collection.commit_ordinal,
          payloadSchemaVersion: collection.payload_schema_version,
          payloadAuthorityStatus: collection.payload_authority_status,
          ownerSubjectId: collection.owner_subject_id,
          kind: collection.kind,
          visibility: collection.visibility,
          rootNodeId: collection.root_node_id,
          createdAt: collection.created_at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
          updatedAt: collection.updated_at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
          deletedAt: collection.deleted_at,
        },
        {
          title: patch.title,
          summary: patch.summary,
          resourceRevision: updateBody.collection.revision,
          contentRevision: updateBody.collection.contentRevision,
          policyRevision: createdBody.collection.policyRevision,
          commitOrdinal: '2',
          payloadSchemaVersion: 1,
          payloadAuthorityStatus: 'backfilled',
          ownerSubjectId: harness.client.subjectId,
          kind: CREATE_BODY.kind,
          visibility: 'private',
          rootNodeId: createdBody.root.id,
          createdAt: createdBody.collection.createdAt,
          updatedAt: updateBody.collection.updatedAt,
          deletedAt: null,
        },
      );

      const event = (await runtime.pool.query(
        `select event_type, event_version, handler_name, handler_mode, aggregate_type,
          aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal::text, payload_json
          from outbox_events where event_type = 'collection.updated'`,
      )).rows[0];
      assert.deepEqual(event, {
        event_type: 'collection.updated',
        event_version: 1,
        handler_name: 'collection_updated_projection',
        handler_mode: 'projection_latest_only',
        aggregate_type: 'collection',
        aggregate_id: createdBody.collection.id,
        aggregate_scope: createdBody.collection.id,
        aggregate_revision: updateBody.collection.revision,
        commit_ordinal: '2',
        payload_json: {
          collectionId: createdBody.collection.id,
          resourceRevision: updateBody.collection.revision,
          contentRevision: updateBody.collection.contentRevision,
          title: patch.title,
          summary: patch.summary,
        },
      });

      const receipt = (await runtime.pool.query(
        `select target_identity, result_status, result_headers, result_media_type,
          convert_from(result_bytes, 'UTF8') result_body, contract_version,
          completed_at is not null completed from product_command_receipts where command_id = $1`,
        [UPDATE_COMMAND_ID],
      )).rows[0];
      assert.deepEqual(receipt, {
        target_identity: createdBody.collection.id,
        result_status: 200,
        result_headers: {
          etag: updateBody.collection.etag,
          'cache-control': 'private, no-store',
          'content-type': 'application/json',
        },
        result_media_type: 'application/json',
        result_body: update.body,
        contract_version: '1.0.0',
        completed: true,
      });
    } finally {
      await harness.app.close();
    }
  });

  test('persists owner search authority through canonical policy, payload, audit, outbox, and receipt', async () => {
    const harness = await buildHarness();
    try {
      const created = await postCollection(harness, {
        ...CREATE_BODY,
        title: 'Search authority collection',
      }, SEARCH_AUTHORITY_CREATE_COMMAND_ID);
      assert.equal(created.statusCode, 201);
      const createdBody = created.json() as {
        collection: { id: string; etag: string; contentRevision: string; policyRevision: string };
      };

      const updated = await harness.app.inject({
        method: 'PATCH',
        url: `/api/v1/collections/${createdBody.collection.id}`,
        headers: {
          ...headers(harness.client, SEARCH_AUTHORITY_UPDATE_COMMAND_ID, 'application/merge-patch+json'),
          'if-match': createdBody.collection.etag,
        },
        payload: { allowSearchIndexing: true },
      });
      assert.equal(updated.statusCode, 200);
      const body = updated.json() as {
        collection: {
          allowSearchIndexing: boolean; visibility: string; contentRevision: string; policyRevision: string;
        };
      };
      assert.equal(body.collection.allowSearchIndexing, true);
      assert.equal(body.collection.visibility, 'private');
      assert.equal(body.collection.contentRevision, createdBody.collection.contentRevision);
      assert.notEqual(body.collection.policyRevision, createdBody.collection.policyRevision);

      const authority = (await runtime.pool.query(`select allow_search_indexing,payload_json,
        (select count(*)::int from operations where collection_id=c.id) operation_count,
        (select count(*)::int from audit_events where collection_id=c.id) audit_count,
        (select count(*)::int from outbox_events where aggregate_id=c.id
          and event_type='collection.updated') update_outbox_count,
        (select count(*)::int from outbox_events where aggregate_id=c.id
          and handler_name='publication_cache_purge') purge_count
        from collections c where id=$1`, [createdBody.collection.id])).rows[0];
      assert.equal(authority.allow_search_indexing, true);
      assert.equal(authority.payload_json.allowSearchIndexing, true);
      assert.deepEqual({
        operations: authority.operation_count,
        audit: authority.audit_count,
        outbox: authority.update_outbox_count,
        purge: authority.purge_count,
      }, { operations: 2, audit: 2, outbox: 1, purge: 0 });

      const receipt = (await runtime.pool.query(`select contract_version,result_status,
        convert_from(result_bytes,'UTF8')::jsonb #>> '{collection,allowSearchIndexing}' authority
        from product_command_receipts where command_id=$1`, [SEARCH_AUTHORITY_UPDATE_COMMAND_ID])).rows[0];
      assert.deepEqual(receipt, { contract_version: '1.2.0', result_status: 200, authority: 'true' });
    } finally {
      await harness.app.close();
    }
  });

  test('publication slug claims return stable conflicts, roll back failed work, serialize concurrency, and replay', async () => {
    const winnerAtCommit = Promise.withResolvers<void>();
    const releaseWinner = Promise.withResolvers<void>();
    let pauseWinnerBeforeCommit = false;
    const harness = await buildHarness({
      async afterCallbackBeforeCommit() {
        if (!pauseWinnerBeforeCommit) return;
        pauseWinnerBeforeCommit = false;
        winnerAtCommit.resolve();
        await releaseWinner.promise;
      },
    });
    try {
      const createIds = [
        PUBLICATION_CREATE_A_COMMAND_ID,
        PUBLICATION_CREATE_B_COMMAND_ID,
        PUBLICATION_CREATE_C_COMMAND_ID,
        PUBLICATION_CREATE_D_COMMAND_ID,
      ] as const;
      const created = [] as Array<{ id: string; etag: string; rootNodeId: string }>;
      for (const [index, commandId] of createIds.entries()) {
        const response = await postCollection(harness, {
          ...CREATE_BODY,
          title: `Publication claim ${index}`,
        }, commandId);
        assert.equal(response.statusCode, 201);
        const body = response.json() as {
          collection: { id: string; etag: string };
          root: { id: string };
        };
        created.push({ ...body.collection, rootNodeId: body.root.id });
      }

      const publish = (collection: { id: string; etag: string }, commandId: string, slug: string) =>
        harness.app.inject({
          method: 'PATCH',
          url: `/api/v1/collections/${collection.id}`,
          headers: {
            ...headers(harness.client, commandId, 'application/merge-patch+json'),
            'if-match': collection.etag,
          },
          payload: { visibility: 'public', publicationSlug: slug },
        });

      const first = await publish(created[0]!, PUBLICATION_SEQUENTIAL_A_COMMAND_ID, 'shared-sequential-slug');
      assert.equal(first.statusCode, 200);
      const firstBody = first.json() as {
        collection: {
          etag: string;
          contentRevision: string;
          policyRevision: string;
          publishedAt: string;
        };
      };
      assert.equal(first.headers.location, `${ORIGIN}/c/shared-sequential-slug`);
      assert.equal(first.headers['cache-control'], 'private, no-store');
      assert.equal(first.headers['content-type'], 'application/json');
      const purgeRowsFor = async (collectionIds: readonly string[]) => (await runtime.pool.query<{
        event_type: string;
        event_version: number;
        handler_name: string;
        handler_mode: string;
        aggregate_id: string;
        aggregate_scope: string | null;
        payload_json: Record<string, unknown>;
        source_event_exists: boolean;
      }>(`select purge.event_type, purge.event_version, purge.handler_name, purge.handler_mode,
          purge.aggregate_id, purge.aggregate_scope, purge.payload_json,
          exists (select 1 from outbox_events source
            where source.domain_event_id = purge.domain_event_id
              and source.event_type = purge.payload_json->>'sourceEventType'
              and source.event_version = (purge.payload_json->>'sourceEventVersion')::integer) source_event_exists
        from outbox_events purge
        where purge.aggregate_id = any($1::text[]) and purge.handler_name = 'publication_cache_purge'
        order by purge.commit_ordinal`, [collectionIds])).rows;
      assert.deepEqual(await purgeRowsFor([created[0]!.id]), [{
        event_type: 'publication.cache_purge.requested',
        event_version: 2,
        handler_name: 'publication_cache_purge',
        handler_mode: 'delivery_each_event',
        aggregate_id: created[0]!.id,
        aggregate_scope: created[0]!.id,
        payload_json: {
          collectionId: created[0]!.id,
          contentRevision: firstBody.collection.contentRevision,
          policyRevision: firstBody.collection.policyRevision,
          publicationSlug: 'shared-sequential-slug',
          sourceEventType: 'collection.updated',
          sourceEventVersion: 1,
          visibility: 'public',
        },
        source_event_exists: true,
      }]);
      const publicationRevisions = async () => (await runtime.pool.query(`select
        (select count(*)::int from resource_revisions where collection_id = $1 and resource_id = $1) resources,
        (select count(*)::int from content_revisions where collection_id = $1) contents,
        (select count(*)::int from policy_revisions where collection_id = $1) policies,
        content_revision, policy_revision, commit_ordinal::text
        from collections where id = $1`, [created[0]!.id])).rows[0];
      assert.deepEqual(await publicationRevisions(), {
        resources: 2,
        contents: 1,
        policies: 2,
        content_revision: firstBody.collection.contentRevision,
        policy_revision: firstBody.collection.policyRevision,
        commit_ordinal: '2',
      });
      const beforeFailedClaim = await readCanonicalState();
      const duplicate = await publish(created[1]!, PUBLICATION_SEQUENTIAL_B_COMMAND_ID, 'shared-sequential-slug');
      assert.equal(duplicate.statusCode, 409);
      assert.deepEqual(duplicate.json(), {
        error: {
          code: 'publication_slug_conflict',
          message: 'This publication slug is already in use. Choose another slug.',
          requestId: duplicate.json().error.requestId,
          recovery: 'user_action',
          sameRequestRetrySafe: false,
          precondition: null,
          currentEtag: null,
          retryAfterSeconds: null,
          fieldErrors: [],
        },
      });
      assert.deepEqual(await purgeRowsFor([created[1]!.id]), []);
      assert.deepEqual(await readCanonicalState(), beforeFailedClaim);

      const replay = await publish(created[0]!, PUBLICATION_SEQUENTIAL_A_COMMAND_ID, 'shared-sequential-slug');
      assert.equal(replay.statusCode, first.statusCode);
      assert.equal(replay.body, first.body);
      for (const header of ['etag', 'location', 'cache-control', 'content-type'] as const) {
        assert.equal(replay.headers[header], first.headers[header], header);
      }
      assert.equal(
        (await purgeRowsFor([created[0]!.id])).length,
        1,
        'exact command replay must not enqueue a second purge delivery',
      );

      const privateMetadata = await harness.app.inject({
        method: 'PATCH',
        url: `/api/v1/collections/${created[1]!.id}`,
        headers: {
          ...headers(harness.client, PUBLICATION_PRIVATE_METADATA_COMMAND_ID, 'application/merge-patch+json'),
          'if-match': created[1]!.etag,
        },
        payload: { title: 'Still private' },
      });
      assert.equal(privateMetadata.statusCode, 200);
      assert.deepEqual(await purgeRowsFor([created[1]!.id]), []);

      const withdraw = await harness.app.inject({
        method: 'PATCH',
        url: `/api/v1/collections/${created[0]!.id}`,
        headers: {
          ...headers(harness.client, PUBLICATION_WITHDRAW_COMMAND_ID, 'application/merge-patch+json'),
          'if-match': firstBody.collection.etag,
        },
        payload: { visibility: 'private' },
      });
      assert.equal(withdraw.statusCode, 200);
      assert.equal(withdraw.headers.location, `${ORIGIN}/c/shared-sequential-slug`);
      const withdrawBody = withdraw.json() as {
        collection: { etag: string; contentRevision: string; policyRevision: string; publishedAt: string };
      };
      assert.equal(withdrawBody.collection.publishedAt, firstBody.collection.publishedAt);
      assert.equal(withdrawBody.collection.contentRevision, firstBody.collection.contentRevision);
      assert.deepEqual((await purgeRowsFor([created[0]!.id])).at(-1), {
        event_type: 'publication.cache_purge.requested',
        event_version: 2,
        handler_name: 'publication_cache_purge',
        handler_mode: 'delivery_each_event',
        aggregate_id: created[0]!.id,
        aggregate_scope: created[0]!.id,
        payload_json: {
          collectionId: created[0]!.id,
          contentRevision: withdrawBody.collection.contentRevision,
          policyRevision: withdrawBody.collection.policyRevision,
          publicationSlug: 'shared-sequential-slug',
          sourceEventType: 'collection.updated',
          sourceEventVersion: 1,
          visibility: 'private',
        },
        source_event_exists: true,
      });

      assert.deepEqual(await publicationRevisions(), {
        resources: 3,
        contents: 1,
        policies: 3,
        content_revision: firstBody.collection.contentRevision,
        policy_revision: withdrawBody.collection.policyRevision,
        commit_ordinal: '3',
      });

      const republish = await harness.app.inject({
        method: 'PATCH',
        url: `/api/v1/collections/${created[0]!.id}`,
        headers: {
          ...headers(harness.client, PUBLICATION_REPUBLISH_COMMAND_ID, 'application/merge-patch+json'),
          'if-match': withdrawBody.collection.etag,
        },
        payload: { visibility: 'unlisted', publicationSlug: 'shared-sequential-slug' },
      });
      assert.equal(republish.statusCode, 200);
      assert.equal(republish.headers.location, `${ORIGIN}/c/shared-sequential-slug`);
      const republishBody = republish.json() as {
        collection: { etag: string; contentRevision: string; policyRevision: string; publishedAt: string; visibility: string };
      };
      assert.equal(republishBody.collection.visibility, 'unlisted');
      assert.equal(republishBody.collection.publishedAt, firstBody.collection.publishedAt);
      assert.equal(republishBody.collection.contentRevision, firstBody.collection.contentRevision);
      assert.deepEqual((await purgeRowsFor([created[0]!.id])).at(-1), {
        event_type: 'publication.cache_purge.requested',
        event_version: 2,
        handler_name: 'publication_cache_purge',
        handler_mode: 'delivery_each_event',
        aggregate_id: created[0]!.id,
        aggregate_scope: created[0]!.id,
        payload_json: {
          collectionId: created[0]!.id,
          contentRevision: republishBody.collection.contentRevision,
          policyRevision: republishBody.collection.policyRevision,
          publicationSlug: 'shared-sequential-slug',
          sourceEventType: 'collection.updated',
          sourceEventVersion: 1,
          visibility: 'unlisted',
        },
        source_event_exists: true,
      });
      assert.deepEqual(await publicationRevisions(), {
        resources: 4,
        contents: 1,
        policies: 4,
        content_revision: firstBody.collection.contentRevision,
        policy_revision: republishBody.collection.policyRevision,
        commit_ordinal: '4',
      });

      const publicMetadata = await harness.app.inject({
        method: 'PATCH',
        url: `/api/v1/collections/${created[0]!.id}`,
        headers: {
          ...headers(harness.client, PUBLICATION_PUBLIC_METADATA_COMMAND_ID, 'application/merge-patch+json'),
          'if-match': republishBody.collection.etag,
        },
        payload: { title: 'Published metadata changed' },
      });
      assert.equal(publicMetadata.statusCode, 200);
      const publicMetadataBody = publicMetadata.json() as {
        collection: { contentRevision: string; policyRevision: string };
      };
      assert.deepEqual((await purgeRowsFor([created[0]!.id])).at(-1), {
        event_type: 'publication.cache_purge.requested',
        event_version: 2,
        handler_name: 'publication_cache_purge',
        handler_mode: 'delivery_each_event',
        aggregate_id: created[0]!.id,
        aggregate_scope: created[0]!.id,
        payload_json: {
          collectionId: created[0]!.id,
          contentRevision: publicMetadataBody.collection.contentRevision,
          policyRevision: publicMetadataBody.collection.policyRevision,
          publicationSlug: 'shared-sequential-slug',
          sourceEventType: 'collection.updated',
          sourceEventVersion: 1,
          visibility: 'unlisted',
        },
        source_event_exists: true,
      });

      const publicNode = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${created[0]!.id}/nodes`,
        headers: headers(harness.client, NODE_CREATE_COMMAND_ID),
        payload: {
          parentId: created[0]!.rootNodeId,
          afterId: null,
          beforeId: null,
          node: {
            kind: 'bookmark',
            title: 'Published bookmark',
            url: 'https://example.test/published',
            description: null,
            tags: [],
            visibility: 'inherit',
          },
        },
      });
      assert.equal(publicNode.statusCode, 201);
      const publicNodeBody = publicNode.json() as {
        fence: { contentRevision: string; policyRevision: string };
      };
      assert.deepEqual((await purgeRowsFor([created[0]!.id])).at(-1), {
        event_type: 'publication.cache_purge.requested',
        event_version: 2,
        handler_name: 'publication_cache_purge',
        handler_mode: 'delivery_each_event',
        aggregate_id: created[0]!.id,
        aggregate_scope: created[0]!.id,
        payload_json: {
          collectionId: created[0]!.id,
          contentRevision: publicNodeBody.fence.contentRevision,
          policyRevision: publicNodeBody.fence.policyRevision,
          publicationSlug: 'shared-sequential-slug',
          sourceEventType: 'node.created',
          sourceEventVersion: 1,
          visibility: 'unlisted',
        },
        source_event_exists: true,
      });

      const claims = [
        { collection: created[2]!, commandId: PUBLICATION_CONCURRENT_C_COMMAND_ID },
        { collection: created[3]!, commandId: PUBLICATION_CONCURRENT_D_COMMAND_ID },
      ] as const;
      pauseWinnerBeforeCommit = true;
      const winningRequest = publish(
        claims[0].collection,
        claims[0].commandId,
        'genuinely-concurrent-slug',
      );
      await winnerAtCommit.promise;
      const losingRequest = publish(
        claims[1].collection,
        claims[1].commandId,
        'genuinely-concurrent-slug',
      );
      await waitForBlockedCollectionUpdate();
      releaseWinner.resolve();
      const responses = await Promise.all([winningRequest, losingRequest]);
      assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
      const loserIndex = responses.findIndex((response) => response.statusCode === 409);
      const winnerIndex = responses.findIndex((response) => response.statusCode === 200);
      assert.notEqual(loserIndex, -1);
      assert.notEqual(winnerIndex, -1);
      const conflict = responses[loserIndex]!.json() as { error: { code: string; recovery: string } };
      assert.deepEqual(
        { code: conflict.error.code, recovery: conflict.error.recovery },
        { code: 'publication_slug_conflict', recovery: 'user_action' },
      );

      const loser = claims[loserIndex]!;
      const losingState = (await runtime.pool.query(`select visibility, publication_slug,
        commit_ordinal::text from collections where id = $1`, [loser.collection.id])).rows[0];
      assert.deepEqual(losingState, {
        visibility: 'private',
        publication_slug: null,
        commit_ordinal: '1',
      });
      const failedArtifacts = (await runtime.pool.query(`select
        (select count(*)::int from product_command_receipts where command_id = $1) receipts,
        (select count(*)::int from outbox_events where aggregate_id = $2
          and event_type = 'collection.updated') outbox,
        (select count(*)::int from resource_revisions where collection_id = $2) revisions`,
      [loser.commandId, loser.collection.id])).rows[0];
      assert.deepEqual(failedArtifacts, { receipts: 0, outbox: 0, revisions: 2 });

      const winner = claims[winnerIndex]!;
      const concurrentReplay = await publish(
        winner.collection,
        winner.commandId,
        'genuinely-concurrent-slug',
      );
      assert.equal(concurrentReplay.statusCode, 200);
      assert.equal(concurrentReplay.body, responses[winnerIndex]!.body);
      assert.equal(concurrentReplay.headers.etag, responses[winnerIndex]!.headers.etag);
    } finally {
      releaseWinner.resolve();
      await harness.app.close();
    }
  });

  async function waitForBlockedCollectionUpdate(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await runtime.pool.query<{ blocked: boolean }>(`select exists (
        select 1 from pg_stat_activity
        where application_name = 'known-test-product_collection_canonical'
          and cardinality(pg_blocking_pids(pid)) > 0
          and query ilike 'update "collections"%'
      ) blocked`);
      if (result.rows[0]?.blocked) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail('the competing publication claim never blocked on the uncommitted unique index entry');
  }

  test('HTTP create fault rolls canonical writes and receipt back together', async () => {
    const harness = await buildHarness({ rollbackFault: { enabled: true } });
    try {
      const response = await postCollection(harness, CREATE_BODY, ROLLBACK_COMMAND_ID);
      assert.equal(response.statusCode, 500);
      assert.equal((response.json() as { error: { code: string } }).error.code, 'internal_error');
      const counts = (await runtime.pool.query(`select
        (select count(*)::int from collections) collections,
        (select count(*)::int from nodes) nodes,
        (select count(*)::int from operations) operations,
        (select count(*)::int from audit_events) audit,
        (select count(*)::int from outbox_events) outbox,
        (select count(*)::int from product_command_receipts) receipts`)).rows[0];
      assert.deepEqual(counts, {
        collections: 0,
        nodes: 0,
        operations: 0,
        audit: 0,
        outbox: 0,
        receipts: 0,
      });
    } finally {
      await harness.app.close();
    }
  });

  test('HTTP metadata update fault preserves prior canonical state and rolls receipt back', async () => {
    const rollbackFault = { enabled: false };
    const harness = await buildHarness({ rollbackFault });
    try {
      const created = await postCollection(harness);
      assert.equal(created.statusCode, 201);
      const body = created.json() as { collection: { id: string; etag: string } };
      const before = await readCanonicalState();

      rollbackFault.enabled = true;
      const failed = await harness.app.inject({
        method: 'PATCH',
        url: `/api/v1/collections/${body.collection.id}`,
        headers: {
          ...headers(harness.client, ROLLBACK_COMMAND_ID, 'application/merge-patch+json'),
          'if-match': body.collection.etag,
        },
        payload: { title: 'Must roll back', summary: 'must not persist' },
      });
      assert.equal(failed.statusCode, 500);
      assert.equal((failed.json() as { error: { code: string } }).error.code, 'internal_error');

      const after = await readCanonicalState();
      assert.deepEqual(after, before);
      assert.equal(
        after.product_command_receipts.some((row) => row.command_id === ROLLBACK_COMMAND_ID),
        false,
      );
    } finally {
      await harness.app.close();
    }
  });

  test('HTTP node create/update use canonical authority, outbox and exact receipt replay', async () => {
    const harness = await buildHarness();
    try {
      const collectionResponse = await postCollection(harness);
      assert.equal(collectionResponse.statusCode, 201);
      const collection = collectionResponse.json() as {
        collection: { id: string; policyRevision: string };
        root: { id: string };
      };
      const createPayload = {
        parentId: collection.root.id,
        afterId: null,
        beforeId: null,
        node: {
          kind: 'bookmark',
          title: 'Canonical node',
          url: 'https://example.test/path?q=1#fragment',
          description: 'created through canonical HTTP',
          tags: ['canonical', 'node'],
          visibility: 'inherit',
        },
      };
      const created = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collection.collection.id}/nodes`,
        headers: headers(harness.client, NODE_CREATE_COMMAND_ID),
        payload: createPayload,
      });
      assert.equal(created.statusCode, 201);
      const createdBody = created.json() as {
        node: { id: string; revision: string; etag: string; position: string };
        parent: { childrenRevision: string };
        fence: { contentRevision: string; policyRevision: string };
      };
      assert.equal(created.headers.location,
        `/api/v1/collections/${collection.collection.id}/nodes/${createdBody.node.id}`);
      assert.equal(created.headers.etag, createdBody.node.etag);
      assert.equal(createdBody.fence.policyRevision, collection.collection.policyRevision);
      const inheritPolicyState = (await runtime.pool.query(
        'select policy_revision, commit_ordinal::text from collections where id = $1',
        [collection.collection.id],
      )).rows[0];
      assert.deepEqual(inheritPolicyState, {
        policy_revision: collection.collection.policyRevision,
        commit_ordinal: '2',
      });
      assert.equal((await runtime.pool.query(
        'select count(*)::int count from policy_revisions where collection_id = $1 and ordinal = 2',
        [collection.collection.id],
      )).rows[0].count, 0);

      const replay = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collection.collection.id}/nodes`,
        headers: headers(harness.client, NODE_CREATE_COMMAND_ID),
        payload: createPayload,
      });
      assert.equal(replay.statusCode, 201);
      assert.equal(replay.body, created.body);

      const folder = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collection.collection.id}/nodes`,
        headers: headers(harness.client, NODE_FOLDER_COMMAND_ID),
        payload: {
          parentId: collection.root.id,
          afterId: createdBody.node.id,
          beforeId: null,
          node: { kind: 'folder', title: 'Canonical folder', description: null, tags: [], visibility: 'private' },
        },
      });
      assert.equal(folder.statusCode, 201);
      const folderBody = folder.json() as {
        node: { id: string; kind: string; childrenRevision: string; revision: string; visibility: string };
        parent: { childrenRevision: string };
        fence: { contentRevision: string; policyRevision: string };
      };
      assert.equal(folderBody.node.kind, 'folder');
      assert.equal(typeof folderBody.node.childrenRevision, 'string');
      assert.equal(folderBody.node.visibility, 'private');
      assert.notEqual(folderBody.fence.policyRevision, collection.collection.policyRevision);
      const privatePolicyEvidence = await runtime.pool.query(
        `select p.revision, p.ordinal::text, c.policy_revision, c.commit_ordinal::text,
          c.payload_json ->> 'policyRevision' payload_policy_revision,
          c.payload_json ->> 'commitOrdinal' payload_commit_ordinal,
          o.event_type, o.aggregate_revision, o.commit_ordinal::text event_ordinal, o.payload_json event_payload
          from policy_revisions p
          join collections c on c.id = p.collection_id
          join outbox_events o on o.aggregate_id = $2 and o.commit_ordinal = p.ordinal
          where p.collection_id = $1 and p.ordinal = 3`,
        [collection.collection.id, folderBody.node.id],
      );
      assert.equal(privatePolicyEvidence.rowCount, 1);
      assert.deepEqual(privatePolicyEvidence.rows[0], {
        revision: folderBody.fence.policyRevision,
        ordinal: '3',
        policy_revision: folderBody.fence.policyRevision,
        commit_ordinal: '3',
        payload_policy_revision: folderBody.fence.policyRevision,
        payload_commit_ordinal: '3',
        event_type: 'node.created',
        aggregate_revision: folderBody.node.revision,
        event_ordinal: '3',
        event_payload: {
          collectionId: collection.collection.id,
          contentRevision: folderBody.fence.contentRevision,
          kind: 'folder',
          nodeId: folderBody.node.id,
          policyRevision: folderBody.fence.policyRevision,
          parentChildrenRevision: (folder.json() as { parent: { childrenRevision: string } }).parent.childrenRevision,
          parentId: collection.root.id,
          resourceRevision: folderBody.node.revision,
        },
      });
      const privateFolder = (await runtime.pool.query(
        'select visibility, payload_json from nodes where id = $1',
        [folderBody.node.id],
      )).rows[0];
      assert.equal(privateFolder.visibility, 'private');
      assert.equal(privateFolder.payload_json.visibility, 'private');
      assert.deepEqual(privateFolder.payload_json.extensions, {});
      const createChildrenEvidence = (await runtime.pool.query(
        `select parent_id, revision, ordinal::text
          from children_revisions
          where collection_id = $1 and ordinal in (2, 3)`,
        [collection.collection.id],
      )).rows as Array<{ parent_id: string; revision: string; ordinal: string }>;
      assert.deepEqual(
        createChildrenEvidence.filter((row) => row.ordinal === '2'),
        [{
          parent_id: collection.root.id,
          revision: createdBody.parent.childrenRevision,
          ordinal: '2',
        }],
      );
      assert.deepEqual(
        new Map(createChildrenEvidence.filter((row) => row.ordinal === '3')
          .map((row) => [row.parent_id, row.revision])),
        new Map([
          [collection.root.id, folderBody.parent.childrenRevision],
          [folderBody.node.id, folderBody.node.childrenRevision],
        ]),
      );
      assert.equal(createChildrenEvidence.filter((row) => row.ordinal === '3').length, 2);

      const invalidPayload = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collection.collection.id}/nodes`,
        headers: headers(harness.client, NODE_INVALID_COMMAND_ID),
        payload: {
          parentId: collection.root.id,
          afterId: null,
          beforeId: null,
          node: { kind: 'bookmark', title: 'unsafe', url: 'javascript:alert(1)', description: null, tags: [], visibility: 'inherit' },
        },
      });
      assert.equal(invalidPayload.statusCode, 422);
      assert.equal((await runtime.pool.query(
        'select count(*)::int count from product_command_receipts where command_id = $1',
        [NODE_INVALID_COMMAND_ID],
      )).rows[0].count, 0);

      const invalidParent = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collection.collection.id}/nodes`,
        headers: headers(harness.client, NODE_INVALID_PARENT_COMMAND_ID),
        payload: {
          parentId: 'missing-parent',
          afterId: null,
          beforeId: null,
          node: { kind: 'folder', title: 'invalid parent', description: null, tags: [], visibility: 'inherit' },
        },
      });
      assert.equal(invalidParent.statusCode, 422);
      assert.equal((await runtime.pool.query(
        'select count(*)::int count from product_command_receipts where command_id = $1',
        [NODE_INVALID_PARENT_COMMAND_ID],
      )).rows[0].count, 0);

      const stored = (await runtime.pool.query('select * from nodes where id = $1', [createdBody.node.id])).rows[0];
      assert.deepEqual(stored.payload_json, {
        schemaVersion: 1,
        resourceType: 'node',
        id: createdBody.node.id,
        collectionId: collection.collection.id,
        parentId: collection.root.id,
        kind: 'bookmark',
        isRoot: false,
        folderRole: null,
        title: createPayload.node.title,
        url: createPayload.node.url,
        description: createPayload.node.description,
        tags: createPayload.node.tags,
        visibility: createPayload.node.visibility,
        position: createdBody.node.position,
        resourceRevision: createdBody.node.revision,
        childrenRevision: stored.children_revision,
        createdAt: stored.created_at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        updatedAt: stored.updated_at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        deletedAt: null,
        deletedCommitOrdinal: null,
        extensions: {},
      });
      assert.equal(stored.title, createPayload.node.title);
      assert.equal(stored.resource_revision, createdBody.node.revision);
      assert.equal(stored.position_token, createdBody.node.position);

      const createEvent = (await runtime.pool.query(
        `select event_type, event_version, handler_name, aggregate_id, aggregate_revision,
          commit_ordinal::text, payload_json from outbox_events where aggregate_id = $1`,
        [createdBody.node.id],
      )).rows[0];
      assert.equal(createEvent.event_type, 'node.created');
      assert.equal(createEvent.event_version, 1);
      assert.equal(createEvent.handler_name, 'node_created_projection');
      assert.equal(createEvent.aggregate_revision, createdBody.node.revision);
      assert.deepEqual(createEvent.payload_json, {
        collectionId: collection.collection.id,
        contentRevision: createdBody.fence.contentRevision,
        kind: 'bookmark',
        nodeId: createdBody.node.id,
        policyRevision: createdBody.fence.policyRevision,
        parentChildrenRevision: createdBody.parent.childrenRevision,
        parentId: collection.root.id,
        resourceRevision: createdBody.node.revision,
      });

      const preservedExtensions = {
        provenance: { source: 'task18-real-pg', generation: 1 },
        labels: ['retained', 'canonical'],
      };
      await runtime.pool.query(
        `update nodes
          set payload_json = jsonb_set(payload_json, '{extensions}', $2::jsonb)
          where id = $1`,
        [createdBody.node.id, JSON.stringify(preservedExtensions)],
      );
      const updatePayload = { title: 'Canonical node updated', visibility: 'private' };
      const updated = await harness.app.inject({
        method: 'PATCH',
        url: `/api/v1/collections/${collection.collection.id}/nodes/${createdBody.node.id}`,
        headers: {
          ...headers(harness.client, NODE_UPDATE_COMMAND_ID, 'application/merge-patch+json'),
          'if-match': createdBody.node.etag,
        },
        payload: updatePayload,
      });
      assert.equal(updated.statusCode, 200);
      const updatedBody = updated.json() as {
        node: { id: string; revision: string; etag: string; title: string; visibility: string };
        fence: { contentRevision: string; policyRevision: string };
      };
      assert.equal(updatedBody.node.title, updatePayload.title);
      assert.equal(updatedBody.node.visibility, updatePayload.visibility);
      assert.equal(updated.headers.etag, updatedBody.node.etag);

      const stale = await harness.app.inject({
        method: 'PATCH',
        url: `/api/v1/collections/${collection.collection.id}/nodes/${createdBody.node.id}`,
        headers: {
          ...headers(harness.client, NODE_STALE_COMMAND_ID, 'application/merge-patch+json'),
          'if-match': createdBody.node.etag,
        },
        payload: { title: 'must not persist' },
      });
      assert.equal(stale.statusCode, 412);
      assert.equal((stale.json() as { error: { code: string } }).error.code, 'precondition_failed');

      const updatedRow = (await runtime.pool.query('select * from nodes where id = $1', [createdBody.node.id])).rows[0];
      assert.equal(updatedRow.title, updatePayload.title);
      assert.equal(updatedRow.visibility, updatePayload.visibility);
      assert.equal(updatedRow.resource_revision, updatedBody.node.revision);
      assert.equal(updatedRow.payload_json.title, updatePayload.title);
      assert.equal(updatedRow.payload_json.visibility, updatePayload.visibility);
      assert.deepEqual(updatedRow.payload_json.extensions, preservedExtensions);
      const nodeEvents = await runtime.pool.query(
        `select event_type, handler_name, aggregate_revision, payload_json
          from outbox_events where aggregate_id = $1 order by commit_ordinal`,
        [createdBody.node.id],
      );
      assert.deepEqual(nodeEvents.rows, [
        {
          event_type: 'node.created',
          handler_name: 'node_created_projection',
          aggregate_revision: createdBody.node.revision,
          payload_json: createEvent.payload_json,
        },
        {
          event_type: 'node.updated',
          handler_name: 'node_updated_projection',
          aggregate_revision: updatedBody.node.revision,
          payload_json: {
            collectionId: collection.collection.id,
            contentRevision: updatedBody.fence.contentRevision,
            kind: 'bookmark',
            nodeId: createdBody.node.id,
            policyRevision: updatedBody.fence.policyRevision,
            resourceRevision: updatedBody.node.revision,
          },
        },
      ]);
      const updateReceipt = (await runtime.pool.query(
        `select target_identity, result_status, result_headers, result_media_type,
          convert_from(result_bytes, 'UTF8') result_body, contract_version,
          completed_at is not null completed from product_command_receipts where command_id = $1`,
        [NODE_UPDATE_COMMAND_ID],
      )).rows[0];
      assert.deepEqual(updateReceipt, {
        target_identity: createdBody.node.id,
        result_status: 200,
        result_headers: {
          etag: updatedBody.node.etag,
          'cache-control': 'private, no-store',
          'content-type': 'application/json',
        },
        result_media_type: 'application/json',
        result_body: updated.body,
        contract_version: '1.0.0',
        completed: true,
      });
    } finally {
      await harness.app.close();
    }
  });

  test('HTTP node PATCH rejects drifted or malformed canonical payload without claiming a receipt', async () => {
    const harness = await buildHarness();
    try {
      const collectionResponse = await postCollection(harness);
      assert.equal(collectionResponse.statusCode, 201);
      const collection = collectionResponse.json() as { collection: { id: string }; root: { id: string } };
      const cases = [
        {
          createCommandId: NODE_DRIFT_CREATE_COMMAND_ID,
          patchCommandId: NODE_DRIFT_PATCH_COMMAND_ID,
          corrupt: (payload: Record<string, unknown>) => ({
            ...payload,
            title: 'payload-only drift',
            extensions: { preserve: 'valid-extension' },
          }),
        },
        {
          createCommandId: NODE_MALFORMED_CREATE_COMMAND_ID,
          patchCommandId: NODE_MALFORMED_PATCH_COMMAND_ID,
          corrupt: (payload: Record<string, unknown>) => {
            const { extensions: _extensions, ...withoutExtensions } = payload;
            return withoutExtensions;
          },
        },
      ] as const;

      for (const [index, testCase] of cases.entries()) {
        const created = await harness.app.inject({
          method: 'POST',
          url: `/api/v1/collections/${collection.collection.id}/nodes`,
          headers: headers(harness.client, testCase.createCommandId),
          payload: {
            parentId: collection.root.id,
            afterId: null,
            beforeId: null,
            node: {
              kind: 'bookmark',
              title: `authority subject ${index}`,
              url: `https://example.test/authority-${index}`,
              description: null,
              tags: [],
              visibility: 'inherit',
            },
          },
        });
        assert.equal(created.statusCode, 201);
        const createdBody = created.json() as { node: { id: string; etag: string } };
        const stored = (await runtime.pool.query(
          'select payload_json from nodes where id = $1',
          [createdBody.node.id],
        )).rows[0] as { payload_json: Record<string, unknown> };
        await runtime.pool.query(
          'update nodes set payload_json = $2::jsonb where id = $1',
          [createdBody.node.id, JSON.stringify(testCase.corrupt(stored.payload_json))],
        );
        const before = await readCanonicalState();
        const failed = await harness.app.inject({
          method: 'PATCH',
          url: `/api/v1/collections/${collection.collection.id}/nodes/${createdBody.node.id}`,
          headers: {
            ...headers(harness.client, testCase.patchCommandId, 'application/merge-patch+json'),
            'if-match': createdBody.node.etag,
          },
          payload: { title: 'must not repair authority' },
        });
        assert.equal(failed.statusCode, 500);
        assert.equal((failed.json() as { error: { code: string } }).error.code, 'internal_error');
        assert.deepEqual(await readCanonicalState(), before);
        assert.equal((await runtime.pool.query(
          'select count(*)::int count from product_command_receipts where command_id = $1',
          [testCase.patchCommandId],
        )).rows[0].count, 0);
      }
    } finally {
      await harness.app.close();
    }
  });

  test('HTTP move and recursive delete share one canonical operation, receipt and projection boundary', async () => {
    const harness = await buildHarness();
    try {
      const createdCollection = await postCollection(harness);
      assert.equal(createdCollection.statusCode, 201);
      const collectionBody = createdCollection.json() as {
        collection: { id: string };
        root: { id: string };
        fence: { contentRevision: string };
      };
      const createNode = async (
        commandId: string,
        parentId: string,
        node: Record<string, unknown>,
      ) => harness.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collectionBody.collection.id}/nodes`,
        headers: headers(harness.client, commandId),
        payload: { parentId, afterId: null, beforeId: null, node },
      });
      const folderAResponse = await createNode(NODE_MOVE_FOLDER_A_COMMAND_ID, collectionBody.root.id, {
        kind: 'folder', title: 'Move source', description: null, tags: [], visibility: 'inherit',
      });
      const folderBResponse = await createNode(NODE_MOVE_FOLDER_B_COMMAND_ID, collectionBody.root.id, {
        kind: 'folder', title: 'Move target', description: null, tags: [], visibility: 'inherit',
      });
      assert.equal(folderAResponse.statusCode, 201);
      assert.equal(folderBResponse.statusCode, 201);
      const folderA = folderAResponse.json() as {
        node: { id: string; etag: string; childrenRevision: string };
      };
      const folderB = folderBResponse.json() as {
        node: { id: string; etag: string; childrenRevision: string };
      };
      const bookmarkResponse = await createNode(NODE_MOVE_BOOKMARK_COMMAND_ID, folderA.node.id, {
        kind: 'bookmark', title: 'Canonical move target', url: 'https://example.test/move',
        description: null, tags: ['move'], visibility: 'inherit',
      });
      assert.equal(bookmarkResponse.statusCode, 201);
      const bookmark = bookmarkResponse.json() as {
        node: { id: string; etag: string };
        parent: { childrenRevision: string };
      };
      const siblingResponse = await createNode(NODE_SAME_PARENT_BOOKMARK_COMMAND_ID, folderA.node.id, {
        kind: 'bookmark', title: 'Same-parent anchor', url: 'https://example.test/anchor',
        description: null, tags: [], visibility: 'inherit',
      });
      assert.equal(siblingResponse.statusCode, 201);
      const sibling = siblingResponse.json() as {
        node: { id: string; etag: string };
        parent: { childrenRevision: string };
      };
      const sameParentMove = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collectionBody.collection.id}/nodes/${sibling.node.id}/move`,
        headers: { ...headers(harness.client, NODE_SAME_PARENT_MOVE_COMMAND_ID), 'if-match': sibling.node.etag },
        payload: {
          newParentId: folderA.node.id,
          afterId: null,
          beforeId: bookmark.node.id,
          baseSourceParentRevision: sibling.parent.childrenRevision,
          baseTargetParentRevision: sibling.parent.childrenRevision,
        },
      });
      assert.equal(sameParentMove.statusCode, 200);
      const sameParentBody = sameParentMove.json() as {
        sourceParent: { childrenRevision: string };
        targetParent: { childrenRevision: string };
      };
      assert.equal(sameParentBody.sourceParent.childrenRevision, sameParentBody.targetParent.childrenRevision);

      const cycle = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collectionBody.collection.id}/nodes/${folderA.node.id}/move`,
        headers: { ...headers(harness.client, NODE_CYCLE_MOVE_COMMAND_ID), 'if-match': folderA.node.etag },
        payload: {
          newParentId: folderA.node.id,
          afterId: null,
          beforeId: null,
          baseSourceParentRevision: (folderBResponse.json() as { parent: { childrenRevision: string } }).parent.childrenRevision,
          baseTargetParentRevision: sameParentBody.targetParent.childrenRevision,
        },
      });
      assert.equal(cycle.statusCode, 422);

      const moveRequest = {
        newParentId: folderB.node.id,
        afterId: null,
        beforeId: null,
        baseSourceParentRevision: sameParentBody.targetParent.childrenRevision,
        baseTargetParentRevision: folderB.node.childrenRevision,
      };
      const bookmarkAuthority = (await runtime.pool.query(
        'select payload_json from nodes where id = $1',
        [bookmark.node.id],
      )).rows[0].payload_json;
      await runtime.pool.query(
        `update nodes set payload_json = jsonb_set(payload_json, '{title}', '"drifted move"'::jsonb) where id = $1`,
        [bookmark.node.id],
      );
      const rejectedMove = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collectionBody.collection.id}/nodes/${bookmark.node.id}/move`,
        headers: { ...headers(harness.client, NODE_MOVE_AUTHORITY_COMMAND_ID), 'if-match': bookmark.node.etag },
        payload: moveRequest,
      });
      assert.equal(rejectedMove.statusCode, 500);
      assert.equal((await runtime.pool.query(
        'select count(*)::int count from product_command_receipts where command_id = $1',
        [NODE_MOVE_AUTHORITY_COMMAND_ID],
      )).rows[0].count, 0);
      await runtime.pool.query('update nodes set payload_json = $2::jsonb where id = $1', [bookmark.node.id, JSON.stringify(bookmarkAuthority)]);
      const moved = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collectionBody.collection.id}/nodes/${bookmark.node.id}/move`,
        headers: { ...headers(harness.client, NODE_MOVE_COMMAND_ID), 'if-match': bookmark.node.etag },
        payload: moveRequest,
      });
      assert.equal(moved.statusCode, 200);
      const movedBody = moved.json() as {
        node: { id: string; parentId: string; revision: string; etag: string };
        sourceParent: { childrenRevision: string };
        targetParent: { childrenRevision: string };
        fence: { contentRevision: string };
      };
      assert.equal(movedBody.node.parentId, folderB.node.id);
      const movedRow = (await runtime.pool.query(
        'select parent_id, resource_revision, payload_json from nodes where id = $1',
        [bookmark.node.id],
      )).rows[0];
      assert.equal(movedRow.parent_id, folderB.node.id);
      assert.equal(movedRow.resource_revision, movedBody.node.revision);
      assert.equal(movedRow.payload_json.parentId, folderB.node.id);
      assert.equal(movedRow.payload_json.resourceRevision, movedBody.node.revision);
      const moveEvidence = await runtime.pool.query(
        `select o.operation_type, e.event_type, e.aggregate_revision, e.payload_json
          from operations o join outbox_events e using (commit_ordinal)
          where o.collection_id = $1 and o.operation_type = 'resource.move' and e.aggregate_id = $2`,
        [collectionBody.collection.id, bookmark.node.id],
      );
      assert.equal(moveEvidence.rowCount, 1);
      assert.equal(moveEvidence.rows[0].event_type, 'node.moved');
      assert.equal(moveEvidence.rows[0].aggregate_revision, movedBody.node.revision);
      assert.equal(moveEvidence.rows[0].payload_json.sourceParentId, folderA.node.id);
      assert.equal(moveEvidence.rows[0].payload_json.targetParentId, folderB.node.id);

      const moveReplay = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collectionBody.collection.id}/nodes/${bookmark.node.id}/move`,
        headers: { ...headers(harness.client, NODE_MOVE_COMMAND_ID), 'if-match': bookmark.node.etag },
        payload: moveRequest,
      });
      assert.equal(moveReplay.statusCode, moved.statusCode);
      assert.equal(moveReplay.body, moved.body);

      const staleMove = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collectionBody.collection.id}/nodes/${bookmark.node.id}/move`,
        headers: { ...headers(harness.client, NODE_STALE_MOVE_COMMAND_ID), 'if-match': bookmark.node.etag },
        payload: moveRequest,
      });
      assert.equal(staleMove.statusCode, 412);

      const nonRecursive = await harness.app.inject({
        method: 'DELETE',
        url: `/api/v1/collections/${collectionBody.collection.id}/nodes/${folderB.node.id}?recursive=false`,
        headers: { ...headers(harness.client, NODE_NONRECURSIVE_DELETE_COMMAND_ID, null), 'if-match': folderB.node.etag },
      });
      assert.equal(nonRecursive.statusCode, 409);

      const movedAuthority = (await runtime.pool.query(
        'select payload_json from nodes where id = $1',
        [bookmark.node.id],
      )).rows[0].payload_json;
      await runtime.pool.query(
        `update nodes set payload_json = jsonb_set(payload_json, '{title}', '"drifted delete"'::jsonb) where id = $1`,
        [bookmark.node.id],
      );
      const rejectedDelete = await harness.app.inject({
        method: 'DELETE',
        url: `/api/v1/collections/${collectionBody.collection.id}/nodes/${folderB.node.id}?recursive=true`,
        headers: {
          ...headers(harness.client, NODE_DELETE_AUTHORITY_COMMAND_ID, null),
          'if-match': folderB.node.etag,
          'if-content-match': `"${movedBody.fence.contentRevision}"`,
        },
      });
      assert.equal(rejectedDelete.statusCode, 500);
      assert.equal((await runtime.pool.query(
        'select count(*)::int count from product_command_receipts where command_id = $1',
        [NODE_DELETE_AUTHORITY_COMMAND_ID],
      )).rows[0].count, 0);
      await runtime.pool.query('update nodes set payload_json = $2::jsonb where id = $1', [bookmark.node.id, JSON.stringify(movedAuthority)]);

      const beforeStaleContentDelete = await readCanonicalState();
      const staleContentDelete = await harness.app.inject({
        method: 'DELETE',
        url: `/api/v1/collections/${collectionBody.collection.id}/nodes/${folderB.node.id}?recursive=true`,
        headers: {
          ...headers(harness.client, NODE_DELETE_STALE_CONTENT_COMMAND_ID, null),
          'if-match': folderB.node.etag,
          'if-content-match': '"stale-content-revision"',
        },
      });
      assert.equal(staleContentDelete.statusCode, 412);
      assert.equal(
        (staleContentDelete.json() as { error: { code: string } }).error.code,
        'precondition_failed',
      );
      assert.deepEqual(await readCanonicalState(), beforeStaleContentDelete);
      assert.equal((await runtime.pool.query(
        'select count(*)::int count from product_command_receipts where command_id = $1',
        [NODE_DELETE_STALE_CONTENT_COMMAND_ID],
      )).rows[0].count, 0);

      const deleted = await harness.app.inject({
        method: 'DELETE',
        url: `/api/v1/collections/${collectionBody.collection.id}/nodes/${folderB.node.id}?recursive=true`,
        headers: {
          ...headers(harness.client, NODE_DELETE_COMMAND_ID, null),
          'if-match': folderB.node.etag,
          'if-content-match': `"${movedBody.fence.contentRevision}"`,
        },
      });
      assert.equal(deleted.statusCode, 200);
      const deletedBody = deleted.json() as {
        receipt: { affectedCount: number; scope: string; deleteRevision: string };
        fence: { contentRevision: string };
      };
      assert.equal(deletedBody.receipt.scope, 'subtree');
      assert.equal(deletedBody.receipt.affectedCount, 2);
      assert.notEqual(deletedBody.receipt.deleteRevision, deletedBody.fence.contentRevision);
      const tombstones = await runtime.pool.query(
        `select id, deleted_at, deleted_commit_ordinal, resource_revision, payload_json
          from nodes where id = any($1::text[]) order by id`,
        [[folderB.node.id, bookmark.node.id]],
      );
      assert.equal(tombstones.rowCount, 2);
      for (const row of tombstones.rows) {
        assert.ok(row.deleted_at);
        assert.ok(row.deleted_commit_ordinal);
        assert.equal(row.payload_json.deletedAt, row.deleted_at.toISOString().replace(/\.\d{3}Z$/, 'Z'));
        assert.equal(row.payload_json.deletedCommitOrdinal, String(row.deleted_commit_ordinal));
        assert.equal(row.payload_json.resourceRevision, row.resource_revision);
      }
      const targetTombstone = tombstones.rows.find((row) => row.id === folderB.node.id);
      assert.ok(targetTombstone, 'expected target tombstone row');
      // deleteRevision is the request target's tombstone revision, not the
      // collection content fence (fence.contentRevision).
      assert.equal(deletedBody.receipt.deleteRevision, targetTombstone.resource_revision);
      const deleteEvidence = await runtime.pool.query(
        `select o.operation_type, op.payload_json operation_payload, e.event_type,
                e.aggregate_id, e.aggregate_revision, e.payload_json event_payload,
                root.children_revision root_children_revision
          from operations o
          join operation_payloads op on op.operation_id = o.operation_id
          join outbox_events e on e.commit_ordinal = o.commit_ordinal
          join nodes root on root.id = $2
          where o.collection_id = $1 and o.operation_type = 'resource.delete'
            and e.event_type = 'node.deleted'`,
        [collectionBody.collection.id, collectionBody.root.id],
      );
      assert.equal(deleteEvidence.rowCount, 1);
      assert.equal(deleteEvidence.rows[0].event_type, 'node.deleted');
      assert.equal(deleteEvidence.rows[0].event_payload.affectedCount, 2);
      assert.equal(deleteEvidence.rows[0].event_payload.scope, 'subtree');
      assert.equal(deleteEvidence.rows[0].aggregate_id, folderB.node.id);
      assert.equal(deleteEvidence.rows[0].aggregate_revision, deletedBody.fence.contentRevision);
      assert.equal(deleteEvidence.rows[0].event_payload.parentId, collectionBody.root.id);
      assert.equal(
        deleteEvidence.rows[0].event_payload.parentChildrenRevision,
        deleteEvidence.rows[0].root_children_revision,
      );
      assert.deepEqual(
        [...deleteEvidence.rows[0].operation_payload.affectedResourceIds].sort(),
        [folderB.node.id, bookmark.node.id].sort(),
      );

      const worker = buildWorker(loadConfig({
        DATABASE_URL: isolated.databaseUrl,
        NODE_ENV: 'test',
        OIDC_ALLOW_TEST_PROVIDER: 'true',
        OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
        LOG_LEVEL: 'silent',
        WORKER_CONCURRENCY: '1',
      }), runtime);
      assert.ok(worker.outbox);
      let drained = false;
      for (let attempt = 0; attempt < 32; attempt += 1) {
        if (!await worker.outbox.runOnce()) {
          drained = true;
          break;
        }
      }
      assert.equal(drained, true, 'production outbox worker did not drain the bounded task fixture');
      assert.ok(worker.projectionSink instanceof PostgresCollectionMutationProjectionSink);
      const projection = worker.projectionSink.repository;
      const [projectedFolder, projectedBookmark, projectedSource, projectedSibling] = await Promise.all([
        projection.getResource(collectionBody.collection.id, 'node', folderB.node.id),
        projection.getResource(collectionBody.collection.id, 'node', bookmark.node.id),
        projection.getResource(collectionBody.collection.id, 'node', folderA.node.id),
        projection.getResource(collectionBody.collection.id, 'node', sibling.node.id),
      ]);
      assert.equal(projectedFolder?.deleted, true);
      assert.equal(projectedBookmark?.deleted, true);
      assert.equal(projectedSource?.deleted, false);
      assert.equal(projectedSibling?.deleted, false);
      assert.equal(projectedFolder?.lastEventType, 'node.deleted');
      assert.equal(projectedBookmark?.lastEventType, 'node.deleted');

      const deleteReplay = await harness.app.inject({
        method: 'DELETE',
        url: `/api/v1/collections/${collectionBody.collection.id}/nodes/${folderB.node.id}?recursive=true`,
        headers: {
          ...headers(harness.client, NODE_DELETE_COMMAND_ID, null),
          'if-match': folderB.node.etag,
          'if-content-match': `"${movedBody.fence.contentRevision}"`,
        },
      });
      assert.equal(deleteReplay.statusCode, deleted.statusCode);
      assert.equal(deleteReplay.body, deleted.body);
    } finally {
      await harness.app.close();
    }
  });

  test('recursive delete planner enforces count/depth boundaries and rejects cycles before writes', async () => {
    const priorNodes = process.env.KNOW_N_MAX_DELETE_SUBTREE_NODES;
    const priorDepth = process.env.KNOW_N_MAX_DELETE_SUBTREE_DEPTH;
    process.env.KNOW_N_MAX_DELETE_SUBTREE_NODES = '4';
    process.env.KNOW_N_MAX_DELETE_SUBTREE_DEPTH = '2';
    const harness = await buildHarness();
    let commandSequence = 300;
    const commandId = () => `00000000-0000-4000-8000-${String(commandSequence++).padStart(12, '0')}`;

    async function createCollection() {
      const response = await postCollection(harness, CREATE_BODY, commandId());
      assert.equal(response.statusCode, 201);
      return response.json() as {
        collection: { id: string; contentRevision: string };
        root: { id: string };
      };
    }

    async function createFolder(collectionId: string, parentId: string) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collectionId}/nodes`,
        headers: headers(harness.client, commandId()),
        payload: {
          parentId,
          afterId: null,
          beforeId: null,
          node: { kind: 'folder', title: `Bounded ${commandSequence}`, description: null, tags: [], visibility: 'inherit' },
        },
      });
      assert.equal(response.statusCode, 201);
      return response.json() as {
        node: { id: string; etag: string };
        fence: { contentRevision: string };
      };
    }

    async function deleteSubtree(
      collectionId: string,
      node: { id: string; etag: string },
      contentRevision: string,
    ) {
      return harness.app.inject({
        method: 'DELETE',
        url: `/api/v1/collections/${collectionId}/nodes/${node.id}?recursive=true`,
        headers: {
          ...headers(harness.client, commandId(), null),
          'if-match': node.etag,
          'if-content-match': `"${contentRevision}"`,
        },
      });
    }

    try {
      const boundary = await createCollection();
      const boundaryTarget = await createFolder(boundary.collection.id, boundary.root.id);
      let boundaryContent = boundaryTarget.fence.contentRevision;
      for (let index = 0; index < 3; index += 1) {
        boundaryContent = (await createFolder(boundary.collection.id, boundaryTarget.node.id)).fence.contentRevision;
      }
      const accepted = await deleteSubtree(boundary.collection.id, boundaryTarget.node, boundaryContent);
      assert.equal(accepted.statusCode, 200);
      assert.equal((accepted.json() as { receipt: { affectedCount: number } }).receipt.affectedCount, 4);

      const depthBoundary = await createCollection();
      const depthBoundaryTarget = await createFolder(depthBoundary.collection.id, depthBoundary.root.id);
      const depthOne = await createFolder(depthBoundary.collection.id, depthBoundaryTarget.node.id);
      const depthTwo = await createFolder(depthBoundary.collection.id, depthOne.node.id);
      const depthAccepted = await deleteSubtree(
        depthBoundary.collection.id,
        depthBoundaryTarget.node,
        depthTwo.fence.contentRevision,
      );
      assert.equal(depthAccepted.statusCode, 200);
      assert.equal((depthAccepted.json() as { receipt: { affectedCount: number } }).receipt.affectedCount, 3);

      const wide = await createCollection();
      const wideTarget = await createFolder(wide.collection.id, wide.root.id);
      let wideContent = wideTarget.fence.contentRevision;
      for (let index = 0; index < 4; index += 1) {
        wideContent = (await createFolder(wide.collection.id, wideTarget.node.id)).fence.contentRevision;
      }
      const wideBefore = await readCanonicalState();
      const wideRejected = await deleteSubtree(wide.collection.id, wideTarget.node, wideContent);
      assert.equal(wideRejected.statusCode, 413);
      assert.equal((wideRejected.json() as { error: { code: string } }).error.code, 'payload_too_large');
      assert.deepEqual(await readCanonicalState(), wideBefore);

      const deep = await createCollection();
      const deepTarget = await createFolder(deep.collection.id, deep.root.id);
      let deepParent = deepTarget.node.id;
      let deepContent = deepTarget.fence.contentRevision;
      for (let index = 0; index < 3; index += 1) {
        const child = await createFolder(deep.collection.id, deepParent);
        deepParent = child.node.id;
        deepContent = child.fence.contentRevision;
      }
      const deepBefore = await readCanonicalState();
      const deepRejected = await deleteSubtree(deep.collection.id, deepTarget.node, deepContent);
      assert.equal(deepRejected.statusCode, 413);
      assert.match((deepRejected.json() as { error: { message: string } }).error.message, /maximum depth of 2/);
      assert.deepEqual(await readCanonicalState(), deepBefore);

      const cyclic = await createCollection();
      const cycleTarget = await createFolder(cyclic.collection.id, cyclic.root.id);
      const cycleChild = await createFolder(cyclic.collection.id, cycleTarget.node.id);
      await runtime.pool.query(
        `update nodes set parent_id = $2,
          payload_json = jsonb_set(payload_json, '{parentId}', to_jsonb($2::text))
          where id = $1`,
        [cycleTarget.node.id, cycleChild.node.id],
      );
      const cycleBefore = await readCanonicalState();
      const cycleRejected = await deleteSubtree(
        cyclic.collection.id,
        cycleTarget.node,
        cycleChild.fence.contentRevision,
      );
      assert.equal(cycleRejected.statusCode, 500);
      assert.deepEqual(await readCanonicalState(), cycleBefore);
    } finally {
      await harness.app.close();
      if (priorNodes === undefined) delete process.env.KNOW_N_MAX_DELETE_SUBTREE_NODES;
      else process.env.KNOW_N_MAX_DELETE_SUBTREE_NODES = priorNodes;
      if (priorDepth === undefined) delete process.env.KNOW_N_MAX_DELETE_SUBTREE_DEPTH;
      else process.env.KNOW_N_MAX_DELETE_SUBTREE_DEPTH = priorDepth;
    }
  });

  test('HTTP move/delete faults roll graph, revisions, evidence and receipts back together', async () => {
    const setup = await buildHarness();
    let collectionId = '';
    let rootId = '';
    let sourceId = '';
    let targetId = '';
    let targetEtag = '';
    let bookmarkId = '';
    let bookmarkEtag = '';
    let sourceChildrenRevision = '';
    let targetChildrenRevision = '';
    try {
      const collectionResponse = await postCollection(setup);
      const collection = collectionResponse.json() as { collection: { id: string }; root: { id: string } };
      collectionId = collection.collection.id;
      rootId = collection.root.id;
      const createNode = async (commandId: string, parentId: string, node: Record<string, unknown>) => setup.app.inject({
        method: 'POST', url: `/api/v1/collections/${collectionId}/nodes`,
        headers: headers(setup.client, commandId), payload: { parentId, afterId: null, beforeId: null, node },
      });
      const sourceResponse = await createNode(NODE_MOVE_FOLDER_A_COMMAND_ID, rootId, {
        kind: 'folder', title: 'Fault source', description: null, tags: [], visibility: 'inherit',
      });
      const targetResponse = await createNode(NODE_MOVE_FOLDER_B_COMMAND_ID, rootId, {
        kind: 'folder', title: 'Fault target', description: null, tags: [], visibility: 'inherit',
      });
      const source = sourceResponse.json() as { node: { id: string }; parent: { childrenRevision: string } };
      const target = targetResponse.json() as { node: { id: string; etag: string; childrenRevision: string } };
      sourceId = source.node.id;
      targetId = target.node.id;
      targetEtag = target.node.etag;
      targetChildrenRevision = target.node.childrenRevision;
      const bookmarkResponse = await createNode(NODE_MOVE_BOOKMARK_COMMAND_ID, sourceId, {
        kind: 'bookmark', title: 'Fault bookmark', url: 'https://example.test/fault',
        description: null, tags: [], visibility: 'inherit',
      });
      const bookmark = bookmarkResponse.json() as { node: { id: string; etag: string }; parent: { childrenRevision: string } };
      bookmarkId = bookmark.node.id;
      bookmarkEtag = bookmark.node.etag;
      sourceChildrenRevision = bookmark.parent.childrenRevision;
    } finally {
      await setup.app.close();
    }

    const before = await readCanonicalState();
    const rollbackFault = { enabled: true };
    const canonicalFault: { phase: CanonicalMutationWritePhase | null } = { phase: null };
    const fault = await buildHarness({ rollbackFault, canonicalFault });
    try {
      const response = await fault.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collectionId}/nodes/${bookmarkId}/move`,
        headers: { ...headers(fault.client, NODE_MOVE_FAULT_COMMAND_ID), 'if-match': bookmarkEtag },
        payload: {
          newParentId: targetId,
          afterId: null,
          beforeId: null,
          baseSourceParentRevision: sourceChildrenRevision,
          baseTargetParentRevision: targetChildrenRevision,
        },
      });
      assert.equal(response.statusCode, 500);
      assert.deepEqual(await readCanonicalState(), before);
      assert.equal((await runtime.pool.query(
        'select count(*)::int count from product_command_receipts where command_id = $1',
        [NODE_MOVE_FAULT_COMMAND_ID],
      )).rows[0].count, 0);
      const row = (await runtime.pool.query('select parent_id from nodes where id = $1', [bookmarkId])).rows[0];
      assert.equal(row.parent_id, sourceId);

      rollbackFault.enabled = false;
      const beforeMove = await readCanonicalState();
      for (const phase of ['resource', 'revision', 'operation', 'audit', 'outbox'] as const) {
        canonicalFault.phase = phase;
        const phaseFailure = await fault.app.inject({
          method: 'POST',
          url: `/api/v1/collections/${collectionId}/nodes/${bookmarkId}/move`,
          headers: { ...headers(fault.client, NODE_MOVE_FAULT_COMMAND_ID), 'if-match': bookmarkEtag },
          payload: {
            newParentId: targetId,
            afterId: null,
            beforeId: null,
            baseSourceParentRevision: sourceChildrenRevision,
            baseTargetParentRevision: targetChildrenRevision,
          },
        });
        assert.equal(phaseFailure.statusCode, 500, `expected ${phase} move fault to reach the handler`);
        assert.deepEqual(await readCanonicalState(), beforeMove, `${phase} move fault must roll back every table`);
        assert.equal((await runtime.pool.query(
          'select count(*)::int count from product_command_receipts where command_id = $1',
          [NODE_MOVE_FAULT_COMMAND_ID],
        )).rows[0].count, 0);
      }
      canonicalFault.phase = null;
      const committedMove = await fault.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collectionId}/nodes/${bookmarkId}/move`,
        headers: { ...headers(fault.client, NODE_MOVE_FAULT_COMMAND_ID), 'if-match': bookmarkEtag },
        payload: {
          newParentId: targetId,
          afterId: null,
          beforeId: null,
          baseSourceParentRevision: sourceChildrenRevision,
          baseTargetParentRevision: targetChildrenRevision,
        },
      });
      assert.equal(committedMove.statusCode, 200);
      const committedMoveBody = committedMove.json() as { fence: { contentRevision: string } };
      const beforeDelete = await readCanonicalState();

      for (const phase of ['resource', 'revision', 'operation', 'audit', 'outbox'] as const) {
        canonicalFault.phase = phase;
        const phaseFailure = await fault.app.inject({
          method: 'DELETE',
          url: `/api/v1/collections/${collectionId}/nodes/${targetId}?recursive=true`,
          headers: {
            ...headers(fault.client, NODE_DELETE_COMMAND_ID, null),
            'if-match': targetEtag,
            'if-content-match': `"${committedMoveBody.fence.contentRevision}"`,
          },
        });
        assert.equal(phaseFailure.statusCode, 500, `expected ${phase} fault to reach the handler`);
        assert.deepEqual(await readCanonicalState(), beforeDelete, `${phase} fault must roll back every table`);
        assert.equal((await runtime.pool.query(
          'select count(*)::int count from product_command_receipts where command_id = $1',
          [NODE_DELETE_COMMAND_ID],
        )).rows[0].count, 0);
      }

      canonicalFault.phase = null;
      rollbackFault.enabled = true;
      const failedDelete = await fault.app.inject({
        method: 'DELETE',
        url: `/api/v1/collections/${collectionId}/nodes/${targetId}?recursive=true`,
        headers: {
          ...headers(fault.client, NODE_DELETE_COMMAND_ID, null),
          'if-match': targetEtag,
          'if-content-match': `"${committedMoveBody.fence.contentRevision}"`,
        },
      });
      assert.equal(failedDelete.statusCode, 500);
      assert.deepEqual(await readCanonicalState(), beforeDelete);
      const liveRows = await runtime.pool.query(
        'select id, deleted_at from nodes where id = any($1::text[]) order by id',
        [[targetId, bookmarkId]],
      );
      assert.equal(liveRows.rowCount, 2);
      assert.ok(liveRows.rows.every((liveRow) => liveRow.deleted_at === null));
    } finally {
      await fault.app.close();
    }
  });

  test('HTTP node create/update faults preserve the committed graph and receipt boundary', async () => {
    const rollbackFault = { enabled: false };
    const harness = await buildHarness({ rollbackFault });
    try {
      const collectionResponse = await postCollection(harness);
      const collection = collectionResponse.json() as { collection: { id: string }; root: { id: string } };
      const before = await readCanonicalState();
      rollbackFault.enabled = true;
      const failed = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collection.collection.id}/nodes`,
        headers: headers(harness.client, NODE_ROLLBACK_COMMAND_ID),
        payload: {
          parentId: collection.root.id,
          afterId: null,
          beforeId: null,
          node: { kind: 'folder', title: 'rollback', description: null, tags: [], visibility: 'inherit' },
        },
      });
      assert.equal(failed.statusCode, 500);
      assert.deepEqual(await readCanonicalState(), before);

      rollbackFault.enabled = false;
      const created = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/collections/${collection.collection.id}/nodes`,
        headers: headers(harness.client, NODE_CREATE_COMMAND_ID),
        payload: {
          parentId: collection.root.id,
          afterId: null,
          beforeId: null,
          node: {
            kind: 'bookmark',
            title: 'update rollback subject',
            url: 'https://example.test/rollback-subject',
            description: null,
            tags: [],
            visibility: 'inherit',
          },
        },
      });
      assert.equal(created.statusCode, 201);
      const createdBody = created.json() as { node: { id: string; etag: string } };
      const beforeUpdate = await readCanonicalState();

      rollbackFault.enabled = true;
      const failedUpdate = await harness.app.inject({
        method: 'PATCH',
        url: `/api/v1/collections/${collection.collection.id}/nodes/${createdBody.node.id}`,
        headers: {
          ...headers(harness.client, NODE_ROLLBACK_COMMAND_ID, 'application/merge-patch+json'),
          'if-match': createdBody.node.etag,
        },
        payload: { title: 'must roll back', visibility: 'private' },
      });
      assert.equal(failedUpdate.statusCode, 500);
      assert.equal((failedUpdate.json() as { error: { code: string } }).error.code, 'internal_error');
      const afterUpdate = await readCanonicalState();
      assert.deepEqual(afterUpdate, beforeUpdate);
      assert.equal(
        afterUpdate.product_command_receipts.some((row) => row.command_id === NODE_ROLLBACK_COMMAND_ID),
        false,
      );
    } finally {
      await harness.app.close();
    }
  });
});
