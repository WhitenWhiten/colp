/**
 * P4A-I08 PostgreSQL integration suite against the PRODUCTION migration.
 *
 * Proves the durable side of `issueUploadIntent` with real PostgreSQL:
 * ledger-before-grant ordering vs grant issuance, same-binding recovery
 * (including after a process restart), different-binding new generation/key,
 * concurrent same-binding issue over two connections with deterministic
 * barriers (one winner, loser recovers the SAME identity), concurrent
 * different bindings, the CSPRNG collision negative with a controlled
 * generator (DB rejects, fresh candidate, no overwrite), and signing failure
 * leaving the ledger intact.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createPostgresAccessPolicyFactsPort,
} from '../../../src/infrastructure/access-policy/index.js';
import { createDatabaseRuntime, createPostgresAttachmentsPorts, createUnitOfWork } from '../../../src/infrastructure/database/index.js';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/index.js';
import {
  UploadIntentSigningError,
  issueUploadIntent,
  nodeUploadIntentCrypto,
  type IssueUploadIntentDeps,
} from '../../../src/modules/attachments/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  BarrierGroup,
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import {
  I08_COLLECTION,
  I08_LIVE_PREFIX,
  I08_SUBJECT,
  QueueCrypto,
  RecordingGrantStore,
  hexFor,
  makeActor,
  makeI08Config,
} from '../../support/phase4a-i08-test-helpers.js';

const ACTOR = makeActor();
const EDITOR_ACTOR = makeActor('i08-subject-editor', 'i08-principal-editor');
const VIEWER_ACTOR = makeActor('i08-subject-viewer', 'i08-principal-viewer');
const OUTSIDER_ACTOR = makeActor('i08-outsider', 'i08-principal-outsider');

async function seedCollection(runtime: I07MigrationRuntime['runtime'], collectionId: string, ownerSubjectId: string, options: {
  visibility?: 'private' | 'protected' | 'public' | 'unlisted';
  policyRevision?: string;
  deleted?: boolean;
} = {}): Promise<void> {
  const rootId = `${collectionId}-root`;
  const deletedAt = options.deleted ? new Date() : null;
  // collections.id references resource_id_ledger (immediate FK) and
  // (id, root_node_id, root_node_is_root) references the root node row
  // (deferred FK), so all three rows must be created in ONE transaction:
  // resource_id_ledger -> collections -> root node. Deletion state is set on
  // BOTH the collection and its root node so the deferred lifecycle trigger
  // never observes a diverged pair.
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    await sql`
      insert into resource_id_ledger (resource_id, resource_type)
      values (${collectionId}, 'collection'), (${rootId}, 'node')
    `.execute(transaction);
    await sql`
      insert into collections
        (id, owner_subject_id, title, kind, root_node_id, resource_revision,
         content_revision, policy_revision, visibility, commit_ordinal,
         created_at, updated_at, deleted_at)
      values (${collectionId}, ${ownerSubjectId}, 'I08 collection', 'bookmarks', ${rootId},
        ${`resource-${collectionId}`}, ${`content-${collectionId}`},
        ${options.policyRevision ?? 'policy-r1'}, ${options.visibility ?? 'private'}, 1, now(), now(), ${deletedAt})
    `.execute(transaction);
    await sql`
      insert into nodes
        (id, collection_id, kind, is_root, title, resource_revision, children_revision, deleted_at)
      values (${rootId}, ${collectionId}, 'folder', true, 'Root', 'r1', 'ch1', ${deletedAt})
    `.execute(transaction);
  });
}

async function seedMembership(runtime: I07MigrationRuntime['runtime'], collectionId: string, subjectId: string, role: 'owner' | 'editor' | 'viewer'): Promise<void> {
  await runtime.pool.query(
    'insert into collection_members (collection_id, subject_id, role, granted_at) values ($1, $2, $3, now())',
    [collectionId, subjectId, role],
  );
}

async function seedPolicyCollection(runtime: I07MigrationRuntime['runtime']): Promise<void> {
  await seedCollection(runtime, I08_COLLECTION, I08_SUBJECT);
  await seedMembership(runtime, I08_COLLECTION, I08_SUBJECT, 'owner');
  await seedMembership(runtime, I08_COLLECTION, 'i08-subject-editor', 'editor');
  await seedMembership(runtime, I08_COLLECTION, 'i08-subject-viewer', 'viewer');
}

function issueInput(idempotencyKey: string, overrides: Record<string, unknown> = {}) {
  return {
    actor: ACTOR,
    collectionId: I08_COLLECTION,
    idempotencyKey,
    declaredSize: 2048,
    declaredSha256: 'a'.repeat(64),
    mediaHint: 'image/png',
    ...overrides,
  };
}

function makeDeps(
  runtime: I07MigrationRuntime['runtime'],
  store: RecordingGrantStore,
  options: { crypto?: { randomHex(bytes: number): string } } = {},
): IssueUploadIntentDeps<DatabaseTransaction> {
  const ledger = createPostgresAttachmentsPorts();
  return {
    ledger,
    accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
    blobStore: store,
    uow: createUnitOfWork(runtime.db),
    crypto: options.crypto ?? nodeUploadIntentCrypto,
    config: makeI08Config(),
    now: () => new Date('2026-08-08T12:00:00.000Z'),
  };
}

/** Wraps the ledger so the concurrent suite can inject deterministic barriers. */
function withAllocateBarrier(
  ledger: IssueUploadIntentDeps<DatabaseTransaction>['ledger'],
  barrier: { arriveAndWait(name: string): Promise<void> },
): IssueUploadIntentDeps<DatabaseTransaction>['ledger'] {
  return {
    ...ledger,
    allocate: (transaction, input) => ledger.allocate(transaction, input, { barrier }),
  };
}

async function counts(runtime: I07MigrationRuntime['runtime'] | ReturnType<typeof createDatabaseRuntime>): Promise<{ intents: number; generations: number }> {
  const intents = await sql<{ count: string }>`select count(*)::text as count from upload_intents`.execute(runtime.db);
  const generations = await sql<{ count: string }>`select count(*)::text as count from blob_generations`.execute(runtime.db);
  return { intents: Number(intents.rows[0]!.count), generations: Number(generations.rows[0]!.count) };
}

describeWithPostgres('P4A-I08 durable upload intents', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('i08_upload_intent', { maxConnections: 12 });
    await seedPolicyCollection(isolated.runtime);
  });

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('ledger facts commit BEFORE the grant is issued (ledger-before-grant ordering)', async () => {
    const store = new RecordingGrantStore();
    const before = await counts(isolated.runtime);
    // Single-clock window proof on the DATABASE clock (plan §5.4): the intent
    // row must be committed between the DB clock captured before the call and
    // the DB clock captured after it returns. A raw zero-tolerance comparison
    // of DB created_at against the JS grant clock is avoided because the
    // Testcontainers DB and the app process are independent clocks with small
    // skew; the strict ledger-commit-timestamp-before-external-PUT check is
    // the real-target probe's job (evidence:phase4a-i08).
    const dbBefore = await sql<{ now: Date }>`select now() as now`.execute(isolated.runtime.db);
    const result = await issueUploadIntent(makeDeps(isolated.runtime, store), issueInput('idem-order'));
    const dbAfter = await sql<{ now: Date }>`select now() as now`.execute(isolated.runtime.db);
    assert.equal(result.recovered, false);
    const after = await counts(isolated.runtime);
    assert.equal(after.intents - before.intents, 1);
    assert.equal(after.generations - before.generations, 1);
    const created = await sql<{ created_at: Date }>`
      select created_at from upload_intents where intent_id = ${result.receipt.intentId}
    `.execute(isolated.runtime.db);
    assert.ok(created.rows[0], 'the intent must be durable immediately after issue resolves');
    const committedAt = created.rows[0]!.created_at.getTime();
    const beforeMs = dbBefore.rows[0]!.now.getTime();
    const afterMs = dbAfter.rows[0]!.now.getTime();
    assert.ok(committedAt >= beforeMs, `ledger ${committedAt} must be committed during the issue call (db-before ${beforeMs})`);
    assert.ok(committedAt <= afterMs, `ledger ${committedAt} must be committed before the issue call returned (db-after ${afterMs})`);
    // The grant is issued by the same call and is bound to the committed
    // generation; the use case signs only after the transaction committed.
    assert.equal(store.calls.length, 1);
    assert.equal(store.calls[0]!.handle.generationId, result.receipt.generationId);
    assert.equal(store.calls[0]!.options.contentLength, 2048);
  });

  test('same binding replay recovers the same identity; generation count is unchanged', async () => {
    const store = new RecordingGrantStore();
    const deps = makeDeps(isolated.runtime, store);
    const before = await counts(isolated.runtime);
    const first = await issueUploadIntent(deps, issueInput('idem-replay'));
    const second = await issueUploadIntent(deps, issueInput('idem-replay'));
    assert.equal(second.recovered, true);
    assert.equal(second.receipt.intentId, first.receipt.intentId);
    assert.equal(second.receipt.generationId, first.receipt.generationId);
    assert.equal(second.blobId, first.blobId);
    const after = await counts(isolated.runtime);
    assert.equal(after.intents - before.intents, 1, 'replay must not create a second intent');
    assert.equal(after.generations - before.generations, 1, 'replay must not create a second generation');
    assert.notEqual(second.grant.url, first.grant.url);
    const key = await sql<{ key: string }>`select key from upload_intents ui join blob_generations bg on bg.generation_id = ui.generation_id where ui.intent_id = ${first.receipt.intentId}`.execute(isolated.runtime.db);
    assert.equal(key.rows[0]!.key, store.calls[1]!.handle.key, 'the SAME committed key is re-signed for the same binding');
  });

  test('a different binding creates a new blob/generation/key; the old key is never re-signed', async () => {
    const store = new RecordingGrantStore();
    const deps = makeDeps(isolated.runtime, store);
    const before = await counts(isolated.runtime);
    const first = await issueUploadIntent(deps, issueInput('idem-a'));
    const second = await issueUploadIntent(deps, issueInput('idem-b'));
    assert.equal(second.recovered, false);
    assert.notEqual(second.receipt.generationId, first.receipt.generationId);
    assert.notEqual(second.blobId, first.blobId);
    const after = await counts(isolated.runtime);
    assert.equal(after.intents - before.intents, 2);
    assert.equal(after.generations - before.generations, 2);
    const rows = await sql<{ generation_id: string; key: string }>`
      select ui.generation_id, bg.key from upload_intents ui
      join blob_generations bg on bg.generation_id = ui.generation_id
      where ui.idempotency_key in ('idem-a', 'idem-b')
      order by ui.created_at
    `.execute(isolated.runtime.db);
    assert.equal(rows.rows.length, 2);
    const keys = rows.rows.map((row) => row.key);
    assert.equal(new Set(keys).size, 2, 'each attempt must use a distinct physical key');
    assert.equal(store.calls.length, 2);
    assert.notEqual(store.calls[1]!.handle.key, store.calls[0]!.handle.key, 'the old key is never re-signed for a new attempt');
  });



  test('concurrent same binding over two connections: one winner, loser recovers the same identity', async () => {
    const group = new BarrierGroup();
    const barrierA = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:a`) };
    const barrierB = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:b`) };
    const storeA = new RecordingGrantStore();
    const storeB = new RecordingGrantStore();
    const depsA = makeDeps(isolated.runtime, storeA);
    const depsB = makeDeps(isolated.runtime, storeB);
    const before = await counts(isolated.runtime);
    const raceA = issueUploadIntent({ ...depsA, ledger: withAllocateBarrier(depsA.ledger, barrierA) }, issueInput('idem-race'));
    const raceB = issueUploadIntent({ ...depsB, ledger: withAllocateBarrier(depsB.ledger, barrierB) }, issueInput('idem-race'));

    // Both transactions are paused at the allocate barrier before any write.
    await group.waitAllArrived(['allocate_before_key:a', 'allocate_before_key:b']);
    group.releaseAll(['allocate_before_key:a', 'allocate_before_key:b']);

    const [resultA, resultB] = await Promise.all([raceA, raceB]);
    assert.equal(resultA.receipt.intentId, resultB.receipt.intentId, 'both callers must converge on ONE intent');
    assert.equal(resultA.receipt.generationId, resultB.receipt.generationId);
    const after = await counts(isolated.runtime);
    assert.equal(after.intents - before.intents, 1, 'the concurrent race must never duplicate the binding');
    assert.equal(after.generations - before.generations, 1);
    assert.equal(resultA.recovered !== resultB.recovered, true);
    assert.equal(storeA.grants.length + storeB.grants.length, 2);
  });

  test('concurrent different bindings produce distinct generations and keys', async () => {
    const group = new BarrierGroup();
    const barrierA = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:a`) };
    const barrierB = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:b`) };
    const storeA = new RecordingGrantStore();
    const storeB = new RecordingGrantStore();
    const depsA = makeDeps(isolated.runtime, storeA);
    const depsB = makeDeps(isolated.runtime, storeB);
    const before = await counts(isolated.runtime);
    const raceA = issueUploadIntent({ ...depsA, ledger: withAllocateBarrier(depsA.ledger, barrierA) }, issueInput('idem-par-a'));
    const raceB = issueUploadIntent({ ...depsB, ledger: withAllocateBarrier(depsB.ledger, barrierB) }, issueInput('idem-par-b'));
    await group.waitAllArrived(['allocate_before_key:a', 'allocate_before_key:b']);
    group.releaseAll(['allocate_before_key:a', 'allocate_before_key:b']);
    const [resultA, resultB] = await Promise.all([raceA, raceB]);
    assert.notEqual(resultA.receipt.generationId, resultB.receipt.generationId);
    assert.notEqual(storeA.calls[0]!.handle.key, storeB.calls[0]!.handle.key);
    const after = await counts(isolated.runtime);
    assert.equal(after.intents - before.intents, 2);
    assert.equal(after.generations - before.generations, 2);
  });

  test('CSPRNG collision negative: the DB rejects the duplicate and a fresh candidate is used, never overwriting', async () => {
    // The use case namespaces every physical key with the live prefix; the
    // injected CSPRNG values are the random suffix.
    const k1 = hexFor('key-1');
    const k2 = hexFor('key-2');
    const firstStore = new RecordingGrantStore();
    const before = await counts(isolated.runtime);
    const first = await issueUploadIntent(
      makeDeps(isolated.runtime, firstStore, { crypto: new QueueCrypto([hexFor('intent-1'), hexFor('gen-1'), k1]) }),
      issueInput('idem-collision-a'),
    );
    assert.equal(first.receipt.generationId, hexFor('gen-1'));

    const secondStore = new RecordingGrantStore();
    const collisionCrypto = new QueueCrypto([
      hexFor('intent-2a'), hexFor('gen-2a'), k1, // attempt 0: injected duplicate key
      hexFor('intent-2b'), hexFor('gen-2b'), k2, // attempt 1: fresh candidate
    ]);
    const second = await issueUploadIntent(
      makeDeps(isolated.runtime, secondStore, { crypto: collisionCrypto }),
      issueInput('idem-collision-b'),
    );
    assert.equal(second.receipt.generationId, hexFor('gen-2b'));
    const bound = await sql<{ generation_id: string }>`select generation_id from generation_keys where key = ${I08_LIVE_PREFIX + k1}`.execute(isolated.runtime.db);
    assert.equal(bound.rows[0]!.generation_id, hexFor('gen-1'), 'the colliding key must remain bound to its original generation');
    const after = await counts(isolated.runtime);
    assert.equal(after.intents - before.intents, 2);
    assert.equal(after.generations - before.generations, 2);
  });

  test('signing failure leaves the ledger intact and a later call re-signs the same identity', async () => {
    const store = new RecordingGrantStore();
    store.failNextWith = new Error('signer unavailable');
    const before = await counts(isolated.runtime);
    await assert.rejects(
      issueUploadIntent(makeDeps(isolated.runtime, store), issueInput('idem-sign')),
      (error: unknown) => error instanceof UploadIntentSigningError,
    );
    const afterFailure = await counts(isolated.runtime);
    assert.equal(afterFailure.intents - before.intents, 1, 'the committed generation survives the signing failure');
    assert.equal(afterFailure.generations - before.generations, 1);
    const retry = await issueUploadIntent(makeDeps(isolated.runtime, store), issueInput('idem-sign'));
    assert.equal(retry.recovered, true);
    const afterRetry = await counts(isolated.runtime);
    assert.equal(afterRetry.generations - before.generations, 1, 're-signing must not allocate a new generation');
  });

  test('authorization over real facts: owner/editor/member allowed; outsider, cross-collection, deleted, stale revision denied with zero persistence', async () => {
    // owner
    const ownerStore = new RecordingGrantStore();
    const owner = await issueUploadIntent(makeDeps(isolated.runtime, ownerStore), issueInput('idem-auth-owner'));
    assert.equal(owner.recovered, false);
    // editor and viewer (member) are allowed
    await issueUploadIntent(makeDeps(isolated.runtime, new RecordingGrantStore()), issueInput('idem-auth-editor', { actor: EDITOR_ACTOR }));
    await issueUploadIntent(makeDeps(isolated.runtime, new RecordingGrantStore()), issueInput('idem-auth-viewer', { actor: VIEWER_ACTOR }));

    // The actor is a member of the harness collection but NOT of the foreign
    // collection (read_editor is a membership gate, so the foreign collection
    // must deny with zero persistence).
    await seedCollection(isolated.runtime, 'i08-foreign-collection', 'i08-owner-foreign');
    await seedCollection(isolated.runtime, 'i08-deleted-collection', 'i08-owner-deleted', { deleted: true });
    await seedMembership(isolated.runtime, 'i08-deleted-collection', I08_SUBJECT, 'owner');

    const deniedCases: Array<[string, Record<string, unknown>, string]> = [
      ['outsider', { actor: OUTSIDER_ACTOR }, 'not_a_member'],
      ['cross-collection', { collectionId: 'i08-foreign-collection' }, 'not_a_member'],
      ['deleted collection', { collectionId: 'i08-deleted-collection' }, 'resource_missing'],
      ['stale policy revision', { expectedPolicyRevision: 'policy-stale' }, 'policy_revision_mismatch'],
    ];
    const before = await counts(isolated.runtime);
    for (const [label, overrides, reason] of deniedCases) {
      await assert.rejects(
        issueUploadIntent(makeDeps(isolated.runtime, new RecordingGrantStore()), issueInput(`idem-denied-${label}`, overrides)),
        (error: unknown) => error instanceof Error && error.name === 'UploadIntentAuthorizationError'
          && (error as { reasonCategory?: string }).reasonCategory === reason,
        label,
      );
    }
    const after = await counts(isolated.runtime);
    assert.equal(after.intents - before.intents, 0, 'denied requests must persist nothing');
    assert.equal(after.generations - before.generations, 0);
  });

  test('recovery after a process restart re-reads the database and returns the same identity', async () => {
    const firstStore = new RecordingGrantStore();
    const before = await counts(isolated.runtime);
    const first = await issueUploadIntent(makeDeps(isolated.runtime, firstStore), issueInput('idem-restart'));
    assert.equal((await counts(isolated.runtime)).intents - before.intents, 1);

    // Simulate a process exit: close the pool but keep the schema.
    await isolated.closeKeepSchema();
    const restarted = createDatabaseRuntime(isolated.databaseUrl, {
      maxConnections: 6,
      applicationName: 'known-i08-restart',
      connectionTimeoutMs: 5_000,
      idleTimeoutMs: 1_000,
      statementTimeoutMs: 30_000,
    });
    try {
      const secondStore = new RecordingGrantStore();
      const second = await issueUploadIntent(makeDeps(restarted, secondStore), issueInput('idem-restart'));
      assert.equal(second.recovered, true, 'restart recovery must find the committed intent');
      assert.equal(second.receipt.intentId, first.receipt.intentId);
      assert.equal(second.receipt.generationId, first.receipt.generationId);
      const after = await counts(restarted);
      assert.equal(after.intents - before.intents, 1);
      assert.equal(after.generations - before.generations, 1);
    } finally {
      await restarted.close();
    }
  });
});
