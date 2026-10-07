import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { Pool } from 'pg';
import { sql } from 'kysely';
import { createDatabaseRuntime, createPostgresProductCommandReceiptPort as createProductCommandReceiptPort, createPostgresProductCommandReceiptPortFactory, createUnitOfWork, DatabaseOperationError, appendOperationWithPayload, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  canonicalCommandFingerprint,
  deleteAccountReceipts,
  type ProductCommandBinding,
  type ProductCommandResult,
} from '../../../src/modules/commands/index.js';
import { runMigrations } from '../../../src/infrastructure/database/migrations.js';
import {
  configuredTestDatabaseUrl,
  describeWithPostgres,
} from '../../support/postgres-test-runtime.js';
import { httpCommandScopeV1 } from '../../../src/transport/http-command-scope.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const ACTIVE_CLAIM_LATENCY_BOUND_MS = 1_000;

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withinActiveClaimBound<Result>(operation: Promise<Result>): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('active command claim exceeded latency bound')),
          ACTIVE_CLAIM_LATENCY_BOUND_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describeWithPostgres('Product command receipt PostgreSQL semantics', () => {
  const databaseUrl = configuredTestDatabaseUrl();
  const schema = `command_receipt_${randomUUID().replaceAll('-', '_')}`;
  let admin: Pool;
  let runtime: DatabaseRuntime;
  // FIX-L-010: armed only around the real lost-COMMIT-acknowledgement test;
  // every other commit on this runtime must pass through untouched.
  let lostCommitAck = false;

  beforeAll(async () => {
    assert.ok(databaseUrl, 'KNOWN_TEST_DATABASE_URL or DATABASE_URL is required');
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`create schema ${schema}`);
    const isolated = new URL(databaseUrl);
    isolated.searchParams.set('options', `-c search_path=${schema}`);
    runtime = createDatabaseRuntime(isolated.toString(), {
      maxConnections: 4,
      applicationName: 'known-command-receipt-test',
      transactionPhaseFaultInjector: {
        afterCommitApplied: async () => {
          if (lostCommitAck) {
            throw Object.assign(new Error('simulated lost commit acknowledgement'), { code: 'ECONNRESET' });
          }
        },
      },
    });
    await runMigrations(runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => {
    await runtime?.close();
    await admin?.query(`drop schema if exists ${schema} cascade`);
    await admin?.end();
  }, 120_000);

  test('creates scheduled receipt ports through the transaction-bound factory', async () => {
    const factory = createPostgresProductCommandReceiptPortFactory(runtime.db);
    const port = await factory();
    const first = binding();
    const firstFingerprint = fingerprint();

    assert.deepEqual(await port.claim(first, firstFingerprint), { kind: 'claimed' });
    await port.complete(first, firstFingerprint, result());
    assert.equal((await port.claim(first, firstFingerprint)).kind, 'replay');

    await runtime.pool.query(`update product_command_receipts
      set completed_at = current_timestamp - interval '31 days',
          result_expires_at = current_timestamp - interval '1 second'
      where principal_id = $1 and command_scope = $2 and command_id = $3`,
    [first.principalId, first.commandScope, first.commandId]);
    assert.equal(await port.purgeExpired({ limit: 1 }), 1);
    assert.equal((await port.claim(first, firstFingerprint)).kind, 'expired');

    const second = binding({ principalId: first.principalId });
    assert.deepEqual(await port.claim(second, firstFingerprint), { kind: 'claimed' });
    assert.equal(await port.deletePrincipalReceipts(first.principalId), 2);
    const remaining = await runtime.pool.query<{ count: string }>(
      'select count(*)::text as count from product_command_receipts where principal_id = $1',
      [first.principalId],
    );
    assert.equal(remaining.rows[0]?.count, '0');
  });

  function binding(overrides: Partial<ProductCommandBinding> = {}): ProductCommandBinding {
    return {
      principalId: `principal-${randomUUID()}`,
      commandScope: 'collection:collection-1',
      commandId: randomUUID(),
      ...overrides,
    };
  }

  function fingerprint(body: unknown = { title: 'Known' }): string {
    return canonicalCommandFingerprint({
      method: 'PATCH', route: 'updateCollection', resource: 'collection-1',
      mediaType: 'application/merge-patch+json', query: {},
      conditions: { ifMatch: '"r1"' }, body,
    });
  }

  function result(): ProductCommandResult {
    return {
      status: 200,
      body: Buffer.from('{"collection":{"id":"collection-1","revision":"r2"}}'),
      stableHeaders: {
        etag: '"r2"',
        'content-type': 'application/json',
        location: '/api/v1/collections/collection-1',
        'x-request-id': 'first-request-must-not-replay',
        date: 'Wed, 01 Jan 2026 00:00:00 GMT',
        traceparent: '00-trace-span-01',
      },
      mediaType: 'application/json',
      contractVersion: '1.0.0',
      targetIdentity: 'collection:collection-1',
    };
  }

  async function claim(seen: ProductCommandBinding, seenFingerprint: string) {
    return createUnitOfWork(runtime.db).execute(({ transaction }) =>
      createProductCommandReceiptPort(transaction).claim(seen, seenFingerprint));
  }

  test('readiness requires the complete Phase 3 migration chain and critical constraints', async () => {
    await runtime.verifyReady();

    const effectMigration = await runtime.pool.query<{ name: string; timestamp: string }>(
      `delete from kysely_migration where name='202607252700_sync_operation_effects'
       returning name,timestamp`,
    );
    try {
      await assert.rejects(runtime.verifyReady(), /required Phase 3 Pull recovery proof migration/);
    } finally {
      await runtime.pool.query(`insert into kysely_migration(name,timestamp) values($1,$2)`, [
        effectMigration.rows[0]!.name, effectMigration.rows[0]!.timestamp,
      ]);
    }

    await runtime.pool.query(`alter table product_command_receipts
      drop constraint product_command_id_canonical_uuid_v4`);
    try {
      await assert.rejects(runtime.verifyReady(), /missing required Phase 3 authoritative effect constraints/);
    } finally {
      await runtime.pool.query(`alter table product_command_receipts
        add constraint product_command_id_canonical_uuid_v4 check (
          command_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        )`);
    }
    await runtime.verifyReady();
  });

  test('cancels a PostgreSQL backend through an independent bounded runtime connection', async () => {
    for (const invalidPid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(
        runtime.cancelBackend(invalidPid),
        /PostgreSQL backend PID must be a positive safe integer/,
      );
    }

    const target = await runtime.pool.connect();
    try {
      const pid = await target.query<{ pid: number }>('select pg_backend_pid()::integer pid');
      const cancellationObserved = assert.rejects(
        target.query('select pg_sleep(10)'),
        (error: unknown) => (
          error instanceof Error
          && 'code' in error
          && error.code === '57014'
        ),
      );

      assert.equal(await runtime.cancelBackend(pid.rows[0]!.pid), true);
      await cancellationObserved;
    } finally {
      target.release();
    }
  }, 10_000);

  test('replays exact stable status, bytes, headers, media type and contract version', async () => {
    const seen = binding();
    const seenFingerprint = fingerprint();
    const stored = result();
    await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
      const receipts = createProductCommandReceiptPort(transaction);
      assert.deepEqual(await receipts.claim(seen, seenFingerprint), { kind: 'claimed' });
      await receipts.complete(seen, seenFingerprint, stored);
    });

    const replay = await claim(seen, seenFingerprint);
    assert.equal(replay.kind, 'replay');
    if (replay.kind !== 'replay') return;
    assert.equal(replay.result.status, stored.status);
    assert.deepEqual(Buffer.from(replay.result.body), Buffer.from(stored.body));
    assert.deepEqual(replay.result.stableHeaders, {
      etag: '"r2"',
      'content-type': 'application/json',
      location: '/api/v1/collections/collection-1',
    });
    assert.equal(replay.result.mediaType, stored.mediaType);
    assert.equal(replay.result.contractVersion, stored.contractVersion);
    assert.equal(replay.result.targetIdentity, stored.targetIdentity);
    assert.equal('x-request-id' in replay.result.stableHeaders, false);
    assert.equal('date' in replay.result.stableHeaders, false);
    assert.equal('traceparent' in replay.result.stableHeaders, false);
  });

  test('replays a receipt stored with the pre-layering HTTP scope', async () => {
    const legacyScope = 'PATCH /api/v1/collections/collection-legacy';
    const seen = binding({ commandScope: legacyScope });
    const seenFingerprint = fingerprint({ title: 'Legacy receipt' });
    const stored = result();
    await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
      const receipts = createProductCommandReceiptPort(transaction);
      assert.deepEqual(await receipts.claim(seen, seenFingerprint), { kind: 'claimed' });
      await receipts.complete(seen, seenFingerprint, stored);
    });

    const currentBinding = {
      ...seen,
      commandScope: httpCommandScopeV1('PATCH', '/api/v1/collections/collection-legacy'),
    };
    assert.equal(currentBinding.commandScope, legacyScope);
    assert.equal((await claim(currentBinding, seenFingerprint)).kind, 'replay');
  });

  test('rejects a different fingerprint while isolating principal and scope namespaces', async () => {
    const commandId = randomUUID();
    const original = binding({ commandId, principalId: 'principal-a', commandScope: 'collection:a' });
    assert.deepEqual(await claim(original, fingerprint()), { kind: 'claimed' });
    assert.deepEqual(await claim(original, fingerprint({ title: 'Different' })), { kind: 'reused' });
    assert.deepEqual(await claim({ ...original, principalId: 'principal-b' }, fingerprint()), { kind: 'claimed' });
    assert.deepEqual(await claim({ ...original, commandScope: 'collection:b' }, fingerprint()), { kind: 'claimed' });
  });

  test('returns in progress within the bound while one PostgreSQL transaction owns the live claim', async () => {
    const seen = binding();
    const seenFingerprint = fingerprint();
    const winnerClaimed = deferred();
    const releaseWinner = deferred();
    const stored = result();
    const winner = createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
      const receipts = createProductCommandReceiptPort(transaction);
      assert.deepEqual(await receipts.claim(seen, seenFingerprint), { kind: 'claimed' });
      winnerClaimed.resolve();
      await releaseWinner.promise;
      await receipts.complete(seen, seenFingerprint, stored);
    });

    await winnerClaimed.promise;
    const startedAt = performance.now();
    let loser: Awaited<ReturnType<typeof claim>>;
    try {
      loser = await withinActiveClaimBound(claim(seen, seenFingerprint));
    } finally {
      releaseWinner.resolve();
    }
    const elapsedMs = performance.now() - startedAt;
    assert.deepEqual(loser, { kind: 'in_progress', retryAfterSeconds: 1 });
    assert.ok(elapsedMs < ACTIVE_CLAIM_LATENCY_BOUND_MS, `loser waited ${elapsedMs}ms`);

    await winner;
    const replay = await claim(seen, seenFingerprint);
    assert.equal(replay.kind, 'replay');
    if (replay.kind === 'replay') {
      assert.equal(replay.result.status, stored.status);
      assert.deepEqual(Buffer.from(replay.result.body), Buffer.from(stored.body));
      assert.deepEqual(replay.result.stableHeaders, {
        etag: '"r2"',
        'content-type': 'application/json',
        location: '/api/v1/collections/collection-1',
      });
    }
  });

  test('keeps the existing stale committed unfinished-claim policy', async () => {
    const seen = binding();
    const seenFingerprint = fingerprint();
    assert.deepEqual(await claim(seen, seenFingerprint), { kind: 'claimed' });
    assert.deepEqual(await claim(seen, seenFingerprint), {
      kind: 'in_progress',
      retryAfterSeconds: 1,
    });
    assert.equal((await claim(seen, fingerprint({ title: 'Different' }))).kind, 'reused');
  });

  test('releases live ownership after owner failure so one retry can claim', async () => {
    const seen = binding();
    const seenFingerprint = fingerprint();
    const winnerClaimed = deferred();
    const failWinner = deferred();
    const owner = createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
      const receipts = createProductCommandReceiptPort(transaction);
      assert.deepEqual(await receipts.claim(seen, seenFingerprint), { kind: 'claimed' });
      winnerClaimed.resolve();
      await failWinner.promise;
      throw new Error('owner failed');
    });

    await winnerClaimed.promise;
    try {
      assert.deepEqual(await withinActiveClaimBound(claim(seen, seenFingerprint)), {
        kind: 'in_progress',
        retryAfterSeconds: 1,
      });
    } finally {
      failWinner.resolve();
    }
    await assert.rejects(owner, /owner failed/);
    assert.deepEqual(await claim(seen, seenFingerprint), { kind: 'claimed' });
  });

  test('rolls back the claim and accompanying writes when receipt completion fails', async () => {
    const seen = binding();
    const seenFingerprint = fingerprint();
    const ledgerId = `rollback-${randomUUID()}`;

    await assert.rejects(createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
      const receipts = createProductCommandReceiptPort(transaction);
      assert.deepEqual(await receipts.claim(seen, seenFingerprint), { kind: 'claimed' });
      await sql`insert into resource_id_ledger (resource_id, resource_type)
        values (${ledgerId}, 'operation')`.execute(transaction);
      await receipts.complete(seen, fingerprint({ title: 'wrong fingerprint' }), result());
    }), /receipt was not claim owner/);

    const state = await runtime.pool.query<{ receipt_count: string; ledger_count: string }>(
      `select
        (select count(*) from product_command_receipts
          where principal_id = $1 and command_scope = $2 and command_id = $3)::text as receipt_count,
        (select count(*) from resource_id_ledger where resource_id = $4)::text as ledger_count`,
      [seen.principalId, seen.commandScope, seen.commandId, ledgerId],
    );
    assert.deepEqual(state.rows[0], { receipt_count: '0', ledger_count: '0' });
    assert.deepEqual(await claim(seen, seenFingerprint), { kind: 'claimed' });
  });

  test('recovers an unknown commit outcome by replay without a second mutation, operation or ordinal', async () => {
    const seen = binding();
    const seenFingerprint = fingerprint();
    const collectionId = `collection-${randomUUID()}`;
    const rootId = `root-${randomUUID()}`;
    const resourceId = `node-${randomUUID()}`;
    const operationId = `operation-${randomUUID()}`;
    const outboxId = `outbox-${randomUUID()}`;
    const uncertain = createUnitOfWork(runtime.db, {
      faultInjector: { afterCommitAcknowledged() { throw new Error('lost commit acknowledgement'); } },
    });

    const executeCommand = (unitOfWork: ReturnType<typeof createUnitOfWork>) =>
      unitOfWork.execute(async ({ transaction }) => {
        const receipts = createProductCommandReceiptPort(transaction);
        const admission = await receipts.claim(seen, seenFingerprint);
        if (admission.kind !== 'claimed') return admission;
        await sql`insert into resource_id_ledger (resource_id, resource_type) values
          (${collectionId}, 'collection'), (${rootId}, 'node'), (${resourceId}, 'node'),
          (${operationId}, 'operation'), (${outboxId}, 'outbox')`.execute(transaction);
        await sql`insert into collections
          (id, owner_subject_id, title, kind, root_node_id, resource_revision,
           content_revision, policy_revision, commit_ordinal)
          values (${collectionId}, ${seen.principalId}, 'Receipt harness', 'bookmarks',
            ${rootId}, 'r1', 'c1', 'p1', 0)`.execute(transaction);
        await sql`insert into nodes
          (id, collection_id, kind, is_root, title, resource_revision, children_revision)
          values (${rootId}, ${collectionId}, 'folder', true, 'Root', 'r1', 'ch1')`.execute(transaction);
        await sql`update collections set commit_ordinal = 1 where id = ${collectionId}`.execute(transaction);
        await sql`insert into nodes
          (id, collection_id, parent_id, kind, title, position_token, resource_revision, children_revision)
          values (${resourceId}, ${collectionId}, ${rootId}, 'folder', 'Created once', 'A', 'r2', 'ch1')`.execute(transaction);
        await sql`insert into resource_revisions (collection_id, resource_id, revision, ordinal)
          values (${collectionId}, ${resourceId}, 'r2', 1)`.execute(transaction);
        await appendOperationWithPayload(transaction, {
          operationId, collectionId, commitOrdinal: 1n,
          operationType: 'resource.create', payloadJson: {}, actorPrincipalId: null,
        });
        await sql`insert into outbox_events
          (outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
           aggregate_type, aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal, occurred_at)
          values (${outboxId}, ${operationId}, 'resource.created', 1, 'receipt-harness',
            'delivery_each_event', 'node', ${resourceId}, ${collectionId}, 'r2', 1, current_timestamp)`.execute(transaction);
        await receipts.complete(seen, seenFingerprint, result());
        return admission;
      });

    await assert.rejects(executeCommand(uncertain), (error: unknown) => typeof error === 'object' && error !== null
      && (error as { kind?: unknown }).kind === 'commit_outcome_unknown');

    const recovered = await executeCommand(createUnitOfWork(runtime.db));
    assert.equal(recovered.kind, 'replay');
    const state = await runtime.pool.query<{
      receipt_count: string; mutation_count: string; operation_count: string;
      revision_count: string; outbox_count: string; commit_ordinal: string;
    }>(`select
      (select count(*) from product_command_receipts where principal_id = $1 and command_scope = $2 and command_id = $3)::text as receipt_count,
      (select count(*) from nodes where id = $4)::text as mutation_count,
      (select count(*) from operations where operation_id = $5)::text as operation_count,
      (select count(*) from resource_revisions where collection_id = $6 and resource_id = $4 and ordinal = 1)::text as revision_count,
      (select count(*) from outbox_events where outbox_id = $7)::text as outbox_count,
      (select commit_ordinal::text from collections where id = $6) as commit_ordinal`,
    [seen.principalId, seen.commandScope, seen.commandId, resourceId, operationId, collectionId, outboxId]);
    assert.deepEqual(state.rows[0], {
      receipt_count: '1', mutation_count: '1', operation_count: '1',
      revision_count: '1', outbox_count: '1', commit_ordinal: '1',
    });
  });

  test('classifies a REAL lost COMMIT acknowledgement as commit_outcome_unknown and replays without a second mutation', async () => {
    const seen = binding();
    const seenFingerprint = fingerprint();
    const collectionId = `collection-${randomUUID()}`;
    const rootId = `root-${randomUUID()}`;
    const resourceId = `node-${randomUUID()}`;
    const operationId = `operation-${randomUUID()}`;
    const outboxId = `outbox-${randomUUID()}`;

    // Unlike the afterCommitAcknowledged fault (the transaction already
    // resolved), this drops the acknowledgement INSIDE the COMMIT: the server
    // applies the commit, the driver wrapper throws a connection error, and
    // the unit of work must classify commit_outcome_unknown instead of a
    // provable rollback.
    const executeCommand = (unitOfWork: ReturnType<typeof createUnitOfWork>) =>
      unitOfWork.execute(async ({ transaction }) => {
        const receipts = createProductCommandReceiptPort(transaction);
        const admission = await receipts.claim(seen, seenFingerprint);
        if (admission.kind !== 'claimed') return admission;
        await sql`insert into resource_id_ledger (resource_id, resource_type) values
          (${collectionId}, 'collection'), (${rootId}, 'node'), (${resourceId}, 'node'),
          (${operationId}, 'operation'), (${outboxId}, 'outbox')`.execute(transaction);
        await sql`insert into collections
          (id, owner_subject_id, title, kind, root_node_id, resource_revision,
           content_revision, policy_revision, commit_ordinal)
          values (${collectionId}, ${seen.principalId}, 'Receipt harness', 'bookmarks',
            ${rootId}, 'r1', 'c1', 'p1', 0)`.execute(transaction);
        await sql`insert into nodes
          (id, collection_id, kind, is_root, title, resource_revision, children_revision)
          values (${rootId}, ${collectionId}, 'folder', true, 'Root', 'r1', 'ch1')`.execute(transaction);
        await sql`update collections set commit_ordinal = 1 where id = ${collectionId}`.execute(transaction);
        await sql`insert into nodes
          (id, collection_id, parent_id, kind, title, position_token, resource_revision, children_revision)
          values (${resourceId}, ${collectionId}, ${rootId}, 'folder', 'Created once', 'A', 'r2', 'ch1')`.execute(transaction);
        await sql`insert into resource_revisions (collection_id, resource_id, revision, ordinal)
          values (${collectionId}, ${resourceId}, 'r2', 1)`.execute(transaction);
        await appendOperationWithPayload(transaction, {
          operationId, collectionId, commitOrdinal: 1n,
          operationType: 'resource.create', payloadJson: {}, actorPrincipalId: null,
        });
        await sql`insert into outbox_events
          (outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
           aggregate_type, aggregate_id, aggregate_scope, aggregate_revision, commit_ordinal, occurred_at)
          values (${outboxId}, ${operationId}, 'resource.created', 1, 'receipt-harness',
            'delivery_each_event', 'node', ${resourceId}, ${collectionId}, 'r2', 1, current_timestamp)`.execute(transaction);
        await receipts.complete(seen, seenFingerprint, result());
        return admission;
      });

    lostCommitAck = true;
    let failed: unknown;
    try {
      await executeCommand(createUnitOfWork(runtime.db));
      assert.fail('the lost acknowledgement must reject the command execution');
    } catch (error) {
      failed = error;
    } finally {
      lostCommitAck = false;
    }
    assert.ok(failed instanceof DatabaseOperationError);
    assert.equal(failed.kind, 'commit_outcome_unknown');
    assert.equal(failed.retryableAtCommandBoundary, false,
      'an unknown commit outcome must never be auto-retried');

    // The server DID commit: recovery via the command receipt boundary replays
    // the stored result and never produces a second mutation.
    const recovered = await executeCommand(createUnitOfWork(runtime.db));
    assert.equal(recovered.kind, 'replay');
    const state = await runtime.pool.query<{
      receipt_count: string; mutation_count: string; operation_count: string;
      revision_count: string; outbox_count: string; commit_ordinal: string;
    }>(`select
      (select count(*) from product_command_receipts where principal_id = $1 and command_scope = $2 and command_id = $3)::text as receipt_count,
      (select count(*) from nodes where id = $4)::text as mutation_count,
      (select count(*) from operations where operation_id = $5)::text as operation_count,
      (select count(*) from resource_revisions where collection_id = $6 and resource_id = $4 and ordinal = 1)::text as revision_count,
      (select count(*) from outbox_events where outbox_id = $7)::text as outbox_count,
      (select commit_ordinal::text from collections where id = $6) as commit_ordinal`,
    [seen.principalId, seen.commandScope, seen.commandId, resourceId, operationId, collectionId, outboxId]);
    assert.deepEqual(state.rows[0], {
      receipt_count: '1', mutation_count: '1', operation_count: '1',
      revision_count: '1', outbox_count: '1', commit_ordinal: '1',
    });
  });

  test('keeps a compact permanent claim after the 30-day full-result window and returns expired', async () => {
    const seen = binding();
    const seenFingerprint = fingerprint();
    await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
      const receipts = createProductCommandReceiptPort(transaction);
      await receipts.claim(seen, seenFingerprint);
      await receipts.complete(seen, seenFingerprint, result());
    });

    await runtime.pool.query(`update product_command_receipts
      set completed_at = current_timestamp - interval '31 days',
          result_expires_at = current_timestamp + interval '1 hour'
      where principal_id = $1 and command_scope = $2 and command_id = $3`,
    [seen.principalId, seen.commandScope, seen.commandId]);
    const beforeWindow = await createUnitOfWork(runtime.db).execute(({ transaction }) =>
      createProductCommandReceiptPort(transaction).purgeExpired());
    assert.equal(beforeWindow, 0);
    assert.equal((await claim(seen, seenFingerprint)).kind, 'replay');

    await runtime.pool.query(`update product_command_receipts
      set completed_at = current_timestamp - interval '31 days',
          result_expires_at = current_timestamp - interval '1 second'
      where principal_id = $1 and command_scope = $2 and command_id = $3`,
    [seen.principalId, seen.commandScope, seen.commandId]);
    const purged = await createUnitOfWork(runtime.db).execute(({ transaction }) =>
      createProductCommandReceiptPort(transaction).purgeExpired());
    assert.equal(purged, 1);
    const expired = await claim(seen, seenFingerprint);
    assert.equal(expired.kind, 'expired');
    if (expired.kind === 'expired') assert.match(expired.resultDigest ?? '', /^[0-9a-f]{64}$/);
    assert.equal((await claim(seen, fingerprint({ title: 'Changed' }))).kind, 'reused');
  });

  test('uses canonical PostgreSQL time for claim, completion and purge', async () => {
    const seen = binding();
    const seenFingerprint = fingerprint();
    const before = await runtime.pool.query<{ now: Date }>('select current_timestamp as now');
    await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
      const receipts = createProductCommandReceiptPort(transaction);
      await receipts.claim(seen, seenFingerprint);
      await receipts.complete(seen, seenFingerprint, result());
    });
    const after = await runtime.pool.query<{ now: Date }>('select current_timestamp as now');
    const stored = await runtime.pool.query<{ claimed_at: Date; completed_at: Date; result_expires_at: Date }>(
      `select claimed_at, completed_at, result_expires_at from product_command_receipts
       where principal_id = $1 and command_scope = $2 and command_id = $3`,
      [seen.principalId, seen.commandScope, seen.commandId],
    );
    const row = stored.rows[0]!;
    for (const timestamp of [row.claimed_at, row.completed_at]) {
      assert.ok(timestamp >= before.rows[0]!.now);
      assert.ok(timestamp <= after.rows[0]!.now);
    }
    assert.equal(row.result_expires_at.getTime() - row.completed_at.getTime(), 30 * DAY_MS);

    await runtime.pool.query(`update product_command_receipts
      set completed_at = current_timestamp - interval '31 days',
          result_expires_at = current_timestamp - interval '1 second'
      where principal_id = $1 and command_scope = $2 and command_id = $3`,
    [seen.principalId, seen.commandScope, seen.commandId]);
    await createUnitOfWork(runtime.db).execute(({ transaction }) =>
      createProductCommandReceiptPort(transaction).purgeExpired());
    const purged = await runtime.pool.query<{ result_purged_at: Date }>(
      `select result_purged_at from product_command_receipts
       where principal_id = $1 and command_scope = $2 and command_id = $3`,
      [seen.principalId, seen.commandScope, seen.commandId],
    );
    assert.ok(purged.rows[0]!.result_purged_at <= new Date(Date.now() + 5_000));
  });

  test('deletes all account receipts when the account principal is deleted', async () => {
    const principalId = `deleted-${randomUUID()}`;
    const first = binding({ principalId });
    const second = binding({ principalId });
    for (const seen of [first, second]) {
      await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
        const receipts = createProductCommandReceiptPort(transaction);
        await receipts.claim(seen, fingerprint());
        await receipts.complete(seen, fingerprint(), result());
      });
    }
    const deleted = await createUnitOfWork(runtime.db).execute(({ transaction }) =>
      deleteAccountReceipts(createProductCommandReceiptPort(transaction), principalId));
    assert.equal(deleted, 2);

    const remaining = await runtime.pool.query<{ count: string }>(
      'select count(*)::text as count from product_command_receipts where principal_id = $1',
      [principalId],
    );
    assert.equal(remaining.rows[0]?.count, '0');

    const rollbackPrincipal = `rollback-${randomUUID()}`;
    await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
      const receipts = createProductCommandReceiptPort(transaction);
      const seen = binding({ principalId: rollbackPrincipal });
      await receipts.claim(seen, fingerprint());
    });
    await assert.rejects(createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
      await deleteAccountReceipts(createProductCommandReceiptPort(transaction), rollbackPrincipal);
      throw new Error('account deletion failed');
    }), (error: unknown) => error instanceof Error
      && error.message === 'account deletion failed'
      && error.name !== 'DatabaseOperationError');
    const rolledBack = await runtime.pool.query<{ count: string }>(
      'select count(*)::text as count from product_command_receipts where principal_id = $1',
      [rollbackPrincipal],
    );
    assert.equal(rolledBack.rows[0]?.count, '1');
  });

  test('rejects incomplete completed and inconsistent compact receipts at the database boundary', async () => {
    const completedAt = new Date('2026-01-01T00:00:00Z');
    const expiresAt = new Date(completedAt.getTime() + 30 * DAY_MS);
    const digest = 'a'.repeat(64);
    const fullResult = {
      resultStatus: 200,
      resultHeaders: JSON.stringify({ 'content-type': 'application/json' }),
      resultMediaType: 'application/json',
      resultBytes: Buffer.from('{}'),
    };
    const insertReceipt = (values: {
      completedAt?: Date;
      expiresAt?: Date;
      digest?: string;
      compactClaim?: boolean;
      resultStatus?: number;
      resultHeaders?: string;
      resultMediaType?: string;
      resultBytes?: Buffer;
    }) => runtime.pool.query(
      `insert into product_command_receipts (
        principal_id, command_scope, command_id, request_fingerprint,
        completed_at, result_expires_at, result_digest, compact_claim,
        result_status, result_headers, result_media_type, result_bytes
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
      [
        `constraint-${randomUUID()}`, 'collection:constraint', randomUUID(), fingerprint(),
        values.completedAt ?? null, values.expiresAt ?? null, values.digest ?? null,
        values.compactClaim ?? false, values.resultStatus ?? null, values.resultHeaders ?? null,
        values.resultMediaType ?? null, values.resultBytes ?? null,
      ],
    );

    await assert.rejects(insertReceipt({
      completedAt, digest, ...fullResult,
    }), /product_command_full_result_retention/i);
    await assert.rejects(insertReceipt({
      completedAt, expiresAt, ...fullResult,
    }), /product_command_digest_format/i);
    await assert.rejects(insertReceipt({
      completedAt, expiresAt, digest,
    }), /product_command_compact_result_consistency/i);
    await assert.rejects(insertReceipt({
      compactClaim: true,
    }), /product_command_compact_result_consistency/i);
    await assert.rejects(insertReceipt({
      completedAt, expiresAt, digest, compactClaim: true, ...fullResult,
    }), /product_command_compact_result_consistency/i);
  });

  // R16: purge is a single bounded UPDATE with a FOR UPDATE SKIP LOCKED candidate
  // CTE. Every helper below seeds through SQL so the constraint-checked full-result
  // shape (hardening migration) holds without replaying the port's claim/complete
  // algorithm. All seeded batches are drained by the end of their test so no
  // expired row leaks into a later purge-count assertion.

  async function ageReceipt(seen: ProductCommandBinding): Promise<void> {
    await runtime.pool.query(`update product_command_receipts
      set completed_at = current_timestamp - interval '31 days',
          result_expires_at = current_timestamp - interval '1 second'
      where principal_id = $1 and command_scope = $2 and command_id = $3`,
    [seen.principalId, seen.commandScope, seen.commandId]);
  }

  async function seedCompletedReceipts(
    count: number,
    options: {
      principalPrefix: string;
      completedAtAgeDays: string;
      expiresAtOffset: string;
      distinctExpiry?: boolean;
      scope?: string;
    },
  ): Promise<void> {
    const { principalPrefix, completedAtAgeDays, expiresAtOffset, scope = 'collection:bulk' } = options;
    await runtime.pool.query(
      `insert into product_command_receipts (
        principal_id, command_scope, command_id, request_fingerprint, target_identity,
        result_status, result_headers, result_media_type, result_bytes, result_digest,
        contract_version, claimed_at, completed_at, result_expires_at, result_purged_at, compact_claim
      )
      select
        $1 || '-' || g::text,
        $2,
        gen_random_uuid()::text,
        'fp-' || md5($1 || '-' || g::text),
        null,
        200,
        '{"content-type":"application/json"}'::jsonb,
        'application/json',
        convert_to(($1 || '-payload-' || g::text), 'UTF8'),
        repeat('a', 64),
        '1.0.0',
        current_timestamp - ($3)::interval,
        current_timestamp - ($3)::interval,
        current_timestamp + ($4)::interval - (g * ($5)::interval),
        null,
        false
      from generate_series(1, $6) as g`,
      [principalPrefix, scope, completedAtAgeDays, expiresAtOffset,
        options.distinctExpiry === false ? '0 seconds' : '1 microsecond', count],
    );
  }

  async function purgeExpired(limit?: number): Promise<number> {
    return createUnitOfWork(runtime.db).execute(({ transaction }) =>
      createProductCommandReceiptPort(transaction).purgeExpired({ limit }));
  }

  test('purgeExpired compacts exactly the requested limit and floors zero and negative limits to one', async () => {
    const prefix = `exact-limit-${randomUUID().replaceAll('-', '_')}`;
    await seedCompletedReceipts(5, {
      principalPrefix: prefix, completedAtAgeDays: '31 days', expiresAtOffset: '-1 seconds',
    });

    assert.equal(await purgeExpired(2), 2);
    const state = await runtime.pool.query<{ compacted: string; intact: string }>(
      `select
         count(*) filter (where compact_claim and result_bytes is null)::text as compacted,
         count(*) filter (where not compact_claim and result_bytes is not null)::text as intact
       from product_command_receipts where principal_id like $1`, [`${prefix}-%`]);
    assert.deepEqual(state.rows[0], { compacted: '2', intact: '3' });

    assert.equal(await purgeExpired(1), 1);
    assert.equal(await purgeExpired(0), 1);
    assert.equal(await purgeExpired(-1), 1);
    assert.equal(await purgeExpired(10_000), 0);
    const drained = await runtime.pool.query<{ count: string }>(
      'select count(*)::text as count from product_command_receipts where principal_id like $1',
      [`${prefix}-%`]);
    assert.equal(drained.rows[0]!.count, '5');
  });

  test('purgeExpired clamps the batch ceiling at 10,000 receipts', async () => {
    const prefix = `ceiling-${randomUUID().replaceAll('-', '_')}`;
    await seedCompletedReceipts(10_005, {
      principalPrefix: prefix, completedAtAgeDays: '31 days', expiresAtOffset: '-1 seconds',
    });

    assert.equal(await purgeExpired(20_000), 10_000);
    const remaining = await runtime.pool.query<{ count: string }>(
      `select count(*)::text as count from product_command_receipts
       where principal_id like $1 and not compact_claim and result_bytes is not null`,
      [`${prefix}-%`]);
    assert.equal(remaining.rows[0]!.count, '5');
    assert.equal(await purgeExpired(10_000), 5);
  }, 120_000);

  test('already compacted receipts re-purge to zero and leave the row byte-identical', async () => {
    const seen = binding();
    const seenFingerprint = fingerprint();
    await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
      const receipts = createProductCommandReceiptPort(transaction);
      await receipts.claim(seen, seenFingerprint);
      await receipts.complete(seen, seenFingerprint, result());
    });
    await ageReceipt(seen);

    assert.equal(await purgeExpired(1), 1);
    const readRow = () => runtime.pool.query(
      `select principal_id, command_scope, command_id, request_fingerprint, target_identity,
        result_status, result_headers, result_media_type, result_bytes, result_digest,
        contract_version, claimed_at, completed_at, result_expires_at, result_purged_at, compact_claim
       from product_command_receipts
       where principal_id = $1 and command_scope = $2 and command_id = $3`,
      [seen.principalId, seen.commandScope, seen.commandId]);
    const afterFirst = await readRow();

    assert.equal(await purgeExpired(1), 0);
    const afterSecond = await readRow();
    assert.deepEqual(afterSecond.rows[0], afterFirst.rows[0]);
    assert.equal(afterSecond.rows[0]!.compact_claim, true);
    assert.equal(afterSecond.rows[0]!.result_bytes, null);
    assert.equal(afterSecond.rows[0]!.result_purged_at !== null, true);
    assert.match(afterSecond.rows[0]!.result_digest, /^[0-9a-f]{64}$/);
  });

  test('unexpired completed and in-progress receipts are never purge candidates', async () => {
    const unexpired = binding();
    const unexpiredFingerprint = fingerprint({ title: 'Unexpired' });
    const inProgress = binding();
    const expired = binding();
    const expiredFingerprint = fingerprint({ title: 'Expired' });
    await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
      const receipts = createProductCommandReceiptPort(transaction);
      await receipts.claim(unexpired, unexpiredFingerprint);
      await receipts.complete(unexpired, unexpiredFingerprint, result());
      await receipts.claim(inProgress, fingerprint({ title: 'In progress' }));
      await receipts.claim(expired, expiredFingerprint);
      await receipts.complete(expired, expiredFingerprint, result());
    });
    await ageReceipt(expired);

    // Only the genuinely expired row is compacted; the completed-but-unexpired row
    // (result_expires_at = now + 30 days from complete()) and the in-progress row
    // (completed_at IS NULL) are skipped even though the limit is 10.
    assert.equal(await purgeExpired(10), 1);

    const rows = await runtime.pool.query<{
      principal_id: string; completed: boolean; compact_claim: boolean;
      has_bytes: boolean; purged_at: boolean;
    }>(`select principal_id,
         completed_at is not null as completed, compact_claim,
         result_bytes is not null as has_bytes, result_purged_at is not null as purged_at
       from product_command_receipts
       where principal_id = any($1::text[])`,
    [[unexpired.principalId, inProgress.principalId, expired.principalId]]);
    const byPrincipal = new Map(rows.rows.map((row) => [row.principal_id, row]));
    assert.deepEqual(byPrincipal.get(unexpired.principalId), {
      principal_id: unexpired.principalId, completed: true, compact_claim: false,
      has_bytes: true, purged_at: false,
    });
    assert.deepEqual(byPrincipal.get(inProgress.principalId), {
      principal_id: inProgress.principalId, completed: false, compact_claim: false,
      has_bytes: false, purged_at: false,
    });
    assert.deepEqual(byPrincipal.get(expired.principalId), {
      principal_id: expired.principalId, completed: true, compact_claim: true,
      has_bytes: false, purged_at: true,
    });
  });

  test('compaction preserves result_digest so replay is expired and reuse stays rejected', async () => {
    const seen = binding();
    const seenFingerprint = fingerprint();
    const stored = result();
    await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
      const receipts = createProductCommandReceiptPort(transaction);
      await receipts.claim(seen, seenFingerprint);
      await receipts.complete(seen, seenFingerprint, stored);
    });
    await ageReceipt(seen);

    assert.equal(await purgeExpired(1), 1);
    const row = await runtime.pool.query<{
      result_digest: string; compact_claim: boolean; result_bytes: Buffer | null;
      result_purged_at: Date | null; completed_at: Date | null;
    }>(`select result_digest, compact_claim, result_bytes, result_purged_at, completed_at
       from product_command_receipts
       where principal_id = $1 and command_scope = $2 and command_id = $3`,
    [seen.principalId, seen.commandScope, seen.commandId]);
    assert.equal(row.rows[0]!.compact_claim, true);
    assert.equal(row.rows[0]!.result_bytes, null);
    assert.equal(row.rows[0]!.result_purged_at !== null, true);
    assert.equal(row.rows[0]!.completed_at !== null, true);
    assert.equal(row.rows[0]!.result_digest,
      createHash('sha256').update(Buffer.from(stored.body)).digest('hex'));

    const expired = await claim(seen, seenFingerprint);
    assert.equal(expired.kind, 'expired');
    if (expired.kind === 'expired') {
      assert.equal(expired.resultDigest, row.rows[0]!.result_digest);
    }
    assert.equal((await claim(seen, fingerprint({ title: 'Changed' }))).kind, 'reused');
  });

  test('onPurged receives the exact purged count including zero', async () => {
    const prefix = `callback-${randomUUID().replaceAll('-', '_')}`;
    await seedCompletedReceipts(3, {
      principalPrefix: prefix, completedAtAgeDays: '31 days', expiresAtOffset: '-1 seconds',
    });
    const reported: number[] = [];
    const purge = (limit: number) => createUnitOfWork(runtime.db).execute(({ transaction }) =>
      createProductCommandReceiptPort(transaction).purgeExpired({
        limit,
        onPurged: (count) => { reported.push(count); },
      }));

    assert.equal(await purge(2), 2);
    assert.deepEqual(reported, [2]);
    assert.equal(await purge(2), 1);
    assert.deepEqual(reported, [2, 1]);
    assert.equal(await purge(10), 0);
    assert.deepEqual(reported, [2, 1, 0]);
  });

  test('a fault after the UPDATE rolls back the entire purge and leaves the row intact', async () => {
    const seen = binding();
    const seenFingerprint = fingerprint();
    await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
      const receipts = createProductCommandReceiptPort(transaction);
      await receipts.claim(seen, seenFingerprint);
      await receipts.complete(seen, seenFingerprint, result());
    });
    await ageReceipt(seen);

    await assert.rejects(
      createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
        const receipts = createProductCommandReceiptPort(transaction);
        await receipts.purgeExpired({
          limit: 1,
          onPurged() { throw new Error('purge callback fault'); },
        });
      }),
      /purge callback fault/,
    );

    const state = await runtime.pool.query<{
      has_bytes: boolean; compact_claim: boolean; purged_at: boolean; digest: string;
    }>(`select result_bytes is not null as has_bytes, compact_claim,
         result_purged_at is not null as purged_at, result_digest as digest
       from product_command_receipts
       where principal_id = $1 and command_scope = $2 and command_id = $3`,
    [seen.principalId, seen.commandScope, seen.commandId]);
    assert.equal(state.rows[0]!.has_bytes, true);
    assert.equal(state.rows[0]!.compact_claim, false);
    assert.equal(state.rows[0]!.purged_at, false);
    assert.match(state.rows[0]!.digest, /^[0-9a-f]{64}$/);

    assert.equal(await purgeExpired(1), 1);
  });

  test('two concurrent purgers partition the batch via FOR UPDATE SKIP LOCKED and never double-compact', async () => {
    const prefix = `concurrent-${randomUUID().replaceAll('-', '_')}`;
    await seedCompletedReceipts(100, {
      principalPrefix: prefix, completedAtAgeDays: '31 days', expiresAtOffset: '-1 seconds',
    });

    // Barrier fixes the interleaving: purger A runs its candidate CTE + UPDATE and
    // then holds its 50 locked rows open (afterCallbackBeforeCommit runs before the
    // unit-of-work COMMIT) while purger B runs. B's FOR UPDATE SKIP LOCKED scan must
    // skip A's locked rows and compact the other 50. On the old SELECT + per-row
    // UPDATE implementation B's UPDATEs block on A's locks, so the 15s watchdog
    // fails the test instead of hanging CI.
    const aAtBarrier = deferred();
    const releaseA = deferred();
    let aResult = -1;
    let aError: unknown;
    const aPromise = createUnitOfWork(runtime.db, {
      faultInjector: {
        afterCallbackBeforeCommit: async () => {
          aAtBarrier.resolve();
          await releaseA.promise;
        },
      },
    }).execute(async ({ transaction }) => {
      aResult = await createProductCommandReceiptPort(transaction).purgeExpired({ limit: 50 });
    }).catch((error) => { aError = error; });

    // If the first purger never reaches the post-UPDATE barrier, fail the test
    // instead of hanging; release the barrier either way so no connection leaks.
    let barrierWatchdog: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      aAtBarrier.promise,
      new Promise<never>((_resolve, reject) => {
        barrierWatchdog = setTimeout(() => {
          releaseA.resolve();
          reject(new Error('first purger never reached the post-UPDATE barrier'));
        }, 15_000);
      }),
    ]);
    if (barrierWatchdog !== undefined) clearTimeout(barrierWatchdog);

    let bResult = -1;
    let bTimedOut = false;
    let bError: unknown;
    const bPromise = createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
      bResult = await createProductCommandReceiptPort(transaction).purgeExpired({ limit: 50 });
    });
    const watchdog = setTimeout(() => {
      bTimedOut = true;
      releaseA.resolve();
    }, 15_000);
    try {
      await bPromise;
    } catch (error) {
      bError = error;
    } finally {
      clearTimeout(watchdog);
      releaseA.resolve();
    }
    await aPromise;
    if (aError !== undefined) throw aError;
    if (bError !== undefined) throw bError;

    assert.equal(bTimedOut, false, 'second purger blocked behind the first (FOR UPDATE SKIP LOCKED missing)');
    assert.equal(aResult, 50);
    assert.equal(bResult, 50);
    assert.equal(aResult + bResult, 100);

    const compacted = await runtime.pool.query<{ compacted: string; intact: string }>(
      `select
         count(*) filter (where compact_claim and result_bytes is null)::text as compacted,
         count(*) filter (where not compact_claim and result_bytes is not null)::text as intact
       from product_command_receipts where principal_id like $1`, [`${prefix}-%`]);
    assert.deepEqual(compacted.rows[0], { compacted: '100', intact: '0' });
  }, 60_000);

  test('purge emits exactly one candidate CTE + UPDATE statement for N=1 and N=1000', async () => {
    const prefix = `statements-${randomUUID().replaceAll('-', '_')}`;
    await seedCompletedReceipts(1_000, {
      principalPrefix: prefix, completedAtAgeDays: '31 days', expiresAtOffset: '-1 seconds',
    });

    const baseExecutor = runtime.db.getExecutor();
    const capturedQueries: string[] = [];
    const countedDb = runtime.db.withPlugin({
      transformQuery(args) {
        capturedQueries.push(baseExecutor.compileQuery(args.node, args.queryId).sql);
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });

    const runPurge = async (limit: number) => {
      capturedQueries.length = 0;
      const count = await createUnitOfWork(countedDb).execute(({ transaction }) =>
        createProductCommandReceiptPort(transaction).purgeExpired({ limit }));
      return { count, statements: [...capturedQueries] };
    };

    const small = await runPurge(1);
    const large = await runPurge(1_000);
    assert.equal(small.count, 1);
    assert.equal(large.count, 999);

    // The purge is a single SQL statement regardless of N, so the statement delta
    // between N=1 and N=1000 is constant (zero).
    assert.equal(large.statements.length, small.statements.length);
    const updateStatements = (statements: string[]) => statements.filter((statement) =>
      /UPDATE product_command_receipts/u.test(statement));
    assert.equal(updateStatements(small.statements).length, 1);
    assert.equal(updateStatements(large.statements).length, 1);
    const singleStatement = updateStatements(large.statements)[0]!;
    assert.match(singleStatement, /WITH candidates AS/u);
    assert.match(singleStatement, /FOR UPDATE SKIP LOCKED/u);
    assert.match(singleStatement, /LIMIT \$1/u);
    assert.match(singleStatement, /UPDATE product_command_receipts receipt/u);
    assert.match(singleStatement, /FROM candidates/u);
    assert.match(singleStatement, /result_purged_at = current_timestamp/u);
    assert.match(singleStatement, /compact_claim = true/u);
    assert.match(singleStatement, /RETURNING/u);
    assert.equal(singleStatement, updateStatements(small.statements)[0]);
  }, 60_000);

  test('the purge candidates scan is served by the partial expiry index at production scale', async () => {
    const prefix = `plan-${randomUUID().replaceAll('-', '_')}`;
    // 10,000 unexpired full-result rows (expires 1 day from now, completed 31 days
    // ago to satisfy the retention constraint) keep the planner honest, plus 50
    // genuinely expired candidates.
    await seedCompletedReceipts(10_000, {
      principalPrefix: `${prefix}-live`, completedAtAgeDays: '31 days', expiresAtOffset: '1 day',
    });
    await seedCompletedReceipts(50, {
      principalPrefix: `${prefix}-expired`, completedAtAgeDays: '31 days', expiresAtOffset: '-1 seconds',
    });
    await runtime.pool.query('analyze product_command_receipts');

    const plan = await runtime.pool.query<{ 'QUERY PLAN': string }>(`explain
      select principal_id, command_scope, command_id
      from product_command_receipts
      where completed_at is not null
        and result_expires_at <= current_timestamp
        and result_bytes is not null
      order by result_expires_at
      for update skip locked
      limit 1`);
    const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
    assert.match(text, /product_command_receipt_expiry_idx/u);
    assert.doesNotMatch(text, /Seq Scan/u);

    // Drain the expired batch and prove no expired candidate rows remain anywhere.
    const drained = await purgeExpired(100);
    assert.ok(drained >= 50, `expected at least 50 drained, got ${drained}`);
    const leftover = await runtime.pool.query<{ count: string }>(
      'select count(*)::text as count from product_command_receipts where result_expires_at <= current_timestamp and result_bytes is not null');
    assert.equal(leftover.rows[0]!.count, '0');
  }, 120_000);
});
