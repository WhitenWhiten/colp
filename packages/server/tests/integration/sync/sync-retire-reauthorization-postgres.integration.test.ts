import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import { createPostgresReplicaRetirementApplication } from '../../../src/infrastructure/sync/index.js';
import { SyncSessionIssueError, validateSyncSessionIssueInput } from '../../../src/modules/sync/index.js';
import { registerSyncRetireRoutes } from '../../../src/transport/colp-sync/sync-retire-routes.js';
import { mintExtensionCredentialHttpFixture } from '../../support/extension-credential.js';
import { isFetchForbiddenPort } from '../../support/fetch-port.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { AUDIENCE, CLIENT_ID, ISSUER, bootSyncSessionPostgres,
  type SyncSessionPostgresHarness } from '../../support/sync-session-postgres.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const PATH = '/v1/retire';
type HttpCredential = Awaited<ReturnType<typeof mintExtensionCredentialHttpFixture>>;

describeWithPostgres('retirement v2 current account and installation proof over real HTTP/PG', () => {
  let h: SyncSessionPostgresHarness;
  const apps: FastifyInstance[] = [];
  beforeAll(async () => { h = await bootSyncSessionPostgres('retire_reauthorization'); }, 60_000);
  afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
  afterAll(async () => h?.close());

  async function credential(subject = 'owner-oidc', overrides: Partial<{ issuer: string; audience: string; clientId: string }> = {}) {
    return mintExtensionCredentialHttpFixture({ issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID,
      subject, credentialId: `retire-${randomUUID()}`, evidenceTtlSeconds: 600, ...overrides });
  }
  async function target(account: 'owner' | 'editor' = 'owner', sessionDurationSeconds = 900) {
    const old = await credential(`${account}-oidc`); const replica = await h.createReplica(account);
    const issued = await h.issuer({ sessionDurationSeconds }).issue(validateSyncSessionIssueInput(
      h.command(account, replica, { credential: old.credential })));
    return { old, replica, sessionId: issued.envelope.sessionId, key: `reset-${randomUUID()}` };
  }
  async function server(credentials: readonly HttpCredential[], loseResponse = false): Promise<{ app: FastifyInstance; url: string }> {
    const app = Fastify({ logger: false }); apps.push(app);
    registerSyncRetireRoutes(app, { path: PATH, allowedOrigins: [ORIGIN], allowInsecureLoopback: true,
      rateLimit: { maxRequests: 100, windowMs: 60_000 },
      credentialVerifier: { async verify(input) {
        const token = credentials.find(item => item.authorization === input.authorization);
        if (!token) throw new Error('authentication_required');
        // Real signature/issuer/audience/client/expiry verification, never a
        // header-to-principal cast. DB revocation is checked in the transaction.
        return token.verifier.verify(input);
      } }, application: createPostgresReplicaRetirementApplication(h.isolated.runtime.db) });
    if (loseResponse) app.addHook('onSend', async (request, reply, payload) => {
      if (reply.statusCode === 204) request.raw.socket.destroy(); return payload;
    });
    await app.listen({ host: '127.0.0.1', port: 0 }); const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    if (!isFetchForbiddenPort(address.port)) return { app, url: `http://127.0.0.1:${address.port}${PATH}` };
    await app.close(); return server(credentials, loseResponse);
  }
  function send(url: string, t: Awaited<ReturnType<typeof target>>, token: HttpCredential,
    proof: string | null = t.sessionId, origin = ORIGIN) {
    return fetch(url, { method: 'DELETE', headers: { Authorization: token.authorization, Origin: origin,
      'Known-Sync-Session': t.sessionId, 'Idempotency-Key': t.key,
      ...(proof === null ? {} : { 'Known-Sync-Replica-Proof': proof }) } });
  }
  async function facts(t: Awaited<ReturnType<typeof target>>) {
    const db = h.isolated.runtime.pool;
    return {
      replica: (await db.query('select status,lifecycle_revision,retired_at from sync_replicas where replica_id=$1', [t.replica.replicaId])).rows,
      sessions: (await db.query('select session_id,status,terminated_at from sync_sessions where replica_id=$1 order by session_id', [t.replica.replicaId])).rows,
      receipts: (await db.query('select * from sync_replica_retirement_receipts where replica_id=$1 order by idempotency_key', [t.replica.replicaId])).rows,
      claims: (await db.query('select * from sync_sequence_operation_claims where replica_id=$1 order by sequence_number', [t.replica.replicaId])).rows,
      effects: (await db.query('select count(*)::int as count from sync_sequence_receipts where replica_id=$1', [t.replica.replicaId])).rows,
    };
  }

  test('an expired Session and revoked original credential can be explicitly reset by the current same account', async () => {
    const t = await target('owner', 1), next = await credential(); const app = await server([t.old, next]);
    // Authority rows are immutable. Let a genuinely short issued Session expire
    // instead of rewriting its dates or disabling the production trigger.
    await h.isolated.runtime.pool.query('select pg_sleep(1.05)');
    await h.isolated.runtime.pool.query('update sync_extension_credentials set revoked_at=current_timestamp where credential_id=$1', [t.old.credential.credentialId]);
    const expired = await h.isolated.runtime.pool.query('select expires_at <= current_timestamp as expired from sync_sessions where session_id=$1', [t.sessionId]);
    assert.equal(expired.rows[0]?.expired, true);
    const before = await facts(t);
    assert.equal((await send(app.url, t, next, null)).status, 404);
    assert.equal((await send(app.url, t, t.old, null)).status, 404);
    assert.deepEqual(await facts(t), before);
    assert.equal((await send(app.url, t, next)).status, 204);
    const after = await facts(t); assert.equal(after.replica[0]?.status, 'retired');
    assert.equal(after.receipts.length, 1); assert.equal(after.sessions.length, 1);
    assert.equal(after.sessions[0]?.status, 'terminated');
    assert.deepEqual(after.claims, before.claims); assert.deepEqual(after.effects, before.effects);
    await assert.rejects(h.issuer().issue(validateSyncSessionIssueInput(h.command('owner', t.replica,
      { credential: next.credential }))), (error: unknown) => error instanceof SyncSessionIssueError && error.code === 'replica_retired');
    assert.deepEqual(await facts(t), after);
  });

  test('lost original retirement response replays after server restart and a new verified credential', async () => {
    const t = await target(); const first = await server([t.old], true);
    await assert.rejects(send(first.url, t, t.old, null));
    const committed = await facts(t); assert.equal(committed.replica[0]?.status, 'retired');
    assert.equal(committed.receipts.length, 1); await first.app.close();
    const next = await credential(); const restarted = await server([next]);
    assert.equal((await send(restarted.url, t, next, null)).status, 404);
    assert.equal((await send(restarted.url, t, next)).status, 204);
    assert.equal((await send(restarted.url, t, next)).status, 204);
    assert.deepEqual(await facts(t), committed);
    const changedKey = { ...t, key: `other-${randomUUID()}` };
    assert.equal((await send(restarted.url, changedKey, next)).status, 410);
    assert.deepEqual(await facts(t), committed);
  });

  test('reauthorization uses current membership after a policy change; the strict call remains stale', async () => {
    const t = await target('editor'), next = await credential('editor-oidc'); const app = await server([t.old, next]);
    const oldPolicy = (await h.isolated.runtime.pool.query('select policy_revision from collections where id=$1', [t.replica.collectionId])).rows[0]!.policy_revision;
    try {
      await h.isolated.runtime.pool.query('update collections set policy_revision=$2 where id=$1', [t.replica.collectionId, `p-${randomUUID()}`]);
      const before = await facts(t);
      assert.equal((await send(app.url, t, t.old, null)).status, 404);
      assert.deepEqual(await facts(t), before);
      assert.equal((await send(app.url, t, next)).status, 204);
    } finally { await h.isolated.runtime.pool.query('update collections set policy_revision=$2 where id=$1', [t.replica.collectionId, oldPolicy]); }
  });

  for (const corruption of ['other-account', 'wrong-proof', 'missing-proof', 'wrong-origin', 'wrong-client', 'wrong-issuer',
    'wrong-audience', 'revoked-credential', 'removed-membership', 'account-epoch', 'proof-device', 'proof-profile', 'proof-generation'] as const) {
    test(`denies ${corruption} before any retirement, receipt, sequence or session side effect`, async () => {
      const t = await target(corruption === 'removed-membership' ? 'editor' : 'owner');
      const owner = corruption === 'removed-membership' ? 'editor-oidc' : 'owner-oidc';
      const next = await credential(corruption === 'other-account' ? 'outsider-oidc' : owner,
        corruption === 'wrong-client' ? { clientId: 'foreign-client' } : corruption === 'wrong-issuer'
          ? { issuer: 'https://foreign-issuer.example' } : corruption === 'wrong-audience' ? { audience: 'foreign-audience' } : {});
      const app = await server([next]); const db = h.isolated.runtime.pool;
      const undo: (() => Promise<unknown>)[] = [];
      try {
        if (corruption === 'missing-proof') await db.query('delete from sync_replica_report_authorities where replica_id=$1', [t.replica.replicaId]);
        if (corruption.startsWith('proof-')) {
          const column = corruption === 'proof-device' ? 'device_id' : corruption === 'proof-profile' ? 'browser_profile_id' : 'browser_generation';
          await db.query(`update sync_replica_report_authorities set ${column}=$2 where replica_id=$1`, [t.replica.replicaId, 'foreign-installation']);
        }
        if (corruption === 'revoked-credential') {
          const second = await h.createReplica('owner');
          await h.issuer().issue(validateSyncSessionIssueInput(h.command('owner', second, { credential: next.credential })));
          await db.query('update sync_extension_credentials set revoked_at=current_timestamp where credential_id=$1', [next.credential.credentialId]);
        }
        if (corruption === 'removed-membership') {
          await db.query("delete from collection_members where collection_id=$1 and subject_id='editor-subject'", [t.replica.collectionId]);
          undo.push(() => db.query("insert into collection_members(collection_id,subject_id,role) values ($1,'editor-subject','editor')", [t.replica.collectionId]));
        }
        if (corruption === 'account-epoch') {
          await db.query("update accounts set security_epoch=security_epoch+1,security_epoch_bumped_at=current_timestamp where id='owner'");
          undo.push(() => db.query("update accounts set security_epoch=security_epoch-1,security_epoch_bumped_at=null where id='owner'"));
        }
        const before = await facts(t);
        const result = await send(app.url, t, next, corruption === 'wrong-proof' ? 'different-session' : t.sessionId,
          corruption === 'wrong-origin' ? 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' : ORIGIN);
        assert.equal(result.status, corruption === 'wrong-proof' ? 400 : corruption === 'wrong-origin' ? 403 : 404);
        assert.deepEqual(await facts(t), before);
      } finally { for (const restore of undo.reverse()) await restore(); }
    });
  }

  test('a completed receipt cannot bypass later credential revocation or an epoch change', async () => {
    const t = await target(); const app = await server([t.old]);
    assert.equal((await send(app.url, t, t.old)).status, 204); const before = await facts(t);
    await h.isolated.runtime.pool.query('update sync_extension_credentials set revoked_at=current_timestamp where credential_id=$1', [t.old.credential.credentialId]);
    assert.equal((await send(app.url, t, t.old)).status, 404); assert.deepEqual(await facts(t), before);
    const next = await credential(); const retry = await server([next]);
    await h.isolated.runtime.pool.query("update accounts set security_epoch=security_epoch+1,security_epoch_bumped_at=current_timestamp where id='owner'");
    try {
      assert.equal((await send(retry.url, t, next)).status, 404); assert.deepEqual(await facts(t), before);
    } finally { await h.isolated.runtime.pool.query("update accounts set security_epoch=security_epoch-1,security_epoch_bumped_at=null where id='owner'"); }
  });
});
