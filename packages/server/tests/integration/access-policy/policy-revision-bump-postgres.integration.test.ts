/**
 * CANON-P0-a / ADR-0021 option A: membership/invite bumpPolicyRevision must
 * advance policy revision + authz_cache_version, leave operations and
 * commit_ordinal unchanged, and enqueue PUBLICATION_CACHE_PURGE v2 only when
 * the collection has a publication.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  acceptInvite,
  inviteMember,
  type CollaborationActor,
  type CollaborationCommandPorts,
} from '../../../src/modules/access-policy/index.js';
import { createPostgresCollaborationCommandPorts } from '../../../src/infrastructure/collaboration/index.js';
import { createUnitOfWork, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  POLICY_REVISION_SOURCE_EVENT_TYPE,
  POLICY_REVISION_SOURCE_EVENT_VERSION,
} from '../../../src/infrastructure/collections/policy-revision-port.js';
import {
  PUBLICATION_CACHE_PURGE_EVENT_TYPE,
  PUBLICATION_CACHE_PURGE_EVENT_VERSION,
  PUBLICATION_CACHE_PURGE_HANDLER_NAME,
} from '../../../src/infrastructure/outbox/publication-cache-purge.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const OWNER_ACCOUNT = 'acct-owner-canon-p0a';
const OWNER_SUBJECT = 'subject-owner-canon-p0a';
const OWNER_EMAIL = 'owner-canon-p0a@example.test';
const OWNER_AUTH = 'auth-owner-canon-p0a';
const INVITEE_ACCOUNT = 'acct-invitee-canon-p0a';
const INVITEE_SUBJECT = 'subject-invitee-canon-p0a';
const INVITEE_EMAIL = 'invitee-canon-p0a@example.test';
const INVITEE_AUTH = 'auth-invitee-canon-p0a';

const PRIVATE_COLLECTION = 'col-canon-p0a-private';
const PRIVATE_ROOT = 'root-canon-p0a-private';
const PUBLISHED_COLLECTION = 'col-canon-p0a-published';
const PUBLISHED_ROOT = 'root-canon-p0a-published';
const SLUG_ONLY_COLLECTION = 'col-canon-p0a-slug-only';
const SLUG_ONLY_ROOT = 'root-canon-p0a-slug-only';
const PUBLICATION_SLUG = 'canon-p0a-pub-slug';
const SLUG_ONLY_SLUG = 'canon-p0a-slug-only';
const CONTENT_REVISION = 'content-canon-p0a-1';
const POLICY_REVISION = 'policy-canon-p0a-1';

const COMMAND_PRIVATE_INVITE = '10000000-0000-4000-8000-00000000c0a1';
const COMMAND_PRIVATE_ACCEPT = '10000000-0000-4000-8000-00000000c0a2';
const COMMAND_PUBLISHED_INVITE = '10000000-0000-4000-8000-00000000c0a3';
const COMMAND_PUBLISHED_ACCEPT = '10000000-0000-4000-8000-00000000c0a4';
const COMMAND_SLUG_ONLY_INVITE = '10000000-0000-4000-8000-00000000c0a5';

describeWithPostgres('policy revision bump postgres (CANON-P0-a)', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('canon_p0a_policy_bump', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedFixtures(isolated);
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('authz_cache_version column exists and defaults to 0', async () => {
    const column = await isolated.runtime.pool.query<{ column_default: string; data_type: string }>(
      `select column_default, data_type from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'collections'
          and column_name = 'authz_cache_version'`,
    );
    assert.equal(column.rows.length, 1);
    assert.equal(column.rows[0]?.data_type, 'bigint');
    assert.match(column.rows[0]?.column_default ?? '', /0/);
    const seeded = await snapshot(isolated, PRIVATE_COLLECTION);
    assert.equal(seeded.authzCacheVersion, 0);
  });

  test('unpublished invite/accept: policy revision and authz version advance; operations, commit_ordinal, and purge stay unchanged', async () => {
    const beforeInvite = await snapshot(isolated, PRIVATE_COLLECTION);
    const invited = await run(isolated, (ports) => inviteMember(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_PRIVATE_INVITE, fingerprint: 'priv-inv'.padEnd(64, '0') },
      collectionId: PRIVATE_COLLECTION,
      email: INVITEE_EMAIL,
      role: 'editor',
      inviteId: 'invite-canon-p0a-private',
    }));
    assert.equal(invited.kind, 'invited');
    const afterInvite = await snapshot(isolated, PRIVATE_COLLECTION);
    assertPolicyBumpWithoutCanonicalWrite(beforeInvite, afterInvite);
    assert.equal(afterInvite.purgeOutbox, 0, 'unpublished collections must not enqueue a fake CDN purge');

    const accepted = await run(isolated, (ports) => acceptInvite(ports, {
      actor: inviteeActor(),
      command: { commandId: COMMAND_PRIVATE_ACCEPT, fingerprint: 'priv-acc'.padEnd(64, '1') },
      collectionId: PRIVATE_COLLECTION,
      inviteId: 'invite-canon-p0a-private',
    }));
    assert.equal(accepted.kind, 'accepted');
    const afterAccept = await snapshot(isolated, PRIVATE_COLLECTION);
    assertPolicyBumpWithoutCanonicalWrite(afterInvite, afterAccept);
    assert.equal(afterAccept.purgeOutbox, 0);
  });

  test('published invite/accept: same bump plus PUBLICATION_CACHE_PURGE v2 outbox', async () => {
    const beforeInvite = await snapshot(isolated, PUBLISHED_COLLECTION);
    const invited = await run(isolated, (ports) => inviteMember(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_PUBLISHED_INVITE, fingerprint: 'pub-inv'.padEnd(64, '2') },
      collectionId: PUBLISHED_COLLECTION,
      email: INVITEE_EMAIL,
      role: 'viewer',
      inviteId: 'invite-canon-p0a-published',
    }));
    assert.equal(invited.kind, 'invited');
    const afterInvite = await snapshot(isolated, PUBLISHED_COLLECTION);
    assertPolicyBumpWithoutCanonicalWrite(beforeInvite, afterInvite);
    assert.equal(afterInvite.purgeOutbox, beforeInvite.purgeOutbox + 1);
    await assertLatestPurgePayload(isolated, PUBLISHED_COLLECTION, {
      publicationSlug: PUBLICATION_SLUG,
      policyRevision: afterInvite.policyRevision,
      contentRevision: CONTENT_REVISION,
      visibility: 'public',
    });

    const accepted = await run(isolated, (ports) => acceptInvite(ports, {
      actor: inviteeActor(),
      command: { commandId: COMMAND_PUBLISHED_ACCEPT, fingerprint: 'pub-acc'.padEnd(64, '3') },
      collectionId: PUBLISHED_COLLECTION,
      inviteId: 'invite-canon-p0a-published',
    }));
    assert.equal(accepted.kind, 'accepted');
    const afterAccept = await snapshot(isolated, PUBLISHED_COLLECTION);
    assertPolicyBumpWithoutCanonicalWrite(afterInvite, afterAccept);
    assert.equal(afterAccept.purgeOutbox, afterInvite.purgeOutbox + 1);
    await assertLatestPurgePayload(isolated, PUBLISHED_COLLECTION, {
      publicationSlug: PUBLICATION_SLUG,
      policyRevision: afterAccept.policyRevision,
      contentRevision: CONTENT_REVISION,
      visibility: 'public',
    });
  });

  test('slug without published_at does not enqueue a purge', async () => {
    const before = await snapshot(isolated, SLUG_ONLY_COLLECTION);
    const invited = await run(isolated, (ports) => inviteMember(ports, {
      actor: ownerActor(),
      command: { commandId: COMMAND_SLUG_ONLY_INVITE, fingerprint: 'slug-inv'.padEnd(64, '4') },
      collectionId: SLUG_ONLY_COLLECTION,
      email: INVITEE_EMAIL,
      role: 'viewer',
      inviteId: 'invite-canon-p0a-slug-only',
    }));
    assert.equal(invited.kind, 'invited');
    const after = await snapshot(isolated, SLUG_ONLY_COLLECTION);
    assertPolicyBumpWithoutCanonicalWrite(before, after);
    assert.equal(after.purgeOutbox, 0);
  });
});

interface CollectionBumpSnapshot {
  readonly policyRevision: string;
  readonly contentRevision: string;
  readonly commitOrdinal: string;
  readonly authzCacheVersion: number;
  readonly policyRevisions: number;
  readonly operations: number;
  readonly purgeOutbox: number;
}

function assertPolicyBumpWithoutCanonicalWrite(
  before: CollectionBumpSnapshot,
  after: CollectionBumpSnapshot,
): void {
  assert.notEqual(after.policyRevision, before.policyRevision);
  assert.equal(after.policyRevisions, before.policyRevisions + 1);
  assert.equal(after.authzCacheVersion, before.authzCacheVersion + 1);
  assert.equal(after.contentRevision, before.contentRevision);
  assert.equal(after.commitOrdinal, before.commitOrdinal);
  assert.equal(after.operations, before.operations);
}

async function snapshot(
  runtime: IsolatedPostgresRuntime,
  collectionId: string,
): Promise<CollectionBumpSnapshot> {
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
    policy_revisions: number;
    operations: number;
    purge_outbox: number;
  }>(
    `select
        (select count(*)::int from policy_revisions where collection_id = $1) policy_revisions,
        (select count(*)::int from operations where collection_id = $1) operations,
        (select count(*)::int from outbox_events
          where aggregate_id = $1
            and event_type = $2
            and handler_name = $3) purge_outbox`,
    [collectionId, PUBLICATION_CACHE_PURGE_EVENT_TYPE, PUBLICATION_CACHE_PURGE_HANDLER_NAME],
  );
  const row = collection.rows[0];
  const tally = counts.rows[0];
  assert.ok(row);
  assert.ok(tally);
  return {
    policyRevision: row.policy_revision,
    contentRevision: row.content_revision,
    commitOrdinal: row.commit_ordinal,
    authzCacheVersion: Number(row.authz_cache_version),
    policyRevisions: tally.policy_revisions,
    operations: tally.operations,
    purgeOutbox: tally.purge_outbox,
  };
}

async function assertLatestPurgePayload(
  runtime: IsolatedPostgresRuntime,
  collectionId: string,
  expected: {
    readonly publicationSlug: string;
    readonly policyRevision: string;
    readonly contentRevision: string;
    readonly visibility: 'public' | 'unlisted' | 'protected' | 'private';
  },
): Promise<void> {
  const purge = await runtime.runtime.pool.query<{
    event_type: string;
    event_version: number;
    handler_name: string;
    handler_mode: string;
    commit_ordinal: string | null;
    payload_json: Record<string, unknown>;
  }>(
    `select event_type, event_version, handler_name, handler_mode, commit_ordinal::text, payload_json
       from outbox_events
      where aggregate_id = $1 and handler_name = $2
      order by occurred_at desc, outbox_id desc
      limit 1`,
    [collectionId, PUBLICATION_CACHE_PURGE_HANDLER_NAME],
  );
  assert.equal(purge.rows.length, 1);
  const row = purge.rows[0]!;
  assert.equal(row.event_type, PUBLICATION_CACHE_PURGE_EVENT_TYPE);
  assert.equal(row.event_version, PUBLICATION_CACHE_PURGE_EVENT_VERSION);
  assert.equal(row.handler_name, PUBLICATION_CACHE_PURGE_HANDLER_NAME);
  assert.equal(row.handler_mode, 'delivery_each_event');
  assert.equal(row.commit_ordinal, '1');
  assert.deepEqual(row.payload_json, {
    collectionId,
    contentRevision: expected.contentRevision,
    policyRevision: expected.policyRevision,
    publicationSlug: expected.publicationSlug,
    sourceEventType: POLICY_REVISION_SOURCE_EVENT_TYPE,
    sourceEventVersion: POLICY_REVISION_SOURCE_EVENT_VERSION,
    visibility: expected.visibility,
  });
}

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

async function run<Result>(
  runtime: IsolatedPostgresRuntime,
  work: (ports: CollaborationCommandPorts) => Promise<Result>,
): Promise<Result> {
  return createUnitOfWork(runtime.runtime.db).execute(async ({ transaction }) => (
    work(createPostgresCollaborationCommandPorts(transaction))
  ));
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
    await seedCollection(client, {
      collectionId: PRIVATE_COLLECTION,
      rootId: PRIVATE_ROOT,
      visibility: 'private',
      publicationSlug: null,
      publishedAt: null,
    });
    await seedCollection(client, {
      collectionId: PUBLISHED_COLLECTION,
      rootId: PUBLISHED_ROOT,
      visibility: 'public',
      publicationSlug: PUBLICATION_SLUG,
      publishedAt: 'current_timestamp',
    });
    await seedCollection(client, {
      collectionId: SLUG_ONLY_COLLECTION,
      rootId: SLUG_ONLY_ROOT,
      visibility: 'private',
      publicationSlug: SLUG_ONLY_SLUG,
      publishedAt: null,
    });
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedCollection(
  client: { query: (sqlText: string, values?: readonly unknown[]) => Promise<unknown> },
  input: {
    readonly collectionId: string;
    readonly rootId: string;
    readonly visibility: 'private' | 'public';
    readonly publicationSlug: string | null;
    readonly publishedAt: 'current_timestamp' | null;
  },
): Promise<void> {
  await client.query(
    `insert into resource_id_ledger(resource_id, resource_type, committed_at)
     values ($1,'collection',current_timestamp),($2,'node',current_timestamp)`,
    [input.collectionId, input.rootId],
  );
  await client.query(
    `insert into collections(
       id, owner_subject_id, title, kind, visibility, publication_slug, published_at,
       root_node_id, root_node_is_root, resource_revision, content_revision, policy_revision,
       commit_ordinal, created_at, updated_at)
     values ($1,$2,'CANON-P0-a fixture','bookmarks',$3,$4,${input.publishedAt === 'current_timestamp' ? 'current_timestamp' : 'null'},
       $5,true,'resource-canon-p0a-1',$6,$7,1,current_timestamp,current_timestamp)`,
    [
      input.collectionId, OWNER_SUBJECT, input.visibility, input.publicationSlug,
      input.rootId, CONTENT_REVISION, POLICY_REVISION,
    ],
  );
  await client.query(
    `insert into nodes(
       id, collection_id, parent_id, kind, is_root, title, url, position_token,
       resource_revision, children_revision, created_at, updated_at)
     values ($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',current_timestamp,current_timestamp)`,
    [input.rootId, input.collectionId],
  );
  await client.query(
    `insert into collection_members(collection_id, subject_id, role, granted_at)
     values ($1,$2,'owner',current_timestamp)`,
    [input.collectionId, OWNER_SUBJECT],
  );
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
