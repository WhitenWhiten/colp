/**
 * P1-03 access-policy facts port against isolated PostgreSQL.
 *
 * Seeds collections/nodes via SQL (ports must not own collections table writes),
 * exercises createPostgresAccessPolicyPorts + authorizeCapability.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import { createUnitOfWork, databaseNow, runMigrations, type DatabaseTransaction } from '../../../src/infrastructure/database/index.js';
import { createPostgresAccessPolicyPorts } from '../../../src/infrastructure/access-policy/index.js';
import {
  ALL_COLLECTION_CAPABILITIES,
  authorizeCapability,
  toProductDenial,
  type AccessPolicyPorts,
  type ActorPrincipal,
  type CollectionCapability,
  type CollectionVisibility,
  type MembershipRole,
} from '../../../src/modules/access-policy/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const OWNER_SUBJECT = 'subject-owner';
const ACTOR_SUBJECT = 'subject-actor';
const OTHER_SUBJECT = 'subject-other';

const EDITOR_ALLOWED = new Set<CollectionCapability>([
  'read_editor',
  'update_collection_metadata',
  'create_node',
  'update_node',
  'move_node',
  'delete_node',
]);
const VIEWER_ALLOWED = new Set<CollectionCapability>(['read_editor']);

function actor(overrides: Partial<ActorPrincipal> = {}): ActorPrincipal {
  return {
    principalId: 'principal-actor',
    subjectId: ACTOR_SUBJECT,
    kind: 'account',
    ...overrides,
  };
}

function expectedGrant(role: MembershipRole, capability: CollectionCapability): boolean {
  if (role === 'owner') return true;
  if (role === 'editor') return EDITOR_ALLOWED.has(capability);
  return VIEWER_ALLOWED.has(capability);
}

interface SeedCollectionInput {
  readonly collectionId: string;
  readonly rootId: string;
  readonly ownerSubjectId: string;
  readonly visibility?: CollectionVisibility;
  readonly policyRevision?: string;
  readonly deleted?: boolean;
}

async function seedCollection(
  transaction: DatabaseTransaction,
  input: SeedCollectionInput,
): Promise<void> {
  const visibility = input.visibility ?? 'private';
  const policyRevision = input.policyRevision ?? 'policy-rev-1';

  await sql`
    insert into resource_id_ledger (resource_id, resource_type)
    values (${input.collectionId}, 'collection'), (${input.rootId}, 'node')
  `.execute(transaction);

  // Collection/root deletion state must match at commit (deferred lifecycle trigger).
  // Set deleted_at on both inserts so the pair never diverges mid-transaction.
  if (input.deleted) {
    await sql`
      insert into collections (
        id, owner_subject_id, title, kind, visibility, root_node_id,
        resource_revision, content_revision, policy_revision, publication_slug, published_at, deleted_at
      ) values (
        ${input.collectionId}, ${input.ownerSubjectId}, 'Access Policy Fixture',
        'bookmarks', ${visibility}, ${input.rootId}, 'r1', 'c1', ${policyRevision},
        ${visibility === 'public' || visibility === 'unlisted' ? input.collectionId : null},
        ${visibility === 'public' || visibility === 'unlisted' ? sql`now()` : null}, now()
      )
    `.execute(transaction);

    await sql`
      insert into nodes (
        id, collection_id, kind, is_root, title, resource_revision, children_revision,
        deleted_at
      ) values (
        ${input.rootId}, ${input.collectionId}, 'folder', true, 'Root', 'r1', 'ch1',
        now()
      )
    `.execute(transaction);
    return;
  }

  await sql`
    insert into collections (
      id, owner_subject_id, title, kind, visibility, root_node_id,
      resource_revision, content_revision, policy_revision, publication_slug, published_at
    ) values (
      ${input.collectionId}, ${input.ownerSubjectId}, 'Access Policy Fixture',
      'bookmarks', ${visibility}, ${input.rootId}, 'r1', 'c1', ${policyRevision},
      ${visibility === 'public' || visibility === 'unlisted' ? input.collectionId : null},
      ${visibility === 'public' || visibility === 'unlisted' ? sql`now()` : null}
    )
  `.execute(transaction);

  await sql`
    insert into nodes (
      id, collection_id, kind, is_root, title, resource_revision, children_revision
    ) values (
      ${input.rootId}, ${input.collectionId}, 'folder', true, 'Root', 'r1', 'ch1'
    )
  `.execute(transaction);
}

describeWithPostgres('access-policy facts PostgreSQL ports', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('access_policy', {
      maxConnections: 6,
      applicationName: 'known-access-policy-facts-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');
  });

  afterAll(async () => {
    await isolated?.close();
  });

  async function withPorts<Result>(
    work: (ports: AccessPolicyPorts, transaction: DatabaseTransaction) => Promise<Result>,
  ): Promise<Result> {
    return createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      const ports = createPostgresAccessPolicyPorts(transaction);
      return work(ports, transaction);
    });
  }

  test('missing collection facts are null and authorizeCapability conceals as 404', async () => {
    await withPorts(async (ports) => {
      const loaded = await ports.facts.loadCollectionFacts({
        collectionId: `missing-${randomUUID()}`,
        actorSubjectId: ACTOR_SUBJECT,
      });
      assert.equal(loaded, null);

      const decision = await authorizeCapability(ports.facts, {
        collectionId: `missing-${randomUUID()}`,
        actor: actor(),
        capability: 'read_editor',
      });
      assert.equal(decision.outcome, 'conceal');
      assert.equal(decision.reasonCategory, 'resource_missing');
      assert.deepEqual(toProductDenial(decision), {
        statusCode: 404,
        code: 'resource_not_found',
        recovery: 'none',
      });
    });
  });

  test('owner/editor/viewer membership matrix via facts port + authorizeCapability', async () => {
    const collectionId = `collection-${randomUUID()}`;
    const rootId = `root-${randomUUID()}`;

    await withPorts(async (ports, transaction) => {
      await seedCollection(transaction, {
        collectionId,
        rootId,
        ownerSubjectId: OWNER_SUBJECT,
        visibility: 'private',
        policyRevision: 'rev-matrix',
      });

      for (const role of ['owner', 'editor', 'viewer'] as const) {
        await ports.writes.deleteMembership({
          collectionId,
          subjectId: ACTOR_SUBJECT,
        });
        await ports.writes.insertMembership({
          collectionId,
          subjectId: ACTOR_SUBJECT,
          role,
          grantedAt: await databaseNow(transaction),
        });

        for (const capability of ALL_COLLECTION_CAPABILITIES) {
          const decision = await authorizeCapability(ports.facts, {
            collectionId,
            actor: actor({ subjectId: ACTOR_SUBJECT }),
            capability,
          });
          const shouldAllow = expectedGrant(role, capability);
          assert.equal(
            decision.outcome === 'allow',
            shouldAllow,
            `${role} × ${capability} → ${decision.outcome}/${decision.reasonCategory}`,
          );
          if (shouldAllow) {
            assert.equal(decision.effectiveRole, role);
            assert.equal(toProductDenial(decision), null);
          } else {
            assert.equal(decision.outcome, 'deny');
            assert.equal(decision.reasonCategory, 'insufficient_role');
            assert.deepEqual(toProductDenial(decision), {
              statusCode: 403,
              code: 'insufficient_permission',
              recovery: 'user_action',
            });
          }
        }
      }
    });
  });

  test('revoked membership on private collection conceals (404)', async () => {
    const collectionId = `collection-${randomUUID()}`;
    const rootId = `root-${randomUUID()}`;

    await withPorts(async (ports, transaction) => {
      await seedCollection(transaction, {
        collectionId,
        rootId,
        ownerSubjectId: OWNER_SUBJECT,
        visibility: 'private',
      });
      await ports.writes.insertMembership({
        collectionId,
        subjectId: ACTOR_SUBJECT,
        role: 'editor',
        grantedAt: await databaseNow(transaction),
      });

      const before = await authorizeCapability(ports.facts, {
        collectionId,
        actor: actor(),
        capability: 'create_node',
      });
      assert.equal(before.outcome, 'allow');

      const removed = await ports.writes.deleteMembership({
        collectionId,
        subjectId: ACTOR_SUBJECT,
      });
      assert.equal(removed, true);

      const after = await authorizeCapability(ports.facts, {
        collectionId,
        actor: actor(),
        capability: 'create_node',
      });
      assert.equal(after.outcome, 'conceal');
      assert.equal(after.reasonCategory, 'not_a_member');
      assert.deepEqual(toProductDenial(after), {
        statusCode: 404,
        code: 'resource_not_found',
        recovery: 'none',
      });
    });
  });

  test('cross-collection isolation: membership on A does not grant B', async () => {
    const collectionA = `collection-a-${randomUUID()}`;
    const rootA = `root-a-${randomUUID()}`;
    const collectionB = `collection-b-${randomUUID()}`;
    const rootB = `root-b-${randomUUID()}`;

    await withPorts(async (ports, transaction) => {
      await seedCollection(transaction, {
        collectionId: collectionA,
        rootId: rootA,
        ownerSubjectId: OWNER_SUBJECT,
        visibility: 'private',
      });
      await seedCollection(transaction, {
        collectionId: collectionB,
        rootId: rootB,
        ownerSubjectId: OWNER_SUBJECT,
        visibility: 'private',
      });
      await ports.writes.insertMembership({
        collectionId: collectionA,
        subjectId: ACTOR_SUBJECT,
        role: 'owner',
        grantedAt: await databaseNow(transaction),
      });

      const onA = await authorizeCapability(ports.facts, {
        collectionId: collectionA,
        actor: actor(),
        capability: 'manage_members',
      });
      assert.equal(onA.outcome, 'allow');

      const onB = await authorizeCapability(ports.facts, {
        collectionId: collectionB,
        actor: actor(),
        capability: 'manage_members',
      });
      assert.equal(onB.outcome, 'conceal');
      assert.equal(onB.reasonCategory, 'not_a_member');
    });
  });

  test('policy revision TOCTOU mismatch denies with policy_revision_mismatch', async () => {
    const collectionId = `collection-${randomUUID()}`;
    const rootId = `root-${randomUUID()}`;

    await withPorts(async (ports, transaction) => {
      await seedCollection(transaction, {
        collectionId,
        rootId,
        ownerSubjectId: OWNER_SUBJECT,
        policyRevision: 'rev-current',
      });
      await ports.writes.insertMembership({
        collectionId,
        subjectId: ACTOR_SUBJECT,
        role: 'owner',
        grantedAt: await databaseNow(transaction),
      });

      const mismatch = await authorizeCapability(ports.facts, {
        collectionId,
        actor: actor(),
        capability: 'update_node',
        expectedPolicyRevision: 'rev-stale',
      });
      assert.equal(mismatch.outcome, 'deny');
      assert.equal(mismatch.reasonCategory, 'policy_revision_mismatch');
      assert.equal(mismatch.policyRevision, 'rev-current');
      assert.deepEqual(toProductDenial(mismatch), {
        statusCode: 403,
        code: 'insufficient_permission',
        recovery: 'user_action',
      });

      const match = await authorizeCapability(ports.facts, {
        collectionId,
        actor: actor(),
        capability: 'update_node',
        expectedPolicyRevision: 'rev-current',
      });
      assert.equal(match.outcome, 'allow');
    });
  });

  test('soft-deleted collection conceals for owner member', async () => {
    const collectionId = `collection-${randomUUID()}`;
    const rootId = `root-${randomUUID()}`;

    await withPorts(async (ports, transaction) => {
      await seedCollection(transaction, {
        collectionId,
        rootId,
        ownerSubjectId: ACTOR_SUBJECT,
        deleted: true,
      });
      await ports.writes.insertMembership({
        collectionId,
        subjectId: ACTOR_SUBJECT,
        role: 'owner',
        grantedAt: await databaseNow(transaction),
      });

      const facts = await ports.facts.loadCollectionFacts({
        collectionId,
        actorSubjectId: ACTOR_SUBJECT,
      });
      assert.ok(facts);
      assert.equal(facts.deleted, true);
      assert.equal(facts.membershipRole, 'owner');

      const decision = await authorizeCapability(ports.facts, {
        collectionId,
        actor: actor({ subjectId: ACTOR_SUBJECT }),
        capability: 'read_editor',
      });
      assert.equal(decision.outcome, 'conceal');
      assert.equal(decision.reasonCategory, 'resource_missing');
      assert.deepEqual(toProductDenial(decision), {
        statusCode: 404,
        code: 'resource_not_found',
        recovery: 'none',
      });
    });
  });

  test('owner_subject_id without membership row elevates to owner', async () => {
    const collectionId = `collection-${randomUUID()}`;
    const rootId = `root-${randomUUID()}`;

    await withPorts(async (ports, transaction) => {
      await seedCollection(transaction, {
        collectionId,
        rootId,
        ownerSubjectId: ACTOR_SUBJECT,
        visibility: 'private',
      });

      const facts = await ports.facts.loadCollectionFacts({
        collectionId,
        actorSubjectId: ACTOR_SUBJECT,
      });
      assert.ok(facts);
      assert.equal(facts.membershipRole, null);
      assert.equal(facts.ownerSubjectId, ACTOR_SUBJECT);

      const decision = await authorizeCapability(ports.facts, {
        collectionId,
        actor: actor({ subjectId: ACTOR_SUBJECT }),
        capability: 'manage_members',
      });
      assert.equal(decision.outcome, 'allow');
      assert.equal(decision.effectiveRole, 'owner');
    });
  });

  test('public non-member is denied (403), not concealed', async () => {
    const collectionId = `collection-${randomUUID()}`;
    const rootId = `root-${randomUUID()}`;

    await withPorts(async (ports, transaction) => {
      await seedCollection(transaction, {
        collectionId,
        rootId,
        ownerSubjectId: OWNER_SUBJECT,
        visibility: 'public',
      });

      const decision = await authorizeCapability(ports.facts, {
        collectionId,
        actor: actor({ subjectId: OTHER_SUBJECT }),
        capability: 'read_editor',
      });
      assert.equal(decision.outcome, 'deny');
      assert.equal(decision.reasonCategory, 'not_a_member');
      assert.deepEqual(toProductDenial(decision), {
        statusCode: 403,
        code: 'insufficient_permission',
        recovery: 'user_action',
      });
    });
  });

  test('upsertCollectionPolicy write port is callable without owning collections table', async () => {
    const collectionId = `collection-${randomUUID()}`;
    const rootId = `root-${randomUUID()}`;

    await withPorts(async (ports, transaction) => {
      await seedCollection(transaction, {
        collectionId,
        rootId,
        ownerSubjectId: OWNER_SUBJECT,
      });

      await ports.writes.upsertCollectionPolicy({
        collectionId,
        policyJson: { phase: 'p1-03' },
        updatedAt: await databaseNow(transaction),
      });

      const row = await sql<{ policy_json: unknown }>`
        select policy_json from collection_policies where collection_id = ${collectionId}
      `.execute(transaction);
      assert.equal(row.rows.length, 1);
      assert.deepEqual(row.rows[0]?.policy_json, { phase: 'p1-03' });
    });
  });
});
