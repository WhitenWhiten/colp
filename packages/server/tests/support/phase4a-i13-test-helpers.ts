/**
 * Shared helpers for the P4A-I13 focused suites. This file is not a test file:
 * it matches no vitest test pattern and is never listed in a focused config.
 *
 * Provides:
 * - deterministic blob identities + finalize handoff inputs (future
 *   Attachment binding facts) and a production seed to `stored_private`
 *   (allocate -> completeUploadCas -> claimVerification -> completeVerification)
 *   with a fixed policy revision, optional retention-deadline fixture, an
 *   optional retired-generation variant and an observed replacement candidate;
 * - a `withLockTimeout` unit-of-work wrapper for deterministic 55P03
 *   lock-timeout proofs (never a random sleep);
 * - a production handoff runner and a post-commit blob/binding re-read used by
 *   rollback, commit-unknown and restart assertions.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createPostgresAttachmentsPorts, createUnitOfWork } from '../../src/infrastructure/database/index.js';
import type { DatabaseRuntime, DatabaseTransaction } from '../../src/infrastructure/database/index.js';
import type {
  AllocateGenerationInput,
  BlobLogicalState,
  CompleteUploadCasInput,
  FinalizeHandoffInput,
  FinalizeHandoffResult,
} from '../../src/modules/attachments/index.js';
import {
  identityFor,
  makeBucket,
  type I07MigrationRuntime,
} from './phase4a-i07-test-helpers.js';

export const I13_SUBJECT_OWNER = 'i13-subject-owner';
export const I13_PRINCIPAL_OWNER = 'i13-principal-owner';
export const I13_COLLECTION = 'i13-collection';
export const I13_POLICY_VERSION = 'i13-policy-v1';
export const I13_MEDIA_TYPE = 'image/png';
export const I13_BUCKET = makeBucket();

const ports = createPostgresAttachmentsPorts();

export function sha256HexBytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The verified body every stored_private seed uses (stable content facts). */
export function i13Body(slot: number): Uint8Array {
  return new TextEncoder().encode(`i13-body-${slot}-${'x'.repeat(8)}`);
}

/** Deterministic fixture slot derived from the generation id (identityFor pads 3 digits). */
export function slotOf(id: { generationId: string }): number {
  const slot = Number(id.generationId.slice(-3));
  return Number.isFinite(slot) && slot >= 1 ? slot : 1;
}

export function i13AllocateInput(
  id: ReturnType<typeof identityFor>,
  body: Uint8Array,
  overrides: Partial<AllocateGenerationInput> = {},
): AllocateGenerationInput {
  return {
    blobId: id.blobId,
    intentId: id.intentId,
    generationId: id.generationId,
    principalId: I13_PRINCIPAL_OWNER,
    collectionId: I13_COLLECTION,
    subjectIdentity: I13_SUBJECT_OWNER,
    bucket: I13_BUCKET,
    key: id.key,
    keyFingerprint: id.fingerprint,
    expectedSize: body.byteLength,
    expectedSha256: sha256HexBytes(body),
    mediaHint: I13_MEDIA_TYPE,
    policyRevision: I13_POLICY_VERSION,
    idempotencyKey: `i13-idem-${id.intentId}`,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

export function i13CompleteCasInput(
  id: ReturnType<typeof identityFor>,
  body: Uint8Array,
  overrides: Partial<CompleteUploadCasInput> = {},
): CompleteUploadCasInput {
  return {
    intentId: id.intentId,
    generationId: id.generationId,
    blobId: id.blobId,
    actorPrincipalId: I13_PRINCIPAL_OWNER,
    declaredSize: body.byteLength,
    declaredSha256: sha256HexBytes(body),
    declaredMediaType: I13_MEDIA_TYPE,
    observedEtag: `"etag-${id.generationId}"`,
    observedSize: body.byteLength,
    observedContentType: I13_MEDIA_TYPE,
    observedMetadata: {},
    ...overrides,
  };
}

/**
 * Normalizes a generation identity onto the blob that OWNS it. The
 * two/three-generation race seeds allocate every generation on the FIRST
 * identity's blob (`original.blobId`), so the later identities (`current`,
 * `replacement`) must be re-based onto that same blob id before they are used
 * for handoff inputs, reads, or replacement/cleanup calls. Using the raw
 * `current.blobId`/`replacement.blobId` would address a DIFFERENT (never
 * seeded) blob and surface as `not_found`.
 */
export function onBlob(
  blobId: string,
  id: ReturnType<typeof identityFor>,
): ReturnType<typeof identityFor> {
  return { ...id, blobId };
}

export function i13HandoffInput(
  id: ReturnType<typeof identityFor>,
  overrides: Partial<FinalizeHandoffInput> = {},
): FinalizeHandoffInput {
  const body = i13Body(slotOf(id));
  return {
    blobId: id.blobId,
    attachmentBindingId: `i13-attachment-${id.generationId}`,
    expectedGenerationId: id.generationId,
    ownerSubjectId: I13_SUBJECT_OWNER,
    expectedEtag: `"etag-${id.generationId}"`,
    verifiedSize: body.byteLength,
    verifiedSha256: sha256HexBytes(body),
    mediaType: I13_MEDIA_TYPE,
    policyRevision: I13_POLICY_VERSION,
    ...overrides,
  };
}

export interface SeedStoredPrivateOptions {
  readonly body?: Uint8Array;
  readonly ownerSubjectId?: string;
  readonly principalId?: string;
  readonly collectionId?: string;
  readonly policyVersion?: string;
  /** After the production seed, force the retention deadline into the past. */
  readonly retentionExpired?: boolean;
}

export interface SeededStoredPrivate {
  readonly body: Uint8Array;
  readonly digest: string;
}

/** Drives the PRODUCTION ledger to `stored_private` with an active generation. */
export async function seedStoredPrivate(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  options: SeedStoredPrivateOptions = {},
): Promise<SeededStoredPrivate> {
  const body = options.body ?? i13Body(slotOf(id));
  const digest = sha256HexBytes(body);
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const allocated = await ports.allocate(transaction, i13AllocateInput(id, body, {
      subjectIdentity: options.ownerSubjectId ?? I13_SUBJECT_OWNER,
      principalId: options.principalId ?? I13_PRINCIPAL_OWNER,
      collectionId: options.collectionId ?? I13_COLLECTION,
      policyRevision: options.policyVersion ?? I13_POLICY_VERSION,
    }));
    assert.equal(allocated.outcome, 'issued');
    const cas = await ports.completeUploadCas(transaction, i13CompleteCasInput(id, body, {
      actorPrincipalId: options.principalId ?? I13_PRINCIPAL_OWNER,
    }));
    assert.equal(cas.outcome, 'uploaded');
  });
  await verifyToStoredPrivate(runtime, id, body, {
    policyVersion: options.policyVersion ?? I13_POLICY_VERSION,
  });
  if (options.retentionExpired) {
    await runtime.pool.query(
      `update blob_records set retention_deadline = now() - interval '1 second' where blob_id = $1`,
      [id.blobId],
    );
  }
  return { body, digest };
}

export async function verifyToStoredPrivate(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  body: Uint8Array,
  options: { policyVersion?: string } = {},
): Promise<void> {
  const attempt = { outboxId: `outbox-${id.generationId}`, leaseGeneration: '1' };
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const domainEventId = randomUUID();
    await sql`
      insert into resource_id_ledger (resource_id, resource_type)
      values (${attempt.outboxId}, 'outbox'), (${domainEventId}, 'outbox')
    `.execute(transaction);
    await sql`
      insert into outbox_events
        (outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
         aggregate_type, aggregate_id, aggregate_scope, occurred_at, payload_json, state,
         attempt_count, available_at, locked_until, lease_generation)
      values (${attempt.outboxId}, ${domainEventId}, 'attachments.upload-verified', 1,
         'attachments_verify_generation', 'delivery_each_event', 'blob', ${id.blobId},
         ${id.generationId}, now(), '{}'::jsonb, 'leased', 1, now(), now() + interval '1 hour', 1)
    `.execute(transaction);
    const claimed = await ports.claimVerification(transaction, {
      blobId: id.blobId,
      generationId: id.generationId,
      attempt,
      leaseTtlSeconds: 60,
    });
    assert.equal(claimed.outcome, 'claimed');
    const completed = await ports.completeVerification(transaction, {
      blobId: id.blobId,
      generationId: id.generationId,
      attempt,
      verifiedSize: body.byteLength,
      verifiedSha256: sha256HexBytes(body),
      mediaType: I13_MEDIA_TYPE,
      policyVersion: options.policyVersion ?? I13_POLICY_VERSION,
    });
    assert.equal(completed.outcome, 'stored_private');
  });
}

/**
 * Seeds a blob whose CURRENT generation is `replacement` (active, verified to
 * `stored_private`) while `original` is a RETIRED generation on the same blob
 * (cleanup-claimable): original active -> replacement observed -> replacement
 * CAS activated (original retired) -> replacement verified -> stored_private.
 */
export async function seedStoredPrivateWithRetired(
  runtime: I07MigrationRuntime['runtime'],
  original: ReturnType<typeof identityFor>,
  replacement: ReturnType<typeof identityFor>,
): Promise<void> {
  // The blob's verified facts always follow the CURRENT generation's body
  // (slotOf(replacement)), which is exactly what `i13HandoffInput(replacement)`
  // derives — so a handoff on the current generation matches by default.
  const originalBody = i13Body(slotOf(original));
  const currentBody = i13Body(slotOf(replacement));
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const allocated = await ports.allocate(transaction, i13AllocateInput(original, originalBody));
    assert.equal(allocated.outcome, 'issued');
    const completed = await ports.complete(transaction, {
      intentId: original.intentId,
      generationId: original.generationId,
      blobId: original.blobId,
      observedEtag: `"etag-${original.generationId}"`,
      observedSize: originalBody.byteLength,
      observedContentType: I13_MEDIA_TYPE,
      observedMetadata: {},
    });
    assert.equal(completed.outcome, 'verified_active');
    const allocatedNext = await ports.allocate(transaction, i13AllocateInput(replacement, currentBody, {
      blobId: original.blobId,
    }));
    assert.equal(allocatedNext.outcome, 'issued');
    const completedNext = await ports.complete(transaction, {
      intentId: replacement.intentId,
      generationId: replacement.generationId,
      blobId: original.blobId,
      observedEtag: `"etag-${replacement.generationId}"`,
      observedSize: currentBody.byteLength,
      observedContentType: I13_MEDIA_TYPE,
      observedMetadata: {},
    });
    assert.equal(completedNext.outcome, 'verified_observed');
    const activated = await ports.activateReplacement(transaction, {
      blobId: original.blobId,
      expectedActiveGenerationId: original.generationId,
      newGenerationId: replacement.generationId,
    });
    assert.equal(activated.outcome, 'activated');
  });
  // All generations in this seed live on `original.blobId`; the replacement
  // identity must be re-based onto that blob before verification.
  await verifyToStoredPrivate(runtime, onBlob(original.blobId, replacement), currentBody);
}

/**
 * Seeds a SECOND generation in `observed` state for the SAME blob (a
 * replacement candidate not yet activated) while the original stays current.
 */
export async function seedObservedReplacement(
  runtime: I07MigrationRuntime['runtime'],
  original: ReturnType<typeof identityFor>,
  replacement: ReturnType<typeof identityFor>,
): Promise<void> {
  const body = i13Body(slotOf(replacement));
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const allocated = await ports.allocate(transaction, i13AllocateInput(replacement, body, {
      blobId: original.blobId,
    }));
    assert.equal(allocated.outcome, 'issued');
    const completed = await ports.complete(transaction, {
      intentId: replacement.intentId,
      generationId: replacement.generationId,
      blobId: original.blobId,
      observedEtag: `"etag-${replacement.generationId}"`,
      observedSize: body.byteLength,
      observedContentType: I13_MEDIA_TYPE,
      observedMetadata: {},
    });
    assert.equal(completed.outcome, 'verified_observed');
  });
}

/** Narrow unit-of-work adapter: every execute opens a NEW transaction. */
export function i13Uow(runtime: DatabaseRuntime) {
  return {
    execute<Result>(callback: (transaction: DatabaseTransaction) => Promise<Result>): Promise<Result> {
      return createUnitOfWork(runtime.db).execute(({ transaction }) => callback(transaction));
    },
  };
}

/**
 * Runs `operation` inside a fresh transaction with a bounded `SET LOCAL
 * lock_timeout`, so a blocked lock is proven by the stable 55P03 SQLSTATE
 * (deterministic barrier proof, never a short timeout misreported as unsafe).
 */
export async function withLockTimeout<Result>(
  uow: ReturnType<typeof i13Uow>,
  timeoutMs: number,
  operation: (tx: DatabaseTransaction) => Promise<Result>,
): Promise<Result> {
  return uow.execute(async (tx) => {
    await sql.raw(`SET LOCAL lock_timeout = '${timeoutMs}ms'`).execute(tx);
    return operation(tx);
  });
}

/** Runs the production handoff port inside a fresh transaction. */
export function finalizeHandoffInTx(
  runtime: DatabaseRuntime,
  input: FinalizeHandoffInput,
  options: { barrier?: { arriveAndWait(name: string): Promise<void> } } = {},
): Promise<FinalizeHandoffResult> {
  return createUnitOfWork(runtime.db).execute(({ transaction }) =>
    ports.finalizeHandoff(transaction, input, options));
}

export interface I13BlobBindingRow {
  readonly blobId: string;
  readonly logicalState: BlobLogicalState;
  readonly ownerSubjectId: string;
  readonly currentGenerationId: string | null;
  readonly generationState: string | null;
  readonly observedEtag: string | null;
  readonly verifiedSize: number | null;
  readonly verifiedSha256: string | null;
  readonly mediaType: string | null;
  readonly verificationPolicyVersion: string | null;
  readonly retentionDeadline: Date | null;
  readonly attachmentBindingId: string | null;
  readonly attachedAt: Date | null;
  readonly attachmentBindingGenerationId: string | null;
  readonly attachmentBindingEtag: string | null;
  readonly attachmentBindingPolicyVersion: string | null;
}

/** Raw snake_case row selected by readBlobBinding. */
interface I13BlobBindingSqlRow {
  blob_id: string;
  logical_state: string;
  owner_subject_id: string;
  current_generation_id: string | null;
  generation_state: string | null;
  observed_etag: string | null;
  verified_size: string | null;
  verified_sha256: string | null;
  media_type: string | null;
  verification_policy_version: string | null;
  retention_deadline: Date | null;
  attachment_binding_id: string | null;
  attached_at: Date | null;
  attachment_binding_generation_id: string | null;
  attachment_binding_etag: string | null;
  attachment_binding_policy_version: string | null;
}

/** Re-reads the committed blob + current generation facts for assertions. */
export async function readBlobBinding(
  runtime: DatabaseRuntime,
  blobId: string,
): Promise<I13BlobBindingRow | null> {
  const rows = await sql<I13BlobBindingSqlRow>`
    select br.blob_id, br.logical_state, br.owner_subject_id, br.current_generation_id,
           bg.generation_state, bg.observed_etag,
           br.verified_size::text, br.verified_sha256, br.media_type,
           br.verification_policy_version, br.retention_deadline,
           br.attachment_binding_id, br.attached_at, br.attachment_binding_generation_id,
           br.attachment_binding_etag, br.attachment_binding_policy_version
    from blob_records br
    left join blob_generations bg on bg.generation_id = br.current_generation_id
    where br.blob_id = ${blobId}
  `.execute(runtime.db);
  if (rows.rows.length === 0) return null;
  const row = rows.rows[0]!;
  return {
    blobId: row.blob_id,
    logicalState: row.logical_state as BlobLogicalState,
    ownerSubjectId: row.owner_subject_id,
    currentGenerationId: row.current_generation_id,
    generationState: row.generation_state,
    observedEtag: row.observed_etag,
    verifiedSize: row.verified_size === null ? null : Number(row.verified_size),
    verifiedSha256: row.verified_sha256,
    mediaType: row.media_type,
    verificationPolicyVersion: row.verification_policy_version,
    retentionDeadline: row.retention_deadline,
    attachmentBindingId: row.attachment_binding_id,
    attachedAt: row.attached_at,
    attachmentBindingGenerationId: row.attachment_binding_generation_id,
    attachmentBindingEtag: row.attachment_binding_etag,
    attachmentBindingPolicyVersion: row.attachment_binding_policy_version,
  };
}

export { identityFor };