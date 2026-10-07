import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createUnitOfWork,
  runMigrations,
} from '../../../src/infrastructure/database/index.js';
import { createPostgresOwnedCollectionsReadPort } from '../../../src/infrastructure/collections/index.js';
import {
  createPostgresAccountRepository,
  createPostgresExtensionOwnerSubjectPort,
  createPostgresIdentityUnitOfWork,
} from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresReplicaStore,
  createPostgresSyncSessionIssuer,
  isJoseSyncCredentialRevoked,
  SyncSessionIssueError,
  type JoseSyncCredentialRevocationQuery,
} from '../../../src/infrastructure/sync/index.js';
import {
  createProductOwnedCollectionsCursorSigner,
  materializeCollectionPayload,
  materializeNodePayload,
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
} from '../../../src/modules/collections/index.js';
import {
  createExtensionCredentialEvidenceVerifier,
  ExtensionAuthError,
  type ExtensionAuthConfig,
  type VerifiedExtensionCredential,
} from '../../../src/modules/identity/index.js';
import type {
  BookmarkFaviconObjectStore,
  CollectionsUnitOfWork,
  CollectionsWritePorts,
} from '../../../src/modules/collections/index.js';
import {
  EXTENSION_COLLECTIONS_PATH,
  registerExtensionCollectionRoutes,
} from '../../../src/transport/colp-sync/extension-collection-routes.js';
import {
  EXTENSION_FAVICON_POLICY_PATH,
  registerSyncFaviconHelperRoutes,
} from '../../../src/transport/colp-sync/sync-favicon-helper-routes.js';
import { mintExtensionCredentialHttpFixture } from '../../support/extension-credential.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ISSUER = 'https://issuer.example';
const AUDIENCE = 'known-api';
const CLIENT_ID = 'known-extension';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

function authConfig(): ExtensionAuthConfig {
  return {
    flow: 'authorization_code_pkce',
    issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID,
    authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`,
    jwksUri: `${ISSUER}/jwks`,
    redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/oauth2',
    allowedExtensionIds: ['abcdefghijklmnopabcdefghijklmnop'],
    allowedRedirectOrigins: ['https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org'],
    scopes: ['known.sync'], allowedAlgorithms: ['RS256'], clockSkewSeconds: 0,
    evidenceTtlSeconds: 3_600,
  };
}

function issuerOptions() {
  return {
    issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID,
    replayEncryptionKey: Buffer.alloc(32, 23), replayEncryptionKeyVersion: 1,
    sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
    tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
    endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'] as const,
  };
}

function revocationQuery(
  minted: { readonly credential: VerifiedExtensionCredential },
): JoseSyncCredentialRevocationQuery {
  return {
    issuer: ISSUER,
    subject: minted.credential.subject,
    tokenId: minted.credential.credentialId,
    tokenDigest: minted.credential.credentialDigest,
    issuedAtSeconds: Math.floor(minted.credential.credentialIssuedAt.getTime() / 1_000),
    clockSkewSeconds: 0,
  };
}

describeWithPostgres('JOSE sync credential skew and unmapped-identity revocation', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('jose_cred_epoch_skew');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => { await isolated?.close(); });

  async function readEpochStamp(accountId: string): Promise<Date> {
    const row = await isolated.runtime.pool.query(
      'select security_epoch_bumped_at from accounts where id = $1',
      [accountId],
    );
    const bumpedAt = row.rows[0]?.security_epoch_bumped_at;
    assert.ok(bumpedAt instanceof Date);
    return bumpedAt;
  }

  async function bumpAccountEpoch(accountId: string): Promise<Date> {
    await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      createPostgresAccountRepository(transaction).bumpSecurityEpoch(accountId));
    return readEpochStamp(accountId);
  }

  /** Password change/reset increments security_epoch in SQL, not via bumpSecurityEpoch. */
  async function bumpAccountEpochBySql(accountId: string): Promise<Date> {
    await isolated.runtime.pool.query(
      'update accounts set security_epoch = security_epoch + 1 where id = $1',
      [accountId],
    );
    return readEpochStamp(accountId);
  }

  async function seedOwner(input: {
    readonly account: string;
    readonly subject: string;
    readonly oidc: string;
    readonly identity: string;
    readonly handle: string;
    readonly collection: string;
    readonly root: string;
  }): Promise<{
    readonly replica: Awaited<ReturnType<ReturnType<typeof createPostgresReplicaStore>['create']>>;
  }> {
    const now = new Date('2026-08-20T06:00:00Z');
    const collection = materializeCollectionPayload({
      id: input.collection, ownerSubjectId: input.subject, title: 'NV01 library', summary: null,
      kind: 'bookmarks', visibility: 'private', rootNodeId: input.root,
      resourceRevision: 'collection-r1', contentRevision: 'content-r1', policyRevision: 'policy-r1',
      commitOrdinal: 0n, createdAt: now, updatedAt: now, deletedAt: null,
    });
    const root = materializeNodePayload({
      id: input.root, collectionId: input.collection, parentId: null, kind: 'folder', isRoot: true,
      title: 'Root', url: null, description: null, tags: [], visibility: 'inherit', positionToken: null,
      resourceRevision: 'root-r1', childrenRevision: 'children-r1', createdAt: now, updatedAt: now,
      deletedAt: null, deletedCommitOrdinal: null,
    });
    assert.equal(collection.ok && root.ok, true);
    await isolated.runtime.pool.query(
      "insert into accounts(id,subject_id,status,security_epoch) values ($1,$2,'active',0)",
      [input.account, input.subject],
    );
    await isolated.runtime.pool.query(
      "insert into profiles(account_id, display_name, avatar_url) values ($1,'NV01 owner',null)",
      [input.account],
    );
    await isolated.runtime.pool.query(
      'insert into profile_handles(handle,account_id) values ($1,$2)',
      [input.handle, input.account],
    );
    await isolated.runtime.pool.query(
      'insert into account_identities(id,account_id,issuer,subject) values ($1,$2,$3,$4)',
      [input.identity, input.account, ISSUER, input.oidc],
    );
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('set constraints all deferred');
      await client.query(
        "insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node')",
        [input.collection, input.root],
      );
      await client.query(
        `insert into collections
          (id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,
           policy_revision,commit_ordinal,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
          values ($1,$2,'NV01 library','bookmarks','private',$3,'collection-r1','content-r1','policy-r1',0,$4,$4,$5,$6,'backfilled')`,
        [input.collection, input.subject, input.root, now,
          collection.ok ? collection.payload : {}, RESOURCE_PAYLOAD_SCHEMA_VERSION],
      );
      await client.query(
        `insert into nodes
          (id,collection_id,parent_id,kind,is_root,title,url,visibility,position_token,resource_revision,
           children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
          values ($1,$2,null,'folder',true,'Root',null,'inherit',null,'root-r1','children-r1',$3,$3,$4,$5,'backfilled')`,
        [input.root, input.collection, now, root.ok ? root.payload : {}, RESOURCE_PAYLOAD_SCHEMA_VERSION],
      );
      await client.query('commit');
    } catch (error) {
      try { await client.query('rollback'); } catch { /* already failed */ }
      throw error;
    } finally {
      client.release();
    }
    const replica = await createPostgresReplicaStore(isolated.runtime.db, {
      ids: {
        deviceId: () => `${input.handle}-device`,
        replicaId: () => `${input.handle}-replica`,
        leaseId: () => `${input.handle}-lease`,
      },
    }).create({
      accountId: input.account, collectionId: input.collection, deviceName: 'NV01 device',
      replicaName: 'NV01 replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: {
        read: true, write: true, events: true, separator: true, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1,
      },
      binding: {
        browserProfileId: `${input.handle}-profile`, mountMode: 'whole-profile',
        browserGeneration: 'generation-1',
      },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: input.account });
    return { replica };
  }

  async function collectionsApp(input: {
    readonly minted: Awaited<ReturnType<typeof mintExtensionCredentialHttpFixture>>;
    readonly now?: () => Date;
  }): Promise<{
    readonly app: FastifyInstance;
    readonly verifier: ReturnType<typeof createExtensionCredentialEvidenceVerifier>;
  }> {
    const verifier = createExtensionCredentialEvidenceVerifier({
      config: authConfig(),
      jwks: { async getKeySet() { return { keys: [input.minted.jwk] }; } },
      requiredScopes: ['known.sync'],
      isRevoked: (query) => isJoseSyncCredentialRevoked(isolated.runtime.db, query),
      ...(input.now ? { now: input.now } : {}),
    });
    const app = Fastify({ logger: false });
    registerExtensionCollectionRoutes(app, {
      credentialVerifier: verifier,
      allowedOrigins: [ORIGIN],
      ownerSubject: createPostgresExtensionOwnerSubjectPort(isolated.runtime.db),
      ownedCollectionsQuery: {
        reads: createPostgresOwnedCollectionsReadPort(isolated.runtime.db),
        cursors: createProductOwnedCollectionsCursorSigner({
          current: { id: 'nv01-owned-v1', key: 'nv01-owned-cursor-secret-material-32b' },
        }),
        clock: { now: async () => input.now?.() ?? new Date() },
      },
    });
    await app.ready();
    return { app, verifier };
  }

  test('never-bound revocation ignores JWT skew and matches first-bind', async () => {
    const account = 'nv01skewacct000000000A';
    const subject = 'nv01skew-subject';
    const oidc = 'nv01skew-oidc';
    const { replica } = await seedOwner({
      account, subject, oidc, identity: 'nv01skew-identity', handle: 'nv01skew_owner',
      collection: 'nv01skewcol0000000000A', root: 'nv01skewroot000000000A',
    });
    await isolated.runtime.pool.query(
      'update accounts set security_epoch = security_epoch + 1 where id = $1',
      [account],
    );
    const bumpedAt = await readEpochStamp(account);
    const floor = Math.floor(bumpedAt.getTime() / 1_000);
    const atSecond = (second: number) => new Date(second * 1_000);
    // The fixture signs iat as floor(now) - 1. Keep verifiedAt near the database clock.
    const verifyNow = atSecond(floor + 20);
    const pre = await mintExtensionCredentialHttpFixture({
      issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID, subject: oidc,
      credentialId: 'nv01skew-pre', evidenceTtlSeconds: 3_600, now: atSecond(floor - 9),
    });
    const same = await mintExtensionCredentialHttpFixture({
      issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID, subject: oidc,
      credentialId: 'nv01skew-same', evidenceTtlSeconds: 3_600, now: atSecond(floor + 1),
    });
    const post = await mintExtensionCredentialHttpFixture({
      issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID, subject: oidc,
      credentialId: 'nv01skew-post', evidenceTtlSeconds: 3_600, now: atSecond(floor + 6),
    });
    const withinSkew = await mintExtensionCredentialHttpFixture({
      issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID, subject: oidc,
      credentialId: 'nv01skew-within', evidenceTtlSeconds: 3_600, now: atSecond(floor + 31),
    });
    const outsideSkew = await mintExtensionCredentialHttpFixture({
      issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID, subject: oidc,
      credentialId: 'nv01skew-outside', evidenceTtlSeconds: 3_600, now: atSecond(floor + 141),
    });
    assert.equal(Math.floor(pre.credential.credentialIssuedAt.getTime() / 1_000), floor - 10);
    assert.equal(Math.floor(same.credential.credentialIssuedAt.getTime() / 1_000), floor);
    assert.equal(Math.floor(post.credential.credentialIssuedAt.getTime() / 1_000), floor + 5);
    const skewed = (minted: { credential: VerifiedExtensionCredential }): JoseSyncCredentialRevocationQuery => ({
      issuer: ISSUER, subject: oidc, tokenId: minted.credential.credentialId,
      tokenDigest: minted.credential.credentialDigest,
      issuedAtSeconds: Math.floor(minted.credential.credentialIssuedAt.getTime() / 1_000),
      clockSkewSeconds: 30,
    });
    assert.equal(await isJoseSyncCredentialRevoked(isolated.runtime.db, skewed(pre)), true);
    assert.equal(await isJoseSyncCredentialRevoked(isolated.runtime.db, { ...skewed(pre), clockSkewSeconds: 0 }), true);
    assert.equal(await isJoseSyncCredentialRevoked(isolated.runtime.db, skewed(same)), false);
    assert.equal(await isJoseSyncCredentialRevoked(isolated.runtime.db, skewed(post)), false);

    const keys = [pre.jwk, same.jwk, post.jwk, withinSkew.jwk, outsideSkew.jwk];
    const verifier = createExtensionCredentialEvidenceVerifier({
      config: { ...authConfig(), clockSkewSeconds: 30 },
      jwks: { async getKeySet() { return { keys }; } },
      requiredScopes: ['known.sync'],
      isRevoked: (query) => isJoseSyncCredentialRevoked(isolated.runtime.db, query),
      now: () => verifyNow,
    });
    let creates = 0;
    const faviconStore: BookmarkFaviconObjectStore = {
      async put() {}, async get() { return null; }, async delete() {},
    };
    const collectionsUnitOfWork: CollectionsUnitOfWork = {
      async execute(work) {
        return work({
          faviconPolicies: { async findByAccountId() { return null; } },
          faviconSources: {}, bookmarkIcons: {}, faviconGc: {}, faviconRestores: {},
        } as unknown as CollectionsWritePorts);
      },
    };
    const app = Fastify({ logger: false });
    registerExtensionCollectionRoutes(app, {
      credentialVerifier: verifier,
      allowedOrigins: [ORIGIN],
      ownerSubject: createPostgresExtensionOwnerSubjectPort(isolated.runtime.db),
      ownerAccount: { async resolveActiveAccount() { return { accountId: account, subjectId: subject }; } },
      collectionMutation: {
        async execute() {
          creates += 1;
          return {
            kind: 'created' as const,
            collection: {
              id: 'nv01skew-created', title: 'Notes', kind: 'bookmarks' as const,
              visibility: 'private' as const, rootNodeId: 'nv01skew-created-root',
            },
          };
        },
      },
      ownedCollectionsQuery: {
        reads: createPostgresOwnedCollectionsReadPort(isolated.runtime.db),
        cursors: createProductOwnedCollectionsCursorSigner({
          current: { id: 'nv01-owned-v1', key: 'nv01-owned-cursor-secret-material-32b' },
        }),
        clock: { now: async () => verifyNow },
      },
    });
    registerSyncFaviconHelperRoutes(app, {
      enabled: true, productOrigin: 'https://known.example', timeoutMs: 2_000, faviconStore,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      collectionsUnitOfWork,
      extensionCollectionRoutes: {
        credentialVerifier: verifier, allowedOrigins: [ORIGIN],
        ownerSubject: createPostgresExtensionOwnerSubjectPort(isolated.runtime.db),
        ownedCollectionsQuery: {
          reads: createPostgresOwnedCollectionsReadPort(isolated.runtime.db),
          cursors: createProductOwnedCollectionsCursorSigner({
            current: { id: 'nv01-owned-v1', key: 'nv01-owned-cursor-secret-material-32b' },
          }),
          clock: { now: async () => verifyNow },
        },
      },
    });
    await app.ready();
    const headers = (authorization: string) => ({ authorization, origin: ORIGIN });
    try {
      const listed = await app.inject({ method: 'GET', url: EXTENSION_COLLECTIONS_PATH, headers: headers(pre.authorization) });
      assert.equal(listed.statusCode, 401, listed.body);
      assert.equal(listed.json().error.code, 'invalid_token');
      const created = await app.inject({
        method: 'POST', url: EXTENSION_COLLECTIONS_PATH, headers: {
          ...headers(pre.authorization), 'content-type': 'application/json', 'idempotency-key': 'nv01skew-pre-create',
        }, payload: { title: 'Notes' },
      });
      assert.equal(created.statusCode, 401, created.body);
      assert.equal(created.json().error.code, 'invalid_token');
      assert.equal(creates, 0);
      const helped = await app.inject({ method: 'GET', url: EXTENSION_FAVICON_POLICY_PATH, headers: headers(pre.authorization) });
      assert.equal(helped.statusCode, 401, helped.body);
      assert.match(helped.body, /Authentication is required/);
      await assert.rejects(
        () => verifier.verify({ authorization: pre.authorization }),
        (error: unknown) => error instanceof ExtensionAuthError && error.reason === 'revoked',
      );
      await assert.rejects(
        () => createPostgresSyncSessionIssuer(isolated.runtime.db, issuerOptions()).issue({
          credential: pre.credential, idempotencyKey: 'nv01skew-pre-session',
          requestFingerprint: 'nv01skew-pre-fingerprint',
          collectionId: replica.collectionId, replicaId: replica.replicaId,
          expectedLeaseGeneration: replica.leaseGeneration,
          expectedLifecycleRevision: replica.lifecycleRevision,
          binding: replica.binding, requestedScopes: ['sync:pull', 'sync:push'], origin: ORIGIN,
        }),
        (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'credential_invalid',
      );

      for (const minted of [same, post]) {
        const okList = await app.inject({ method: 'GET', url: EXTENSION_COLLECTIONS_PATH, headers: headers(minted.authorization) });
        assert.equal(okList.statusCode, 200, okList.body);
        const okCreate = await app.inject({
          method: 'POST', url: EXTENSION_COLLECTIONS_PATH, headers: {
            ...headers(minted.authorization), 'content-type': 'application/json',
            'idempotency-key': `nv01skew-${minted.credential.credentialId}`,
          }, payload: { title: 'Notes' },
        });
        assert.equal(okCreate.statusCode, 201, okCreate.body);
        const okHelp = await app.inject({ method: 'GET', url: EXTENSION_FAVICON_POLICY_PATH, headers: headers(minted.authorization) });
        assert.equal(okHelp.statusCode, 200, okHelp.body);
        assert.equal((await verifier.verify({ authorization: minted.authorization })).credentialId, minted.credential.credentialId);
      }
      assert.equal(creates, 2);
      const issued = await createPostgresSyncSessionIssuer(isolated.runtime.db, issuerOptions()).issue({
        credential: post.credential, idempotencyKey: 'nv01skew-post-session',
        requestFingerprint: 'nv01skew-post-fingerprint',
        collectionId: replica.collectionId, replicaId: replica.replicaId,
        expectedLeaseGeneration: replica.leaseGeneration,
        expectedLifecycleRevision: replica.lifecycleRevision,
        binding: replica.binding, requestedScopes: ['sync:pull', 'sync:push'], origin: ORIGIN,
      });
      assert.equal(issued.state, 'issued');
      const boundQuery = skewed(post);
      assert.equal(await isJoseSyncCredentialRevoked(isolated.runtime.db, {
        ...boundQuery, issuedAtSeconds: floor - 10, clockSkewSeconds: 30,
      }), false, 'a bound credential uses epoch equality, not iat skew');
      await isolated.runtime.pool.query(
        'update accounts set security_epoch = security_epoch + 1 where id = $1',
        [account],
      );
      assert.equal(await isJoseSyncCredentialRevoked(isolated.runtime.db, boundQuery), true);

      assert.equal((await verifier.verify({ authorization: withinSkew.authorization })).credentialId, 'nv01skew-within');
      await assert.rejects(
        () => verifier.verify({ authorization: outsideSkew.authorization }),
        (error: unknown) => error instanceof ExtensionAuthError && error.reason === 'invalid_token',
      );
    } finally {
      await app.close();
    }
  }, 60_000);

  test('a never-bound token with no identity mapping is revoked until the identity exists', async () => {
    const account = 'nv01unmapacct00000000A';
    const subject = 'nv01unmap-subject';
    const oidc = 'nv01unmap-oidc';
    const identity = 'nv01unmap-identity';
    const { replica } = await seedOwner({
      account, subject, oidc, identity, handle: 'nv01unmap_owner',
      collection: 'nv01unmapcol000000000A', root: 'nv01unmaproot00000000A',
    });
    const minted = await mintExtensionCredentialHttpFixture({
      issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID, subject: oidc,
      credentialId: 'nv01unmap-credential', evidenceTtlSeconds: 3_600,
    });
    await isolated.runtime.pool.query('delete from account_identities where id = $1', [identity]);
    const query: JoseSyncCredentialRevocationQuery = {
      ...revocationQuery(minted), clockSkewSeconds: 30,
    };
    assert.equal(await isJoseSyncCredentialRevoked(isolated.runtime.db, query), true);
    const verifier = createExtensionCredentialEvidenceVerifier({
      config: { ...authConfig(), clockSkewSeconds: 30 },
      jwks: { async getKeySet() { return { keys: [minted.jwk] }; } },
      requiredScopes: ['known.sync'],
      isRevoked: (input) => isJoseSyncCredentialRevoked(isolated.runtime.db, input),
      now: () => minted.credential.verifiedAt,
    });
    const app = Fastify({ logger: false });
    const faviconStore: BookmarkFaviconObjectStore = {
      async put() {}, async get() { return null; }, async delete() {},
    };
    registerExtensionCollectionRoutes(app, {
      credentialVerifier: verifier, allowedOrigins: [ORIGIN],
      ownerSubject: createPostgresExtensionOwnerSubjectPort(isolated.runtime.db),
      ownedCollectionsQuery: {
        reads: createPostgresOwnedCollectionsReadPort(isolated.runtime.db),
        cursors: createProductOwnedCollectionsCursorSigner({
          current: { id: 'nv01-owned-v1', key: 'nv01-owned-cursor-secret-material-32b' },
        }),
        clock: { now: async () => minted.credential.verifiedAt },
      },
    });
    registerSyncFaviconHelperRoutes(app, {
      enabled: true, productOrigin: 'https://known.example', timeoutMs: 2_000, faviconStore,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      collectionsUnitOfWork: {
        async execute(work) {
          return work({
            faviconPolicies: { async findByAccountId() { return null; } },
            faviconSources: {}, bookmarkIcons: {}, faviconGc: {}, faviconRestores: {},
          } as unknown as CollectionsWritePorts);
        },
      },
      extensionCollectionRoutes: {
        credentialVerifier: verifier, allowedOrigins: [ORIGIN],
        ownerSubject: createPostgresExtensionOwnerSubjectPort(isolated.runtime.db),
        ownedCollectionsQuery: {
          reads: createPostgresOwnedCollectionsReadPort(isolated.runtime.db),
          cursors: createProductOwnedCollectionsCursorSigner({
            current: { id: 'nv01-owned-v1', key: 'nv01-owned-cursor-secret-material-32b' },
          }),
          clock: { now: async () => minted.credential.verifiedAt },
        },
      },
    });
    await app.ready();
    const headers = { authorization: minted.authorization, origin: ORIGIN };
    try {
      await assert.rejects(
        () => verifier.verify({ authorization: minted.authorization }),
        (error: unknown) => error instanceof ExtensionAuthError && error.reason === 'revoked',
      );
      const listed = await app.inject({ method: 'GET', url: EXTENSION_COLLECTIONS_PATH, headers });
      assert.equal(listed.statusCode, 401, listed.body);
      assert.equal(listed.json().error.code, 'invalid_token');
      const helped = await app.inject({ method: 'GET', url: EXTENSION_FAVICON_POLICY_PATH, headers });
      assert.equal(helped.statusCode, 401, helped.body);
      assert.match(helped.body, /Authentication is required/);
      await assert.rejects(
        () => createPostgresSyncSessionIssuer(isolated.runtime.db, issuerOptions()).issue({
          credential: minted.credential, idempotencyKey: 'nv01unmap-session',
          requestFingerprint: 'nv01unmap-fingerprint',
          collectionId: replica.collectionId, replicaId: replica.replicaId,
          expectedLeaseGeneration: replica.leaseGeneration,
          expectedLifecycleRevision: replica.lifecycleRevision,
          binding: replica.binding, requestedScopes: ['sync:pull', 'sync:push'], origin: ORIGIN,
        }),
        (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'credential_invalid',
      );

      await isolated.runtime.pool.query(
        'insert into account_identities(id, account_id, issuer, subject) values ($1, $2, $3, $4)',
        [identity, account, ISSUER, oidc],
      );
      assert.equal(await isJoseSyncCredentialRevoked(isolated.runtime.db, query), false);
      const restored = await app.inject({ method: 'GET', url: EXTENSION_COLLECTIONS_PATH, headers });
      assert.equal(restored.statusCode, 200, restored.body);
      const helpedAgain = await app.inject({ method: 'GET', url: EXTENSION_FAVICON_POLICY_PATH, headers });
      assert.equal(helpedAgain.statusCode, 200, helpedAgain.body);
      const issued = await createPostgresSyncSessionIssuer(isolated.runtime.db, issuerOptions()).issue({
        credential: minted.credential, idempotencyKey: 'nv01unmap-session',
        requestFingerprint: 'nv01unmap-fingerprint',
        collectionId: replica.collectionId, replicaId: replica.replicaId,
        expectedLeaseGeneration: replica.leaseGeneration,
        expectedLifecycleRevision: replica.lifecycleRevision,
        binding: replica.binding, requestedScopes: ['sync:pull', 'sync:push'], origin: ORIGIN,
      });
      assert.equal(issued.state, 'issued');
    } finally {
      await app.close();
    }
  }, 60_000);
});
