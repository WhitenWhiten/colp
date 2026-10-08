import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runMigrations } from '../../src/infrastructure/database/index.js';
import { createPostgresSyncSessionIssuer } from '../../src/infrastructure/sync/index.js';
import { createPostgresReplicaStore } from '../../src/infrastructure/sync/index.js';
import type { VerifiedExtensionCredential } from '../../src/modules/identity/index.js';
import type { ReplicaRecord } from '../../src/modules/sync/index.js';
import { mintVerifiedExtensionCredentialFixture } from './extension-credential.js';
import {
  createIsolatedPostgresRuntime,
  type IsolatedPostgresRuntime,
} from './postgres-test-runtime.js';

export const ISSUER = 'https://issuer.example';
export const AUDIENCE = 'known-api';
export const CLIENT_ID = 'known-extension';
export const REPLAY_KEY = Buffer.alloc(32, 7);
export const capabilities = {
  read: true, write: true, events: true, separator: false, alias: false,
  annotations: 'sidecar' as const, maxBatchOperations: 1,
};

export type SessionAccount = 'owner' | 'editor' | 'viewer' | 'outsider';

export interface SyncSessionPostgresHarness {
  readonly isolated: IsolatedPostgresRuntime;
  evidence(account: SessionAccount): VerifiedExtensionCredential;
  replaceCredential(account: SessionAccount, credential: VerifiedExtensionCredential): void;
  createReplica(account: SessionAccount, collection?: string): Promise<ReplicaRecord>;
  issuer(overrides?: Record<string, unknown>): ReturnType<typeof createPostgresSyncSessionIssuer>;
  command(
    account: SessionAccount,
    replica: ReplicaRecord,
    overrides?: Record<string, unknown>,
  ): Record<string, unknown>;
  close(): Promise<void>;
}

export async function bootSyncSessionPostgres(
  prefix = 'p3_sync_session',
): Promise<SyncSessionPostgresHarness> {
  const isolated = await createIsolatedPostgresRuntime(prefix, { maxConnections: 12 });
  await runMigrations(isolated.runtime.db, 'latest');
  const credentialEvidence = new Map<string, VerifiedExtensionCredential>();
  let replicaCounter = 0;

  async function seedPrincipal(
    account: string,
    subject: string,
    oidcSubject: string,
    collection: string,
    role: 'owner' | 'editor' | 'viewer',
  ) {
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query('insert into accounts(id,subject_id,status) values ($1,$2,\'active\')', [account, subject]);
      await client.query(
        'insert into account_identities(id,account_id,issuer,subject) values ($1,$2,$3,$4)',
        [`identity-${account}`, account, ISSUER, oidcSubject],
      );
      await client.query('insert into profile_handles(handle,account_id) values ($1,$2)',
        [`sync_${account}`, account]);
      if (role === 'owner') {
        await client.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node') on conflict do nothing", [collection, `root-${collection}`]);
        await client.query(`insert into collections
          (id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision)
          values ($1,$2,'Sync','bookmarks',$3,'r1','c1','p1') on conflict do nothing`,
        [collection, subject, `root-${collection}`]);
        await client.query(`insert into nodes
          (id,collection_id,kind,is_root,title,resource_revision,children_revision)
          values ($1,$2,'folder',true,'Root','r1','ch1') on conflict do nothing`,
        [`root-${collection}`, collection]);
      } else {
        await client.query(
          'insert into collection_members(collection_id,subject_id,role) values ($1,$2,$3)',
          [collection, subject, role],
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

  await seedPrincipal('owner', 'owner-subject', 'owner-oidc', 'collection-owner', 'owner');
  await seedPrincipal('editor', 'editor-subject', 'editor-oidc', 'collection-owner', 'editor');
  await seedPrincipal('viewer', 'viewer-subject', 'viewer-oidc', 'collection-owner', 'viewer');
  await seedPrincipal('outsider', 'outsider-subject', 'outsider-oidc', 'collection-other', 'owner');
  for (const account of ['owner', 'editor', 'viewer', 'outsider'] as const) {
    credentialEvidence.set(account, await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID,
      subject: `${account}-oidc`, credentialId: `credential-${account}`,
    }));
  }

  return {
    isolated,
    evidence(account) {
      const value = credentialEvidence.get(account);
      assert.ok(value);
      return value;
    },
    replaceCredential(account, credential) {
      credentialEvidence.set(account, credential);
    },
    async createReplica(account, collection = 'collection-owner') {
      const n = ++replicaCounter;
      const store = createPostgresReplicaStore(isolated.runtime.db, { ids: {
        deviceId: () => `device-session-${n}`, replicaId: () => `replica-session-${n}`,
        leaseId: () => `lease-session-${n}`,
      } });
      return store.create({
        accountId: account, collectionId: collection, deviceName: 'Laptop', replicaName: 'Chrome',
        kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
        capabilities, binding: { browserProfileId: `profile-${n}`, mountMode: 'mounted-folder',
          browserGeneration: `installation-${n}` }, leaseDurationSeconds: 3_600,
      }, { actorAccountId: account });
    },
    issuer(overrides = {}) {
      return createPostgresSyncSessionIssuer(isolated.runtime.db, {
        issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID,
        replayEncryptionKey: REPLAY_KEY, sessionDurationSeconds: 900,
        replicaLeaseExtensionSeconds: 3_600, tombstoneRetentionSeconds: 86_400,
        maxBatchOperations: 1,
        replayEncryptionKeyVersion: 7,
        endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
        ...overrides,
      });
    },
    command(account, replica, overrides = {}) {
      const value = credentialEvidence.get(account);
      assert.ok(value);
      return {
        credential: value, idempotencyKey: `idem-${randomUUID()}`,
        requestFingerprint: `fingerprint-${randomUUID()}`, collectionId: replica.collectionId,
        replicaId: replica.replicaId, expectedLeaseGeneration: replica.leaseGeneration,
        expectedLifecycleRevision: replica.lifecycleRevision,
        binding: replica.binding, requestedScopes: ['sync:bootstrap', 'sync:pull', 'sync:push'],
        origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', ...overrides,
      };
    },
    close() {
      return isolated.close();
    },
  };
}
