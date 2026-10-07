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
} from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresReplicaStore,
  createPostgresSyncSessionIssuer,
  isJoseSyncCredentialRevoked,
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
import {
  EXTENSION_COLLECTIONS_PATH,
  registerExtensionCollectionRoutes,
} from '../../../src/transport/colp-sync/extension-collection-routes.js';
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

describeWithPostgres('JOSE sync credential revocation follows the account security epoch', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('jose_cred_epoch');
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

  test('an epoch bump revokes a bound compact JWS on collection list', async () => {
    const minted = await mintExtensionCredentialHttpFixture({
      issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID,
      subject: 'nv01-oidc', credentialId: 'nv01-credential', evidenceTtlSeconds: 3_600,
    });
    const { replica } = await seedOwner({
      account: 'nv01acct0000000000000A', subject: 'nv01-subject', oidc: 'nv01-oidc',
      identity: 'nv01-identity', handle: 'nv01_owner',
      collection: 'nv01col00000000000000A', root: 'nv01root0000000000000A',
    });
    const issued = await createPostgresSyncSessionIssuer(isolated.runtime.db, issuerOptions()).issue({
      credential: minted.credential, idempotencyKey: 'nv01-session',
      requestFingerprint: 'nv01-session-fingerprint',
      collectionId: replica.collectionId, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:pull', 'sync:push'], origin: ORIGIN,
    });
    assert.equal(issued.state, 'issued');
    const sessionId = issued.state === 'issued' ? issued.envelope.sessionId : '';
    const { app } = await collectionsApp({ minted });
    try {
      const before = await app.inject({
        method: 'GET', url: EXTENSION_COLLECTIONS_PATH,
        headers: { authorization: minted.authorization },
      });
      assert.equal(before.statusCode, 200);
      assert.equal(before.json().items[0]?.id, replica.collectionId);

      await bumpAccountEpoch('nv01acct0000000000000A');
      const cred = await isolated.runtime.pool.query(
        'select security_epoch, revoked_at from sync_extension_credentials where credential_id = $1',
        ['nv01-credential'],
      );
      assert.equal(String(cred.rows[0]?.security_epoch), '0');
      assert.equal(cred.rows[0]?.revoked_at, null);
      assert.equal(await isJoseSyncCredentialRevoked(isolated.runtime.db, revocationQuery(minted)), true);

      const after = await app.inject({
        method: 'GET', url: EXTENSION_COLLECTIONS_PATH,
        headers: { authorization: minted.authorization },
      });
      assert.equal(after.statusCode, 401, `collections after epoch bump: ${after.body}`);

      await assert.rejects(createPostgresSyncSessionIssuer(isolated.runtime.db, issuerOptions()).verify({
        credential: minted.credential, sessionId, collectionId: replica.collectionId,
        replicaId: replica.replicaId,
      }));
    } finally {
      await app.close();
    }
  }, 60_000);

  test('a never-bound pre-event compact JWS cannot list collections or first-bind after an epoch bump', async () => {
    const minted = await mintExtensionCredentialHttpFixture({
      issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID,
      subject: 'nv01pre-oidc', credentialId: 'nv01pre-credential', evidenceTtlSeconds: 3_600,
    });
    const { replica } = await seedOwner({
      account: 'nv01preacct0000000000A', subject: 'nv01pre-subject', oidc: 'nv01pre-oidc',
      identity: 'nv01pre-identity', handle: 'nv01pre_owner',
      collection: 'nv01precol00000000000A', root: 'nv01preroot0000000000A',
    });
    assert.equal(await isJoseSyncCredentialRevoked(isolated.runtime.db, revocationQuery(minted)), false);

    const { app, verifier } = await collectionsApp({ minted });
    try {
      const before = await app.inject({
        method: 'GET', url: EXTENSION_COLLECTIONS_PATH,
        headers: { authorization: minted.authorization },
      });
      assert.equal(before.statusCode, 200, before.body);

      await bumpAccountEpoch('nv01preacct0000000000A');
      assert.equal(await isJoseSyncCredentialRevoked(isolated.runtime.db, revocationQuery(minted)), true);

      const after = await app.inject({
        method: 'GET', url: EXTENSION_COLLECTIONS_PATH,
        headers: { authorization: minted.authorization },
      });
      assert.equal(after.statusCode, 401, `never-bound collections after bump: ${after.body}`);
      await assert.rejects(
        () => verifier.verify({ authorization: minted.authorization }),
        (error: unknown) => error instanceof ExtensionAuthError && error.reason === 'revoked',
      );
      await assert.rejects(createPostgresSyncSessionIssuer(isolated.runtime.db, issuerOptions()).issue({
        credential: minted.credential, idempotencyKey: 'nv01pre-session',
        requestFingerprint: 'nv01pre-session-fingerprint',
        collectionId: replica.collectionId, replicaId: replica.replicaId,
        expectedLeaseGeneration: replica.leaseGeneration,
        expectedLifecycleRevision: replica.lifecycleRevision,
        binding: replica.binding, requestedScopes: ['sync:pull', 'sync:push'], origin: ORIGIN,
      }));
      const bound = await isolated.runtime.pool.query(
        'select credential_id from sync_extension_credentials where credential_id = $1',
        ['nv01pre-credential'],
      );
      assert.equal(bound.rowCount, 0);
    } finally {
      await app.close();
    }
  }, 60_000);

  test('a never-bound post-event compact JWS can still first-bind after an epoch bump', async () => {
    const { replica } = await seedOwner({
      account: 'nv01postacct000000000A', subject: 'nv01post-subject', oidc: 'nv01post-oidc',
      identity: 'nv01post-identity', handle: 'nv01post_owner',
      collection: 'nv01postcol0000000000A', root: 'nv01postroot000000000A',
    });
    const bumpedAt = await bumpAccountEpoch('nv01postacct000000000A');
    const verifyNow = new Date(bumpedAt.getTime() + 3_000);
    const minted = await mintExtensionCredentialHttpFixture({
      issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID,
      subject: 'nv01post-oidc', credentialId: 'nv01post-credential',
      evidenceTtlSeconds: 3_600, now: verifyNow,
    });
    assert.ok(minted.credential.credentialIssuedAt.getTime() > bumpedAt.getTime());
    assert.equal(await isJoseSyncCredentialRevoked(isolated.runtime.db, revocationQuery(minted)), false);

    const { app, verifier } = await collectionsApp({ minted, now: () => verifyNow });
    try {
      const listed = await app.inject({
        method: 'GET', url: EXTENSION_COLLECTIONS_PATH,
        headers: { authorization: minted.authorization },
      });
      assert.equal(listed.statusCode, 200, listed.body);
      assert.equal(listed.json().items[0]?.id, replica.collectionId);

      const verified = await verifier.verify({ authorization: minted.authorization });
      const issued = await createPostgresSyncSessionIssuer(isolated.runtime.db, issuerOptions()).issue({
        credential: verified, idempotencyKey: 'nv01post-session',
        requestFingerprint: 'nv01post-session-fingerprint',
        collectionId: replica.collectionId, replicaId: replica.replicaId,
        expectedLeaseGeneration: replica.leaseGeneration,
        expectedLifecycleRevision: replica.lifecycleRevision,
        binding: replica.binding, requestedScopes: ['sync:pull', 'sync:push'], origin: ORIGIN,
      });
      assert.equal(issued.state, 'issued');
      const bound = await isolated.runtime.pool.query(
        'select security_epoch from sync_extension_credentials where credential_id = $1',
        ['nv01post-credential'],
      );
      assert.equal(String(bound.rows[0]?.security_epoch), '1');
    } finally {
      await app.close();
    }
  }, 60_000);

  test('a SQL security_epoch increment stamps bumped_at and revokes a never-bound pre-event JWS', async () => {
    const minted = await mintExtensionCredentialHttpFixture({
      issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID,
      subject: 'nv01sql-oidc', credentialId: 'nv01sql-credential', evidenceTtlSeconds: 3_600,
    });
    const { replica } = await seedOwner({
      account: 'nv01sqlacct0000000000A', subject: 'nv01sql-subject', oidc: 'nv01sql-oidc',
      identity: 'nv01sql-identity', handle: 'nv01sql_owner',
      collection: 'nv01sqlcol00000000000A', root: 'nv01sqlroot0000000000A',
    });
    const { app, verifier } = await collectionsApp({ minted });
    try {
      await bumpAccountEpochBySql('nv01sqlacct0000000000A');
      assert.equal(await isJoseSyncCredentialRevoked(isolated.runtime.db, revocationQuery(minted)), true);
      const after = await app.inject({
        method: 'GET', url: EXTENSION_COLLECTIONS_PATH,
        headers: { authorization: minted.authorization },
      });
      assert.equal(after.statusCode, 401, `SQL-bump collections: ${after.body}`);
      await assert.rejects(
        () => verifier.verify({ authorization: minted.authorization }),
        (error: unknown) => error instanceof ExtensionAuthError && error.reason === 'revoked',
      );
      await assert.rejects(createPostgresSyncSessionIssuer(isolated.runtime.db, issuerOptions()).issue({
        credential: minted.credential, idempotencyKey: 'nv01sql-session',
        requestFingerprint: 'nv01sql-session-fingerprint',
        collectionId: replica.collectionId, replicaId: replica.replicaId,
        expectedLeaseGeneration: replica.leaseGeneration,
        expectedLifecycleRevision: replica.lifecycleRevision,
        binding: replica.binding, requestedScopes: ['sync:pull', 'sync:push'], origin: ORIGIN,
      }));
    } finally {
      await app.close();
    }
  }, 60_000);

  test('a SQL security_epoch increment still first-binds a never-bound post-event JWS', async () => {
    const { replica } = await seedOwner({
      account: 'nv01sql2acct000000000A', subject: 'nv01sql2-subject', oidc: 'nv01sql2-oidc',
      identity: 'nv01sql2-identity', handle: 'nv01sql2_owner',
      collection: 'nv01sql2col0000000000A', root: 'nv01sql2root000000000A',
    });
    const bumpedAt = await bumpAccountEpochBySql('nv01sql2acct000000000A');
    const verifyNow = new Date(bumpedAt.getTime() + 3_000);
    const minted = await mintExtensionCredentialHttpFixture({
      issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID,
      subject: 'nv01sql2-oidc', credentialId: 'nv01sql2-credential',
      evidenceTtlSeconds: 3_600, now: verifyNow,
    });
    assert.ok(minted.credential.credentialIssuedAt.getTime() > bumpedAt.getTime());
    assert.equal(await isJoseSyncCredentialRevoked(isolated.runtime.db, revocationQuery(minted)), false);
    const issued = await createPostgresSyncSessionIssuer(isolated.runtime.db, issuerOptions()).issue({
      credential: minted.credential, idempotencyKey: 'nv01sql2-session',
      requestFingerprint: 'nv01sql2-session-fingerprint',
      collectionId: replica.collectionId, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:pull', 'sync:push'], origin: ORIGIN,
    });
    assert.equal(issued.state, 'issued');
  }, 60_000);

  test('a never-bound compact JWS on an inactive account is revoked', async () => {
    const minted = await mintExtensionCredentialHttpFixture({
      issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID,
      subject: 'nv01ina-oidc', credentialId: 'nv01ina-credential', evidenceTtlSeconds: 3_600,
    });
    const { replica } = await seedOwner({
      account: 'nv01inaacct0000000000A', subject: 'nv01ina-subject', oidc: 'nv01ina-oidc',
      identity: 'nv01ina-identity', handle: 'nv01ina_owner',
      collection: 'nv01inacol00000000000A', root: 'nv01inaroot0000000000A',
    });
    await isolated.runtime.pool.query(
      "update accounts set status = 'disabled' where id = $1",
      ['nv01inaacct0000000000A'],
    );
    assert.equal(await isJoseSyncCredentialRevoked(isolated.runtime.db, revocationQuery(minted)), true);
    const { app, verifier } = await collectionsApp({ minted });
    try {
      const listed = await app.inject({
        method: 'GET', url: EXTENSION_COLLECTIONS_PATH,
        headers: { authorization: minted.authorization },
      });
      assert.equal(listed.statusCode, 401, listed.body);
      await assert.rejects(
        () => verifier.verify({ authorization: minted.authorization }),
        (error: unknown) => error instanceof ExtensionAuthError && error.reason === 'revoked',
      );
      await assert.rejects(createPostgresSyncSessionIssuer(isolated.runtime.db, issuerOptions()).issue({
        credential: minted.credential, idempotencyKey: 'nv01ina-session',
        requestFingerprint: 'nv01ina-session-fingerprint',
        collectionId: replica.collectionId, replicaId: replica.replicaId,
        expectedLeaseGeneration: replica.leaseGeneration,
        expectedLifecycleRevision: replica.lifecycleRevision,
        binding: replica.binding, requestedScopes: ['sync:pull', 'sync:push'], origin: ORIGIN,
      }));
    } finally {
      await app.close();
    }
  }, 60_000);

  test('epoch > 0 with a missing bump stamp fails closed for a never-bound JWS', async () => {
    const { replica } = await seedOwner({
      account: 'nv01nstacct0000000000A', subject: 'nv01nst-subject', oidc: 'nv01nst-oidc',
      identity: 'nv01nst-identity', handle: 'nv01nst_owner',
      collection: 'nv01nstcol00000000000A', root: 'nv01nstroot0000000000A',
    });
    await bumpAccountEpoch('nv01nstacct0000000000A');
    await isolated.runtime.pool.query(
      'update accounts set security_epoch_bumped_at = null where id = $1',
      ['nv01nstacct0000000000A'],
    );
    const minted = await mintExtensionCredentialHttpFixture({
      issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID,
      subject: 'nv01nst-oidc', credentialId: 'nv01nst-credential', evidenceTtlSeconds: 3_600,
    });
    assert.equal(await isJoseSyncCredentialRevoked(isolated.runtime.db, revocationQuery(minted)), true);
    await assert.rejects(createPostgresSyncSessionIssuer(isolated.runtime.db, issuerOptions()).issue({
      credential: minted.credential, idempotencyKey: 'nv01nst-session',
      requestFingerprint: 'nv01nst-session-fingerprint',
      collectionId: replica.collectionId, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:pull', 'sync:push'], origin: ORIGIN,
    }));
  }, 60_000);

  test('a never-bumped epoch-0 account can still first-bind a never-bound compact JWS', async () => {
    const minted = await mintExtensionCredentialHttpFixture({
      issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID,
      subject: 'nv01new-oidc', credentialId: 'nv01new-credential', evidenceTtlSeconds: 3_600,
    });
    const { replica } = await seedOwner({
      account: 'nv01newacct0000000000A', subject: 'nv01new-subject', oidc: 'nv01new-oidc',
      identity: 'nv01new-identity', handle: 'nv01new_owner',
      collection: 'nv01newcol00000000000A', root: 'nv01newroot0000000000A',
    });
    const stamp = await isolated.runtime.pool.query(
      'select security_epoch, security_epoch_bumped_at from accounts where id = $1',
      ['nv01newacct0000000000A'],
    );
    assert.equal(String(stamp.rows[0]?.security_epoch), '0');
    assert.equal(stamp.rows[0]?.security_epoch_bumped_at, null);
    assert.equal(await isJoseSyncCredentialRevoked(isolated.runtime.db, revocationQuery(minted)), false);
    const issued = await createPostgresSyncSessionIssuer(isolated.runtime.db, issuerOptions()).issue({
      credential: minted.credential, idempotencyKey: 'nv01new-session',
      requestFingerprint: 'nv01new-session-fingerprint',
      collectionId: replica.collectionId, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:pull', 'sync:push'], origin: ORIGIN,
    });
    assert.equal(issued.state, 'issued');
    const bound = await isolated.runtime.pool.query(
      'select security_epoch from sync_extension_credentials where credential_id = $1',
      ['nv01new-credential'],
    );
    assert.equal(String(bound.rows[0]?.security_epoch), '0');
  }, 60_000);
});
