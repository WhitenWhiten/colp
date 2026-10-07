/**
 * Shared helpers for the P4A-R04 focused suites (plan §6 P4A-R04). This file
 * is not a test file: it matches no vitest test pattern and is never listed
 * in a focused config.
 *
 * Provides:
 * - deterministic R04 generation identities and the production-shaped
 *   attachments config (cleanup boundary: retiredRetentionDays=0 so a
 *   just-retired generation is claimable through the PRODUCTION coordinator);
 * - an in-memory generation object store with explicit etag/size/bytes, call
 *   logs and `expectedEtag` support (so claim snapshots match exactly), and
 *   the streamed reads the production verification worker route needs;
 * - the response-loss decorator: a cleanup adapter decorator that loses the
 *   provider response BEFORE or AFTER the real DELETE/HEAD side effect, or
 *   fabricates a HEAD identity inconsistent with the ledger — the R04
 *   corruption at the provider boundary (the inner store is always the real
 *   production port surface: real R2 in the I16 run, this store in the
 *   focused suites);
 * - production-port seeds: retired+active pair (allocate -> complete ->
 *   activateReplacement -> retired, DB-clock retention), three-way
 *   replacement candidates, and stored_private with a retired current (via
 *   the production verification outbox route), plus DB-row re-reads,
 *   DB-clock cleanup-lease expiry and a NEW-pool reopen for the cleanup
 *   process restart (never test SQL that rewrites the lease owner).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDatabaseRuntime, createPostgresAttachmentsPorts, createUnitOfWork } from '../../src/infrastructure/database/index.js';
import type { DatabaseRuntime, DatabaseTransaction } from '../../src/infrastructure/database/index.js';
import {
  PostgresOutboxRepository,
  appendAttachmentsVerificationOutbox,
  createAttachmentsVerificationOutboxRoute,
  type ClosedPayload,
  type OutboxClaim,
  type VersionedEventEnvelope,
} from '../../src/infrastructure/outbox/index.js';
import type {
  AllocateGenerationInput,
  AttachmentsFeatureConfig,
  GenerationObjectHandle,
  GenerationObjectStorePort,
  GenerationReadOptions,
  GenerationReadOutcome,
} from '../../src/modules/attachments/index.js';
import type { ActorPrincipal } from '../../src/modules/access-policy/index.js';
import {
  R04ResponseLossStore,
  type R04DeleteCorruption,
  type R04HeadCorruption,
} from '../../scripts/evidence/phase4a-r04-controls.js';

export { R04ResponseLossStore };
export type { R04DeleteCorruption, R04HeadCorruption };


export const R04_SUBJECT = 'r04-subject-owner';
export const R04_PRINCIPAL = 'r04-principal';
export const R04_COLLECTION = 'r04-collection';
export const R04_BUCKET = 'known-r04-production';
export const R04_LIVE_PREFIX = 'attachments/live/';
/** Must equal ATTACHMENTS_VERIFICATION_POLICY_VERSION (the worker writes it). */
export const R04_POLICY_VERSION = 'phase4a-i09-policy-v1';

export function sha256HexBytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function r04UuidFor(n: number | string): string {
  return `018f6f7a-8f2a-7a3d-a123-123456789${String(n).padStart(3, '0')}`;
}

export interface R04Identity {
  readonly blobId: string;
  readonly intentId: string;
  readonly generationId: string;
  readonly key: string;
  readonly fingerprint: string;
}

/** Deterministic generation identity for a numbered fixture slot. */
export function identityFor(n: number): R04Identity {
  const blobId = r04UuidFor(1000 + n);
  const intentId = r04UuidFor(2000 + n);
  const generationId = r04UuidFor(3000 + n);
  const key = `${R04_LIVE_PREFIX}${r04UuidFor(4000 + n)}`;
  return { blobId, intentId, generationId, key, fingerprint: sha256HexBytes(key) };
}

/** Normalizes a generation identity onto the blob that OWNS it. */
export function onBlob(blobId: string, id: R04Identity): R04Identity {
  return { ...id, blobId };
}

export function makeActor(): ActorPrincipal {
  return { principalId: R04_PRINCIPAL, subjectId: R04_SUBJECT, kind: 'account' };
}

export function makeR04Config(overrides: Partial<AttachmentsFeatureConfig> = {}): AttachmentsFeatureConfig {
  const base: AttachmentsFeatureConfig = {
    enabled: true,
    r2: {
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: R04_BUCKET,
      livePrefix: R04_LIVE_PREFIX,
      probePrefix: 'attachments/probe/',
      rwSecretRef: 'known/r2/rw/primary',
      roSecretRef: 'known/r2/ro/primary',
    },
    grantTtlSeconds: 60,
    singlePutMaxBytes: 5 * 1024 * 1024,
    allowedMedia: ['image/png', 'application/pdf', 'text/plain', 'application/octet-stream'],
    verification: { leaseMs: 60_000, timeoutMs: 15_000, retryCount: 2 },
    retention: { intentRetentionHours: 24, storedRetentionDays: 30, retiredRetentionDays: 90 },
    cleanupBatchSize: 10,
    // Deterministic provider call counts: unknown outcomes are never
    // in-process retried (the restart/lease-takeover converges instead).
    cleanup: { leaseMs: 60_000, retryCount: 0 },
    isolatedDeliveryOrigin: 'https://delivery.known.test',
    deliveryCapabilitySecretRef: 'known/delivery/hmac/primary',
    deliveryCapabilityTtlSeconds: 60,
  };
  return Object.freeze({ ...base, ...overrides, r2: { ...base.r2, ...overrides.r2 } });
}

/** Cleanup-boundary config: retention already satisfied at the DB clock
 * (days=0), so a just-retired generation is claimable through the PRODUCTION
 * coordinator without any test SQL state manufacturing. */
export function r04CleanupBoundaryConfig(config: AttachmentsFeatureConfig): AttachmentsFeatureConfig {
  return Object.freeze({
    ...config,
    retention: Object.freeze({ ...config.retention, retiredRetentionDays: 0 }),
  });
}

export function r04AllocateInput(
  id: R04Identity,
  body: Uint8Array,
  overrides: Partial<AllocateGenerationInput> = {},
): AllocateGenerationInput {
  return {
    blobId: id.blobId,
    intentId: id.intentId,
    generationId: id.generationId,
    principalId: R04_PRINCIPAL,
    collectionId: R04_COLLECTION,
    subjectIdentity: R04_SUBJECT,
    bucket: R04_BUCKET,
    key: id.key,
    keyFingerprint: id.fingerprint,
    expectedSize: body.byteLength,
    expectedSha256: sha256HexBytes(body),
    mediaHint: 'application/octet-stream',
    policyRevision: R04_POLICY_VERSION,
    idempotencyKey: `r04-idem-${id.intentId}`,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory generation object store (explicit identities + call logs)
// ---------------------------------------------------------------------------

interface R04StoredObject {
  etag: string;
  size: number;
  bytes: Uint8Array;
}

/**
 * In-memory generation object store with explicit etag/size (the claim
 * snapshot matches exactly), full call logs ("the mismatch sent NO DELETE"
 * and "only the exact retired key was deleted" are provable), `expectedEtag`
 * conditional heads and the streamed reads the production verification route
 * needs. Every HEAD/DELETE is recorded with the exact handle.
 */
export class R04ObjectStore implements GenerationObjectStorePort {
  readonly objects = new Map<string, R04StoredObject>();
  readonly headCalls: GenerationObjectHandle[] = [];
  readonly deleteCalls: GenerationObjectHandle[] = [];

  seed(key: string, bytes: Uint8Array, etag?: string): string {
    const resolved = etag ?? `"etag-${sha256HexBytes(key).slice(0, 16)}"`;
    this.objects.set(key, { etag: resolved, size: bytes.byteLength, bytes });
    return resolved;
  }

  etagOf(key: string): string | undefined {
    return this.objects.get(key)?.etag;
  }

  bytesOf(key: string): Uint8Array | undefined {
    return this.objects.get(key)?.bytes;
  }

  deleteCountFor(key: string): number {
    return this.deleteCalls.filter((call) => call.key === key).length;
  }

  headCountFor(key: string): number {
    return this.headCalls.filter((call) => call.key === key).length;
  }

  async headExact(
    handle: GenerationObjectHandle,
    options: { readonly expectedEtag?: string; readonly signal?: AbortSignal } = {},
  ): Promise<import('../../src/modules/attachments/index.js').GenerationHeadOutcome> {
    this.headCalls.push(handle);
    const object = this.objects.get(handle.key);
    if (!object) return { class: 'not_found' };
    if (options.expectedEtag !== undefined && options.expectedEtag !== object.etag) {
      return { class: 'etag_mismatch' };
    }
    return {
      class: 'ok',
      identity: { generationId: handle.generationId, size: object.size, etag: object.etag, metadata: {} },
    };
  }

  async readBounded(handle: GenerationObjectHandle, options: GenerationReadOptions): Promise<GenerationReadOutcome> {
    const object = this.objects.get(handle.key);
    if (!object) return { class: 'not_found' };
    if (options.expectedEtag !== object.etag) return { class: 'etag_mismatch' };
    if (object.size > options.byteCeiling) return { class: 'overflow', byteCeiling: options.byteCeiling };
    const bytes = object.bytes;
    const stream = (async function* r04Stream(): AsyncGenerator<Uint8Array> {
      yield bytes;
    })();
    return {
      class: 'ok',
      identity: { generationId: handle.generationId, size: object.size, etag: object.etag, metadata: {} },
      stream,
    };
  }

  async deleteExact(handle: GenerationObjectHandle): Promise<import('../../src/modules/attachments/index.js').GenerationDeleteOutcome> {
    this.deleteCalls.push(handle);
    if (!this.objects.has(handle.key)) return { class: 'not_found' };
    this.objects.delete(handle.key);
    return { class: 'deleted' };
  }

  async confirmAbsent(handle: GenerationObjectHandle): Promise<{ readonly absent: boolean }> {
    const head = await this.headExact(handle);
    return { absent: head.class === 'not_found' };
  }
}

// ---------------------------------------------------------------------------
// Response-loss cleanup adapter decorator (R04 provider-boundary corruption)
//
// The decorator itself lives in the in-run control implementation
// (`phase4a-r04-controls.ts`) so the focused suites exercise the EXACT same
// corruption the I16 run installs over the real R2 adapter. It is re-exported
// here for the suites.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Production-port seeds (all attachment state through public ports; the only
// SQL is DB-clock retention/lease backdating, never state manufacturing)
// ---------------------------------------------------------------------------

const ports = createPostgresAttachmentsPorts();

export interface R04SeededPair {
  readonly blobId: string;
  readonly old: R04Identity;
  readonly next: R04Identity;
  readonly bodyOld: Uint8Array;
  readonly bodyNext: Uint8Array;
  readonly etagOld: string;
  readonly etagNext: string;
}

/**
 * Seeds a blob whose CURRENT generation is `next` (active) while `old` is a
 * RETIRED generation on the same blob (cleanup-claimable with the
 * cleanup-boundary config). The retired and active keys hold DIFFERENT real
 * markers; the claim snapshot (etag/size) equals the store identity exactly.
 */
export async function seedRetiredActivePair(
  runtime: DatabaseRuntime,
  store: R04ObjectStore,
  old: R04Identity,
  next: R04Identity,
): Promise<R04SeededPair> {
  const bodyOld = new TextEncoder().encode(`r04-retired-marker-${old.generationId}`);
  const bodyNext = new TextEncoder().encode(`r04-active-marker-${next.generationId}`);
  const etagOld = store.seed(old.key, bodyOld);
  const etagNext = store.seed(next.key, bodyNext);
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const allocatedOld = await ports.allocate(transaction, r04AllocateInput(old, bodyOld));
    assert.equal(allocatedOld.outcome, 'issued');
    const allocatedNext = await ports.allocate(transaction, r04AllocateInput(next, bodyNext, { blobId: old.blobId }));
    assert.equal(allocatedNext.outcome, 'issued');
    const completedOld = await ports.complete(transaction, {
      intentId: old.intentId,
      generationId: old.generationId,
      blobId: old.blobId,
      observedEtag: etagOld,
      observedSize: bodyOld.byteLength,
      observedContentType: 'application/octet-stream',
      observedMetadata: {},
    });
    assert.equal(completedOld.outcome, 'verified_active');
    const completedNext = await ports.complete(transaction, {
      intentId: next.intentId,
      generationId: next.generationId,
      blobId: old.blobId,
      observedEtag: etagNext,
      observedSize: bodyNext.byteLength,
      observedContentType: 'application/octet-stream',
      observedMetadata: {},
    });
    assert.equal(completedNext.outcome, 'verified_observed');
    const activated = await ports.activateReplacement(transaction, {
      blobId: old.blobId,
      expectedActiveGenerationId: old.generationId,
      newGenerationId: next.generationId,
    });
    assert.equal(activated.outcome, 'activated');
  });
  return { blobId: old.blobId, old, next, bodyOld, bodyNext, etagOld, etagNext };
}

/**
 * Seeds a blob with `first` ACTIVE and two OBSERVED replacement candidates
 * (`second`, `third`) on the same blob — the three-way replacement CAS race
 * input (exactly one of the two candidates can win).
 */
export async function seedReplacementRace(
  runtime: DatabaseRuntime,
  store: R04ObjectStore,
  first: R04Identity,
  second: R04Identity,
  third: R04Identity,
): Promise<{ blobId: string; first: R04Identity; second: R04Identity; third: R04Identity }> {
  const bodyFirst = new TextEncoder().encode(`r04-first-marker-${first.generationId}`);
  const bodySecond = new TextEncoder().encode(`r04-second-marker-${second.generationId}`);
  const bodyThird = new TextEncoder().encode(`r04-third-marker-${third.generationId}`);
  const etagFirst = store.seed(first.key, bodyFirst);
  store.seed(second.key, bodySecond);
  store.seed(third.key, bodyThird);
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const allocated = await ports.allocate(transaction, r04AllocateInput(first, bodyFirst));
    assert.equal(allocated.outcome, 'issued');
    const completed = await ports.complete(transaction, {
      intentId: first.intentId,
      generationId: first.generationId,
      blobId: first.blobId,
      observedEtag: etagFirst,
      observedSize: bodyFirst.byteLength,
      observedContentType: 'application/octet-stream',
      observedMetadata: {},
    });
    assert.equal(completed.outcome, 'verified_active');
    for (const candidate of [second, third]) {
      const body = candidate === second ? bodySecond : bodyThird;
      const allocatedCandidate = await ports.allocate(transaction, r04AllocateInput(candidate, body, { blobId: first.blobId }));
      assert.equal(allocatedCandidate.outcome, 'issued');
      const completedCandidate = await ports.complete(transaction, {
        intentId: candidate.intentId,
        generationId: candidate.generationId,
        blobId: first.blobId,
        observedEtag: store.etagOf(candidate.key)!,
        observedSize: body.byteLength,
        observedContentType: 'application/octet-stream',
        observedMetadata: {},
      });
      assert.equal(completedCandidate.outcome, 'verified_observed');
    }
  });
  return { blobId: first.blobId, first, second, third };
}

function verificationEnvelope(claim: OutboxClaim): VersionedEventEnvelope {
  return {
    event_id: claim.eventId,
    event_type: claim.eventType,
    event_version: claim.eventVersion,
    aggregate_identity: {
      aggregate_type: claim.aggregateType,
      aggregate_id: claim.aggregateId,
      aggregate_scope: claim.aggregateScope,
    },
    aggregate_revision: claim.aggregateRevision,
    commit_ordinal: claim.commitOrdinal,
    occurred_at: claim.occurredAt.toISOString(),
    payload: claim.payload as ClosedPayload,
  };
}

/**
 * Drives the PRODUCTION verification worker route (enqueue -> claim -> stream
 * verify -> stored_private) so the blob converges to `stored_private` with
 * the exact marker bytes — the finalize-race precondition.
 */
export async function verifyToStoredPrivate(
  runtime: DatabaseRuntime,
  store: GenerationObjectStorePort,
  id: R04Identity,
  body: Uint8Array,
  etag: string,
  config: AttachmentsFeatureConfig,
): Promise<void> {
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    await appendAttachmentsVerificationOutbox(transaction, {
      blobId: id.blobId,
      generationId: id.generationId,
      intentId: id.intentId,
    });
  });
  const repository = new PostgresOutboxRepository(runtime.pool);
  const claim = await repository.claim(30_000);
  assert.ok(claim, 'r04: verification outbox claim missing');
  const route = createAttachmentsVerificationOutboxRoute({
    repository: ports,
    blobStore: store,
    uow: createUnitOfWork(runtime.db),
    config,
  });
  await route.handle({
    envelope: verificationEnvelope(claim),
    idempotencyKey: claim.eventId,
    signal: new AbortController().signal,
    attempt: { outboxId: claim.outboxId, leaseGeneration: claim.leaseGeneration },
  });
  const completedRow = await repository.complete(claim);
  assert.ok(completedRow, 'r04: verification outbox completion missing');
  const rows = await runtime.pool.query<{ logical_state: string }>(
    'select logical_state from blob_records where blob_id = $1',
    [id.blobId],
  );
  assert.equal(rows.rows[0]?.logical_state, 'stored_private');
}

/**
 * Seeds a blob whose CURRENT generation is `current` (active, verified to
 * `stored_private` with the current marker) while `original` is RETIRED on
 * the same blob (cleanup-claimable) — the finalize winner/rollback +
 * cleanup-lease/restart race input.
 */
export async function seedStoredPrivateWithRetiredCurrent(
  runtime: DatabaseRuntime,
  store: R04ObjectStore,
  original: R04Identity,
  current: R04Identity,
  config: AttachmentsFeatureConfig,
): Promise<R04SeededPair> {
  const seeded = await seedRetiredActivePair(runtime, store, original, current);
  await verifyToStoredPrivate(runtime, store, onBlob(original.blobId, current), seeded.bodyNext, seeded.etagNext, config);
  return seeded;
}

// ---------------------------------------------------------------------------
// DB re-reads + restart helpers
// ---------------------------------------------------------------------------

export interface R04GenerationRow {
  readonly generationState: string;
  readonly cleanupAttemptToken: string | null;
  readonly cleanupLeaseOwner: string | null;
  readonly cleanupLeaseExpiresAt: Date | null;
  readonly confirmedAbsentAt: Date | null;
  readonly deletedAt: Date | null;
  readonly quarantinedAt: Date | null;
  readonly quarantinedReason: string | null;
  readonly retiredAt: Date | null;
  readonly orphanedAt: Date | null;
}

/** Raw DB re-read of a generation row (independent check, never state). */
export async function readR04GenerationRow(runtime: DatabaseRuntime, generationId: string): Promise<R04GenerationRow> {
  const rows = await runtime.pool.query<{
    generation_state: string;
    cleanup_attempt_token: string | null;
    cleanup_lease_owner: string | null;
    cleanup_lease_expires_at: Date | null;
    confirmed_absent_at: Date | null;
    deleted_at: Date | null;
    quarantined_at: Date | null;
    quarantined_reason: string | null;
    retired_at: Date | null;
    orphaned_at: Date | null;
  }>(
    `select generation_state, cleanup_attempt_token, cleanup_lease_owner, cleanup_lease_expires_at,
            confirmed_absent_at, deleted_at, quarantined_at, quarantined_reason, retired_at, orphaned_at
     from blob_generations where generation_id = $1`,
    [generationId],
  );
  assert.ok(rows.rows[0], `r04: generation ${generationId} must exist`);
  const row = rows.rows[0]!;
  return {
    generationState: row.generation_state,
    cleanupAttemptToken: row.cleanup_attempt_token,
    cleanupLeaseOwner: row.cleanup_lease_owner,
    cleanupLeaseExpiresAt: row.cleanup_lease_expires_at,
    confirmedAbsentAt: row.confirmed_absent_at,
    deletedAt: row.deleted_at,
    quarantinedAt: row.quarantined_at,
    quarantinedReason: row.quarantined_reason,
    retiredAt: row.retired_at,
    orphanedAt: row.orphaned_at,
  };
}

export async function readR04BlobRow(runtime: DatabaseRuntime, blobId: string): Promise<{
  logicalState: string;
  currentGenerationId: string | null;
}> {
  const rows = await runtime.pool.query<{ logical_state: string; current_generation_id: string | null }>(
    'select logical_state, current_generation_id from blob_records where blob_id = $1',
    [blobId],
  );
  assert.ok(rows.rows[0], `r04: blob ${blobId} must exist`);
  const row = rows.rows[0]!;
  return { logicalState: row.logical_state, currentGenerationId: row.current_generation_id };
}

export async function generationKeyCount(runtime: DatabaseRuntime, generationId: string): Promise<number> {
  const rows = await runtime.pool.query<{ count: string }>(
    'select count(*)::text as count from generation_keys where generation_id = $1',
    [generationId],
  );
  return Number(rows.rows[0]!.count);
}

/** DB-clock cleanup-lease expiry (never a JS wall clock; never an owner
 * rewrite — the takeover below goes through the PRODUCTION claim fence). */
export async function expireCleanupLeaseOnDbClock(runtime: DatabaseRuntime, generationId: string): Promise<void> {
  await runtime.pool.query(
    `update blob_generations set cleanup_lease_expires_at = current_timestamp - interval '1 second'
     where generation_id = $1`,
    [generationId],
  );
}

/**
 * Cleanup process restart: opens a genuinely NEW connection pool on the SAME
 * schema (the crashed process's pool is abandoned), so the restarted run
 * re-claims through the production fence with a fresh attempt token. Never
 * rewrites the lease owner with test SQL.
 */
export async function reopenSameSchemaRuntime(
  databaseUrl: string,
  applicationName: string,
): Promise<DatabaseRuntime> {
  return createDatabaseRuntime(databaseUrl, {
    maxConnections: 4,
    applicationName,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 1_000,
    statementTimeoutMs: 30_000,
  });
}

/** Narrow unit-of-work adapter (executor-shaped for runCleanupBatch). */
export function r04Uow(runtime: DatabaseRuntime) {
  return {
    execute<Result>(callback: (context: { transaction: DatabaseTransaction }) => Promise<Result>): Promise<Result> {
      return createUnitOfWork(runtime.db).execute(({ transaction }) => callback({ transaction }));
    },
  };
}
