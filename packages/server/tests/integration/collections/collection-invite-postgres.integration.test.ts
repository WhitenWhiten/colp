import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  acceptInvite,
  authorizeCapability,
  CollaborationError,
  inviteMember,
  inviteMemberCommandScope,
  removeMember,
  updateMemberRole,
  type CollaborationActor,
  type CollaborationCommandPorts,
} from '../../../src/modules/access-policy/index.js';
import { createPostgresCollaborationCommandPorts } from '../../../src/infrastructure/collaboration/index.js';
import { createUnitOfWork, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const OWNER_ACCOUNT = 'acct-owner-sc01';
const OWNER_SUBJECT = 'subject-owner-sc01';
const OWNER_EMAIL = 'owner-sc01@example.test';
const OWNER_AUTH = 'auth-owner-sc01';
const INVITEE_ACCOUNT = 'acct-invitee-sc01';
const INVITEE_SUBJECT = 'subject-invitee-sc01';
const INVITEE_EMAIL = 'invitee-sc01@example.test';
const INVITEE_AUTH = 'auth-invitee-sc01';
const VIEWER_ACCOUNT = 'acct-viewer-sc01';
const VIEWER_SUBJECT = 'subject-viewer-sc01';
const VIEWER_EMAIL = 'viewer-sc01@example.test';
const VIEWER_AUTH = 'auth-viewer-sc01';
const UNVERIFIED_ACCOUNT = 'acct-unverified-sc01';
const UNVERIFIED_SUBJECT = 'subject-unverified-sc01';
const UNVERIFIED_EMAIL = 'unverified-sc01@example.test';
const UNVERIFIED_AUTH = 'auth-unverified-sc01';
const UNKNOWN_EMAIL = 'unknown-sc01@example.test';
const COLLECTION_ID = 'col-sc01-private';
const ROOT_ID = 'root-sc01-private';
const CONTENT_REVISION = 'content-sc01-1';
const POLICY_REVISION = 'policy-sc01-1';

const COMMAND_INVITE_UNKNOWN = '5de3947e-6271-4fdf-a946-d22e58a99c2a';
const COMMAND_INVITE_VERIFIED = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const COMMAND_ACCEPT = '11111111-2222-4333-8444-555555555555';
const COMMAND_ROLE = '22222222-3333-4444-8555-666666666666';
const COMMAND_REMOVE = '33333333-4444-4555-8666-777777777777';
const COMMAND_VIEWER_INVITE = '44444444-5555-4666-8777-888888888888';
const COMMAND_VIEWER_ACCEPT = '55555555-6666-4777-8888-999999999999';
const COMMAND_RACE_INVITE = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const COMMAND_RACE_A = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const COMMAND_RACE_B = '88888888-9999-4aaa-8bbb-cccccccccccc';

describeWithPostgres('collection invite postgres persistence', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('sc01_invite_pg', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedFixtures(isolated);
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('unknown and verified emails both insert pending rows on real PostgreSQL', async () => {
    const unknown = await run(isolated, (ports) => inviteMember(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_INVITE_UNKNOWN, fingerprint: 'u'.repeat(64) },
      collectionId: COLLECTION_ID,
      email: UNKNOWN_EMAIL,
      role: 'editor',
      inviteId: 'invite-unknown-pg',
    }));
    const verified = await run(isolated, (ports) => inviteMember(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_INVITE_VERIFIED, fingerprint: 'v'.repeat(64) },
      collectionId: COLLECTION_ID,
      email: INVITEE_EMAIL,
      role: 'editor',
      inviteId: 'invite-verified-pg',
    }));
    assert.equal(unknown.kind, 'invited');
    assert.equal(verified.kind, 'invited');
    assert.equal(Object.hasOwn(unknown, 'accountFound'), false);
    assert.equal(Object.hasOwn(verified, 'accountFound'), false);
    if (unknown.kind !== 'invited' || verified.kind !== 'invited') throw new Error('unreachable');
    assert.deepEqual(Object.keys(unknown.invite).sort(), Object.keys(verified.invite).sort());

    const rows = await isolated.runtime.pool.query<{
      id: string;
      email_normalized: string;
      invited_subject_id: string | null;
      status: string;
    }>(
      `select id, email_normalized, invited_subject_id, status
         from collection_invites
        where id = any($1::text[])
        order by id`,
      [['invite-unknown-pg', 'invite-verified-pg']],
    );
    assert.equal(rows.rows.length, 2);
    const byId = Object.fromEntries(rows.rows.map((row) => [row.id, row]));
    assert.equal(byId['invite-unknown-pg']?.invited_subject_id, null);
    assert.equal(byId['invite-unknown-pg']?.status, 'pending');
    assert.equal(byId['invite-verified-pg']?.invited_subject_id, INVITEE_SUBJECT);
    assert.equal(byId['invite-verified-pg']?.status, 'pending');
    assert.equal(byId['invite-verified-pg']?.email_normalized, INVITEE_EMAIL);
  });

  test('accept writes a members row, bumps policy_revision, leaves content_revision and operations unchanged', async () => {
    const before = await revisionsAndOperations(isolated, COLLECTION_ID);
    const accepted = await run(isolated, (ports) => acceptInvite(ports, {
      actor: inviteeActor(),
      command: { commandId: COMMAND_ACCEPT, fingerprint: 'acc'.padEnd(64, '0') },
      collectionId: COLLECTION_ID,
      inviteId: 'invite-verified-pg',
    }));
    assert.equal(accepted.kind, 'accepted');
    const members = await isolated.runtime.pool.query<{ subject_id: string; role: string }>(
      `select subject_id, role from collection_members
        where collection_id = $1 and subject_id = $2`,
      [COLLECTION_ID, INVITEE_SUBJECT],
    );
    assert.equal(members.rows.length, 1);
    assert.equal(members.rows[0]?.role, 'editor');
    const after = await revisionsAndOperations(isolated, COLLECTION_ID);
    assert.notEqual(after.policyRevision, before.policyRevision);
    assert.equal(after.policyRevisions, before.policyRevisions + 1);
    assert.equal(after.authzCacheVersion, before.authzCacheVersion + 1);
    assert.equal(after.contentRevision, CONTENT_REVISION);
    assert.equal(after.contentRevision, before.contentRevision);
    assert.equal(after.operations, before.operations);
    assert.equal(after.commitOrdinal, before.commitOrdinal);
    assert.equal(after.purgeOutbox, 0, 'private unpublished collections must not enqueue CDN purge');
  });

  test('editor create_node allow, viewer deny, remove then conceal on private collection', async () => {
    const editorDecision = await run(isolated, (ports) => authorizeCapability(ports.facts, {
      collectionId: COLLECTION_ID,
      actor: { principalId: INVITEE_ACCOUNT, subjectId: INVITEE_SUBJECT, kind: 'account' },
      capability: 'create_node',
    }));
    assert.equal(editorDecision.outcome, 'allow');

    await run(isolated, (ports) => inviteMember(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_VIEWER_INVITE, fingerprint: 'vi'.padEnd(64, '1') },
      collectionId: COLLECTION_ID,
      email: VIEWER_EMAIL,
      role: 'viewer',
      inviteId: 'invite-viewer-pg',
    }));
    await run(isolated, (ports) => acceptInvite(ports, {
      actor: viewerActor(),
      command: { commandId: COMMAND_VIEWER_ACCEPT, fingerprint: 'va'.padEnd(64, '2') },
      collectionId: COLLECTION_ID,
      inviteId: 'invite-viewer-pg',
    }));
    const viewerDecision = await run(isolated, (ports) => authorizeCapability(ports.facts, {
      collectionId: COLLECTION_ID,
      actor: { principalId: VIEWER_ACCOUNT, subjectId: VIEWER_SUBJECT, kind: 'account' },
      capability: 'create_node',
    }));
    assert.equal(viewerDecision.outcome, 'deny');
    assert.equal(viewerDecision.reasonCategory, 'insufficient_role');

    await run(isolated, (ports) => updateMemberRole(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_ROLE, fingerprint: 'role'.padEnd(64, '3') },
      collectionId: COLLECTION_ID,
      subjectId: INVITEE_SUBJECT,
      role: 'viewer',
    }));
    await run(isolated, (ports) => removeMember(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_REMOVE, fingerprint: 'rm'.padEnd(64, '4') },
      collectionId: COLLECTION_ID,
      subjectId: INVITEE_SUBJECT,
    }));
    const concealed = await run(isolated, (ports) => authorizeCapability(ports.facts, {
      collectionId: COLLECTION_ID,
      actor: { principalId: INVITEE_ACCOUNT, subjectId: INVITEE_SUBJECT, kind: 'account' },
      capability: 'create_node',
    }));
    assert.equal(concealed.outcome, 'conceal');
    assert.equal(concealed.reasonCategory, 'not_a_member');
  });

  test('concurrent double accept inserts exactly one member row', async () => {
    await run(isolated, (ports) => inviteMember(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_RACE_INVITE, fingerprint: 'race-inv'.padEnd(64, '5') },
      collectionId: COLLECTION_ID,
      email: 'race-sc01@example.test',
      role: 'editor',
      inviteId: 'invite-race-pg',
    }));
    await isolated.runtime.pool.query(
      `update collection_invites
          set invited_subject_id = $1, email_normalized = $2
        where id = 'invite-race-pg'`,
      [INVITEE_SUBJECT, INVITEE_EMAIL],
    );

    const first = run(isolated, (ports) => acceptInvite(ports, {
      actor: inviteeActor(),
      command: { commandId: COMMAND_RACE_A, fingerprint: 'race-a'.padEnd(64, '6') },
      collectionId: COLLECTION_ID,
      inviteId: 'invite-race-pg',
    }));
    const second = run(isolated, (ports) => acceptInvite(ports, {
      actor: inviteeActor(),
      command: { commandId: COMMAND_RACE_B, fingerprint: 'race-b'.padEnd(64, '7') },
      collectionId: COLLECTION_ID,
      inviteId: 'invite-race-pg',
    }));
    const results = await Promise.all([first, second]);
    for (const result of results) {
      assert.equal(result.kind, 'accepted');
    }
    const members = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from collection_members
        where collection_id = $1 and subject_id = $2`,
      [COLLECTION_ID, INVITEE_SUBJECT],
    );
    assert.equal(members.rows[0]?.n, 1);
  });

  test('receipts persist on PostgreSQL', async () => {
    const receipts = await isolated.runtime.pool.query<{ command_id: string; command_scope: string }>(
      `select command_id, command_scope from product_command_receipts
        where command_id = $1`,
      [COMMAND_INVITE_UNKNOWN],
    );
    assert.equal(receipts.rows.length, 1);
    assert.equal(receipts.rows[0]?.command_scope, inviteMemberCommandScope(COLLECTION_ID));
    assert.ok(receipts.rows[0]?.command_scope.startsWith(`collection:${COLLECTION_ID}:members:`));
  });

  test('audit_events are written and invite enqueues invite email outbox events', async () => {
    const audit = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from audit_events
        where event_type like 'collection.collaboration%'
           or event_type like 'collection.member%'
           or event_type like 'collection.invite%'`,
    );
    assert.ok((audit.rows[0]?.n ?? 0) > 0, 'collaboration commands must write audit_events');
    const outbox = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from outbox_events
        where event_type like '%invite%' or handler_name like '%invite%'`,
    );
    assert.ok((outbox.rows[0]?.n ?? 0) > 0, 'invite commands enqueue collection.invite-created outbox events');
  });

  test('logs and error strings do not contain raw emails', async () => {
    await assert.rejects(
      () => run(isolated, (ports) => inviteMember(ports, {
        actor: ownerActor(),
        command: { commandId: '99999999-aaaa-4bbb-8ccc-dddddddddddd', fingerprint: 'err'.padEnd(64, '8') },
        collectionId: COLLECTION_ID,
        email: UNKNOWN_EMAIL,
        role: 'editor',
      })),
      (error: unknown) => {
        assert.ok(error instanceof CollaborationError);
        const serialized = `${error.name}\n${error.message}\n${error.stack ?? ''}\n${String(error)}`;
        assert.equal(serialized.includes(UNKNOWN_EMAIL), false);
        assert.equal(serialized.includes(INVITEE_EMAIL), false);
        assert.equal(serialized.includes(OWNER_EMAIL), false);
        assert.equal(serialized.includes(UNVERIFIED_EMAIL), false);
        return true;
      },
    );
  });
});

function ownerActor(): CollaborationActor {
  return {
    principalId: OWNER_ACCOUNT,
    subjectId: OWNER_SUBJECT,
    kind: 'account',
    email: OWNER_EMAIL,
  };
}

function inviteeActor(): CollaborationActor {
  return {
    principalId: INVITEE_ACCOUNT,
    subjectId: INVITEE_SUBJECT,
    kind: 'account',
    email: INVITEE_EMAIL,
  };
}

function viewerActor(): CollaborationActor {
  return {
    principalId: VIEWER_ACCOUNT,
    subjectId: VIEWER_SUBJECT,
    kind: 'account',
    email: VIEWER_EMAIL,
  };
}

async function run<Result>(
  runtime: IsolatedPostgresRuntime,
  work: (ports: CollaborationCommandPorts) => Promise<Result>,
): Promise<Result> {
  return createUnitOfWork(runtime.runtime.db).execute(async ({ transaction }) => {
    return work(createPostgresCollaborationCommandPorts(transaction));
  });
}

async function revisionsAndOperations(
  runtime: IsolatedPostgresRuntime,
  collectionId: string,
): Promise<{
  policyRevision: string;
  contentRevision: string;
  operations: number;
  commitOrdinal: string;
  authzCacheVersion: number;
  policyRevisions: number;
  purgeOutbox: number;
}> {
  const collection = await runtime.runtime.pool.query<{
    policy_revision: string;
    content_revision: string;
    commit_ordinal: string;
    authz_cache_version: string;
  }>(
    `select policy_revision, content_revision, commit_ordinal::text, authz_cache_version::text
       from collections where id = $1`,
    [collectionId],
  );
  const counts = await runtime.runtime.pool.query<{
    operations: number;
    policy_revisions: number;
    purge_outbox: number;
  }>(
    `select
        (select count(*)::int from operations where collection_id = $1) operations,
        (select count(*)::int from policy_revisions where collection_id = $1) policy_revisions,
        (select count(*)::int from outbox_events
          where aggregate_id = $1 and handler_name = 'publication_cache_purge') purge_outbox`,
    [collectionId],
  );
  return {
    policyRevision: collection.rows[0]?.policy_revision ?? '',
    contentRevision: collection.rows[0]?.content_revision ?? '',
    operations: counts.rows[0]?.operations ?? 0,
    commitOrdinal: collection.rows[0]?.commit_ordinal ?? '',
    authzCacheVersion: Number(collection.rows[0]?.authz_cache_version ?? '0'),
    policyRevisions: counts.rows[0]?.policy_revisions ?? 0,
    purgeOutbox: counts.rows[0]?.purge_outbox ?? 0,
  };
}

async function seedFixtures(runtime: IsolatedPostgresRuntime): Promise<void> {
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    await seedAccount(client, {
      accountId: OWNER_ACCOUNT, subjectId: OWNER_SUBJECT, email: OWNER_EMAIL,
      authUserId: OWNER_AUTH, emailVerified: true,
    });
    await seedAccount(client, {
      accountId: INVITEE_ACCOUNT, subjectId: INVITEE_SUBJECT, email: INVITEE_EMAIL,
      authUserId: INVITEE_AUTH, emailVerified: true,
    });
    await seedAccount(client, {
      accountId: VIEWER_ACCOUNT, subjectId: VIEWER_SUBJECT, email: VIEWER_EMAIL,
      authUserId: VIEWER_AUTH, emailVerified: true,
    });
    await seedAccount(client, {
      accountId: UNVERIFIED_ACCOUNT, subjectId: UNVERIFIED_SUBJECT, email: UNVERIFIED_EMAIL,
      authUserId: UNVERIFIED_AUTH, emailVerified: false,
    });
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type, committed_at)
       values ($1,'collection',current_timestamp),($2,'node',current_timestamp)`,
      [COLLECTION_ID, ROOT_ID],
    );
    await client.query(
      `insert into collections(
         id, owner_subject_id, title, kind, visibility, publication_slug, published_at,
         root_node_id, root_node_is_root, resource_revision, content_revision, policy_revision,
         commit_ordinal, created_at, updated_at)
       values ($1,$2,'Private collab fixture','bookmarks','private',null,null,
         $3,true,'resource-sc01-1',$4,$5,1,current_timestamp,current_timestamp)`,
      [COLLECTION_ID, OWNER_SUBJECT, ROOT_ID, CONTENT_REVISION, POLICY_REVISION],
    );
    await client.query(
      `insert into nodes(
         id, collection_id, parent_id, kind, is_root, title, url, position_token,
         resource_revision, children_revision, created_at, updated_at)
       values ($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',current_timestamp,current_timestamp)`,
      [ROOT_ID, COLLECTION_ID],
    );
    await client.query(
      `insert into collection_members(collection_id, subject_id, role, granted_at)
       values ($1,$2,'owner',current_timestamp)`,
      [COLLECTION_ID, OWNER_SUBJECT],
    );
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedAccount(
  client: { query: (sqlText: string, values?: readonly unknown[]) => Promise<unknown> },
  input: {
    readonly accountId: string;
    readonly subjectId: string;
    readonly email: string;
    readonly authUserId: string;
    readonly emailVerified: boolean;
  },
): Promise<void> {
  await client.query(
    `insert into accounts(id, subject_id, status, email, security_epoch, created_at)
     values ($1,$2,'active',$3,0,current_timestamp)`,
    [input.accountId, input.subjectId, input.email],
  );
  await client.query(
    `insert into "auth_users" ("id","name","email","emailVerified")
     values ($1,$2,$3,$4)`,
    [input.authUserId, input.subjectId, input.email, input.emailVerified],
  );
  await client.query(
    `insert into auth_user_account_map(auth_user_id, account_id)
     values ($1,$2)`,
    [input.authUserId, input.accountId],
  );
}
