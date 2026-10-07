/**
 * P4A-I15 PostgreSQL integration suite: the durable admission switch.
 *
 * Proves, against real PostgreSQL (production migration chain to latest):
 *  - stopAdmissionAndDrain writes a durable switch row (admission disabled +
 *    drain + lease facts) observed across a second connection AND a second
 *    process (new runtime over the same schema), closes the issuance gate, and
 *    resumeAdmission restores it — never by killing a process to guess state;
 *  - lease fencing: a second operator cannot stop or resume while the lease is
 *    active, and can take over only after the lease expires;
 *  - verification DRAINS while admission is stopped: the production outbox
 *    worker completes the seeded verification events and the switch stays
 *    stopped (drain does not auto-resume);
 *  - N/N-1 readiness facts: a stopped admission switch degrades only the API
 *    component while worker/delivery stay ready (partial failure never drags
 *    unrelated readiness down).
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createPostgresAccessPolicyFactsPort,
} from '../../../src/infrastructure/access-policy/index.js';
import { createDatabaseRuntime, createPostgresAttachmentsAdmissionSwitchStore, createPostgresAttachmentsPorts, createUnitOfWork, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/index.js';
import {
  EventEnvelopeRegistry,
  OutboxRouter,
  PostgresOutboxRepository,
  VersionedOutboxWorker,
  appendAttachmentsVerificationOutbox,
  attachmentsVerificationEnvelopeRegistration,
  createAttachmentsVerificationOutboxRoute,
  createExponentialRetryPolicy,
  type OutboxWorkerLogger,
} from '../../../src/infrastructure/outbox/index.js';
import {
  admissionAllowsIssuance,
  completeUpload,
  evaluateAttachmentsCapabilityReadiness,
  issueUploadIntentWithAdmissionGate,
  nodeUploadIntentCrypto,
  readAdmissionState,
  resumeAdmission,
  stopAdmissionAndDrain,
  type AttachmentsReadinessFacts,
  type CompleteUploadDeps,
  type IssueUploadIntentDeps,
} from '../../../src/modules/attachments/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import {
  I08_COLLECTION,
  I08_SUBJECT,
  RecordingGrantStore,
  makeActor,
  makeI08Config,
} from '../../support/phase4a-i08-test-helpers.js';
import {
  InMemoryVerificationObjectStore,
  allocateInput,
  expectedDigest,
  identityFor as i09IdentityFor,
  makeActor as makeI09Actor,
  makeI09Config,
  sha256HexBytes,
} from '../../support/phase4a-i09-test-helpers.js';

const PORTS = createPostgresAttachmentsPorts();
const ISSUE_CONFIG = makeI08Config();
const VERIFY_CONFIG = makeI09Config();
const ACTOR = makeActor();
const workerLogger: OutboxWorkerLogger = { info: () => {}, warn: () => {}, error: () => {} };

function pngBody(bytes = 16): Uint8Array {
  const body = new Uint8Array(bytes);
  body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < body.length; index += 1) body[index] = index % 251;
  return body;
}

async function seedPolicyCollection(runtime: I07MigrationRuntime['runtime']): Promise<void> {
  const collectionId = I08_COLLECTION;
  const ownerSubjectId = I08_SUBJECT;
  const rootId = `${collectionId}-root`;
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
      values (${collectionId}, ${ownerSubjectId}, 'I15 collection', 'bookmarks', ${rootId},
        ${`resource-${collectionId}`}, ${`content-${collectionId}`}, 'policy-r1', 'private', 1, now(), now(), null)
    `.execute(transaction);
    await sql`
      insert into nodes
        (id, collection_id, kind, is_root, title, resource_revision, children_revision, deleted_at)
      values (${rootId}, ${collectionId}, 'folder', true, 'Root', 'r1', 'ch1', null)
    `.execute(transaction);
  });
  await runtime.pool.query(
    'insert into collection_members (collection_id, subject_id, role, granted_at) values ($1, $2, $3, now())',
    [collectionId, ownerSubjectId, 'owner'],
  );
}

function issueInput(idempotencyKey: string) {
  return {
    actor: ACTOR,
    collectionId: I08_COLLECTION,
    idempotencyKey,
    declaredSize: 2048,
    declaredSha256: 'a'.repeat(64),
    mediaHint: 'image/png',
  };
}

function makeIssueDeps(runtime: I07MigrationRuntime['runtime'], store: RecordingGrantStore): IssueUploadIntentDeps<DatabaseTransaction> {
  return {
    ledger: createPostgresAttachmentsPorts(),
    accessPolicyFor: (transaction) => createPostgresAccessPolicyFactsPort(transaction),
    blobStore: store,
    uow: createUnitOfWork(runtime.db),
    crypto: nodeUploadIntentCrypto,
    config: ISSUE_CONFIG,
    now: () => new Date('2026-08-08T12:00:00.000Z'),
  };
}

async function seedUploaded(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof i09IdentityFor>,
  body: Uint8Array,
): Promise<InMemoryVerificationObjectStore> {
  await createUnitOfWork(runtime.db).execute(({ transaction }) =>
    PORTS.allocate(transaction, allocateInput(id, {
      expectedSize: body.byteLength,
      expectedSha256: sha256HexBytes(body),
      mediaHint: 'image/png',
    })));
  const store = new InMemoryVerificationObjectStore();
  store.seed(id.key, body, { etag: `"etag-${id.generationId}"` });
  const deps: CompleteUploadDeps<DatabaseTransaction> = {
    ledger: PORTS,
    blobStore: store,
    uow: createUnitOfWork(runtime.db),
    enqueueVerification: (tx, payload) => appendAttachmentsVerificationOutbox(tx, payload),
    config: VERIFY_CONFIG,
  };
  const result = await completeUpload(deps, {
    actor: makeI09Actor(),
    binding: { intentId: id.intentId, generationId: id.generationId, blobId: id.blobId },
    declared: {
      size: body.byteLength,
      sha256: sha256HexBytes(body),
      mediaType: 'image/png',
      etag: `"etag-${id.generationId}"`,
    },
  });
  assert.equal(result.outcome, 'completed');
  return store;
}

async function outboxFacts(runtime: I07MigrationRuntime['runtime']): Promise<{ pending: number; completed: number }> {
  const rows = await sql<{ state: string; count: string }>`
    select state, count(*)::text as count from outbox_events
    where handler_name = 'attachments_verify_generation'
    group by state
  `.execute(runtime.db);
  const pending = rows.rows.filter((row) => row.state !== 'completed')
    .reduce((sum, row) => sum + Number(row.count), 0);
  const completed = rows.rows.filter((row) => row.state === 'completed')
    .reduce((sum, row) => sum + Number(row.count), 0);
  return { pending, completed };
}

describeWithPostgres('P4A-I15 durable admission switch', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('i15_admission', { maxConnections: 14 });
    await seedPolicyCollection(isolated.runtime);
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('stop is durable across connections and processes; the gate closes and resume restores it', async () => {
    const store = createPostgresAttachmentsAdmissionSwitchStore(isolated.runtime);
    const deps = { store, now: () => new Date('2026-08-08T12:00:00.000Z') };

    // Before stop, issuance through the gated production use case succeeds.
    const grantStore = new RecordingGrantStore();
    const gatedDeps = { ...makeIssueDeps(isolated.runtime, grantStore), admissionState: async () => readAdmissionState(deps) };
    const before = await issueUploadIntentWithAdmissionGate(gatedDeps, issueInput('idem-before-stop'));
    assert.equal(before.outcome, 'issued');
    const intentCount = async () => Number((await sql<{ count: string }>`select count(*)::text as count from upload_intents`.execute(isolated.runtime.db)).rows[0]!.count);

    const stopped = await stopAdmissionAndDrain(deps, { reason: 'rotation', operatorId: 'operator-a', leaseTtlSeconds: 60 });
    assert.equal(stopped.outcome, 'stopped');
    if (stopped.outcome !== 'stopped') return;
    assert.equal(stopped.state.admissionEnabled, false);
    assert.equal(stopped.state.drainVerification, true);
    assert.equal(stopped.state.leaseOwner, 'operator-a');
    assert.equal(admissionAllowsIssuance(stopped.state), false);

    // A second connection observes the same durable row.
    const secondStore = createPostgresAttachmentsAdmissionSwitchStore(isolated.runtime);
    const reread = await readAdmissionState({ store: secondStore, now: deps.now });
    assert.equal(reread.admissionEnabled, false, 'the switch must be durable across connections');

    // A second PROCESS (new runtime over the same schema) observes the same row.
    const secondProcess = createDatabaseRuntime(isolated.databaseUrl, {
      maxConnections: 2, applicationName: 'i15-second-process', connectionTimeoutMs: 5_000, idleTimeoutMs: 1_000,
    });
    try {
      const processStore = createPostgresAttachmentsAdmissionSwitchStore(secondProcess);
      const processState = await readAdmissionState({ store: processStore, now: deps.now });
      assert.equal(processState.admissionEnabled, false, 'the switch must be durable across processes');
    } finally {
      await secondProcess.close();
    }

    // While stopped, the gated production use case refuses BEFORE any ledger work.
    const refused = await issueUploadIntentWithAdmissionGate(gatedDeps, issueInput('idem-during-stop'));
    assert.deepEqual(refused, { outcome: 'admission_stopped' });
    assert.equal(await intentCount(), 1, 'no new upload_intents may be created while stopped');

    // Resume restores the gate.
    const resumed = await resumeAdmission(deps, { operatorId: 'operator-a' });
    assert.equal(resumed.outcome, 'resumed');
    if (resumed.outcome !== 'resumed') return;
    assert.equal(resumed.state.admissionEnabled, true);
    assert.equal(admissionAllowsIssuance(resumed.state), true);
    const after = await issueUploadIntentWithAdmissionGate(gatedDeps, issueInput('idem-after-resume'));
    assert.equal(after.outcome, 'issued');
    assert.equal(await intentCount(), 2, 'issuance must resume after restore');
  });

  test('lease fencing: a second operator cannot stop or resume while the lease is active; takeover after expiry', async () => {
    const store = createPostgresAttachmentsAdmissionSwitchStore(isolated.runtime);
    const deps = { store, now: () => new Date('2026-08-08T12:00:00.000Z') };
    const stoppedByA = await stopAdmissionAndDrain(deps, { reason: 'incident', operatorId: 'operator-a', leaseTtlSeconds: 60 });
    assert.equal(stoppedByA.outcome, 'stopped');
    const generationBeforeTakeover = stoppedByA.outcome === 'stopped' ? stoppedByA.state.leaseGeneration : '0';

    const blockedStop = await stopAdmissionAndDrain(deps, { reason: 'incident', operatorId: 'operator-b', leaseTtlSeconds: 60 });
    assert.equal(blockedStop.outcome, 'lease_conflict');
    const blockedResume = await resumeAdmission(deps, { operatorId: 'operator-b' });
    assert.equal(blockedResume.outcome, 'lease_conflict');

    // Lease expiry -> operator-b can take over (lease generation bumped).
    await isolated.runtime.pool.query(
      `update attachments_operations_switch set lease_expires_at = $1::timestamptz`,
      [new Date(deps.now().getTime() - 1_000).toISOString()],
    );
    const takeover = await stopAdmissionAndDrain(deps, { reason: 'incident', operatorId: 'operator-b', leaseTtlSeconds: 60 });
    assert.equal(takeover.outcome, 'stopped');
    if (takeover.outcome !== 'stopped') return;
    assert.equal(takeover.state.leaseOwner, 'operator-b');
    assert.equal(takeover.state.leaseGeneration, String(BigInt(generationBeforeTakeover) + 1n), 'takeover must bump the lease generation');
  });

  test('verification drains while admission is stopped (outbox facts) and the switch stays stopped', async () => {
    const ids = [i09IdentityFor(21), i09IdentityFor(22)];
    const bodies = [pngBody(17), pngBody(19)];
    const store = new InMemoryVerificationObjectStore();
    for (let index = 0; index < ids.length; index += 1) {
      const seeded = await seedUploaded(isolated.runtime, ids[index]!, bodies[index]!);
      store.seed(ids[index]!.key, bodies[index]!, { etag: `"etag-${ids[index]!.generationId}"` });
      assert.equal(seeded.objects.size, 1);
    }
    const switchStore = createPostgresAttachmentsAdmissionSwitchStore(isolated.runtime);
    const deps = { store: switchStore, now: () => new Date('2026-08-08T12:00:00.000Z') };
    await stopAdmissionAndDrain(deps, { reason: 'maintenance', operatorId: 'operator-a', leaseTtlSeconds: 60 });

    const route = createAttachmentsVerificationOutboxRoute({
      repository: PORTS, blobStore: store, uow: createUnitOfWork(isolated.runtime.db), config: VERIFY_CONFIG,
    });
    const repository = new PostgresOutboxRepository(isolated.runtime.pool);
    const worker = new VersionedOutboxWorker({
      repository,
      router: new OutboxRouter([route]),
      envelopes: new EventEnvelopeRegistry([attachmentsVerificationEnvelopeRegistration]),
      logger: workerLogger,
      leaseDurationMs: 5_000, heartbeatIntervalMs: 1_000, handlerTimeoutMs: 3_000,
      maxConcurrentHandlers: 1, batchSize: 1, pollIntervalMs: 10,
      retryPolicy: createExponentialRetryPolicy({ baseDelayMs: 10, maxDelayMs: 50, maxAttempts: 5, jitterRatio: 0 }),
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const worked = await worker.runOnce();
      if (!worked) break;
    }
    const facts = await outboxFacts(isolated.runtime);
    assert.equal(facts.pending, 0, 'verification must drain to completion while admission is stopped');
    assert.equal(facts.completed, 2);
    for (let index = 0; index < ids.length; index += 1) {
      const blob = await sql<{ logical_state: string; verified_sha256: string }>`
        select logical_state, verified_sha256 from blob_records where blob_id = ${ids[index]!.blobId}
      `.execute(isolated.runtime.db);
      assert.equal(blob.rows[0]!.logical_state, 'stored_private');
      assert.equal(blob.rows[0]!.verified_sha256, expectedDigest(bodies[index]!), 'verified facts must match the exact bytes');
    }
    const state = await readAdmissionState(deps);
    assert.equal(state.admissionEnabled, false, 'draining verification must not auto-resume admission');
    assert.equal(state.drainVerification, true);
  });

  test('N/N-1 readiness facts: a stopped admission switch degrades only the API component', async () => {
    const switchStore = createPostgresAttachmentsAdmissionSwitchStore(isolated.runtime);
    const deps = { store: switchStore, now: () => new Date('2026-08-08T12:00:00.000Z') };
    await stopAdmissionAndDrain(deps, { reason: 'rotation', operatorId: 'operator-a', leaseTtlSeconds: 60 });
    const state = await readAdmissionState(deps);
    const facts: AttachmentsReadinessFacts = {
      admission: { enabled: state.admissionEnabled },
      worker: { verificationBacklog: 0, cleanupBacklog: 0 },
      delivery: { hostAvailable: true },
    };
    const readiness = evaluateAttachmentsCapabilityReadiness(ISSUE_CONFIG, facts);
    assert.equal(readiness.status, 'degraded', 'a stopped switch degrades the capability, not the global API');
    assert.equal(readiness.components?.api.status, 'degraded');
    assert.equal(readiness.components?.worker.status, 'ready', 'worker/delivery readiness must not be dragged down');
    assert.equal(readiness.components?.delivery.status, 'ready');
  });
});
