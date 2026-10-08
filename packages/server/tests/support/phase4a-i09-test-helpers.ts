/**
 * Shared helpers for the P4A-I09 focused suites. This file is not a test file:
 * it matches no vitest test pattern and is never listed in a focused config.
 *
 * Provides the in-memory transaction-aware attachments ledger (allocate,
 * complete CAS, verification claim/complete/quarantine with lease fencing),
 * the tx-aware unit of work, an in-memory generation object store with
 * chunked streams + abort/oversize fault injection, deterministic identity
 * fixtures, and an independent SHA-256 helper (never reused as the declared
 * digest).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ActorPrincipal } from '../../src/modules/access-policy/index.js';
import {
  AttachmentsIdentityError,
  type ActivateReplacementInput,
  type ActivateReplacementResult,
  type AllocateGenerationInput,
  type AllocateGenerationResult,
  type AttachmentsFeatureConfig,
  type AttachmentsLedgerPort,
  type BlobLogicalState,
  type ClaimCleanupInput,
  type ClaimCleanupResult,
  type CompleteCleanupInput,
  type CompleteCleanupResult,
  type CompleteGenerationInput,
  type CompleteGenerationResult,
  type CompleteUploadCasInput,
  type CompleteUploadCasResult,
  type CompleteUploadTargetInput,
  type CompleteUploadTargetResult,
  type CompleteVerificationInput,
  type CompleteVerificationResult,
  type FindBlobForStatusInput,
  type FindBlobForStatusResult,
  type FindIntentByBindingInput,
  type FindIntentByBindingResult,
  type FinalizeLockInput,
  type FinalizeLockResult,
  type GenerationHeadOutcome,
  type GenerationObjectStorePort,
  type GenerationReadOutcome,
  type GenerationState,
  type IntentUnitOfWork,
  type QuarantineGenerationInput,
  type QuarantineGenerationResult,
  type QuarantineVerificationInput,
  type QuarantineVerificationResult,
  type ClaimVerificationInput,
  type ClaimVerificationResult,
  type StoredIntentFacts,
  type VerificationAttemptFence,
  type VerificationTargetFacts,
} from '../../src/modules/attachments/index.js';

export const I09_SUBJECT = 'i09-subject-owner';
export const I09_PRINCIPAL = 'i09-principal';
export const I09_COLLECTION = 'i09-collection';
export const I09_BUCKET = 'i09-production-bucket';
export const I09_LIVE_PREFIX = 'attachments/live/';
export const I09_POLICY_VERSION = 'phase4a-i09-policy-v1';

export function sha256HexBytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Independent expected digest for test bodies (never the declared digest). */
export function expectedDigest(bytes: Uint8Array): string {
  return sha256HexBytes(bytes);
}

export function makeActor(subjectId = I09_SUBJECT, principalId = I09_PRINCIPAL): ActorPrincipal {
  return { principalId, subjectId, kind: 'account' };
}

export function makeI09Config(overrides: Partial<AttachmentsFeatureConfig> = {}): AttachmentsFeatureConfig {
  const base: AttachmentsFeatureConfig = {
    enabled: true,
    r2: {
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: I09_BUCKET,
      livePrefix: I09_LIVE_PREFIX,
      probePrefix: 'attachments/probe/',
      rwSecretRef: 'known/r2/rw/primary',
      roSecretRef: 'known/r2/ro/primary',
    },
    grantTtlSeconds: 60,
    singlePutMaxBytes: 5 * 1024 * 1024,
    allowedMedia: ['image/png', 'application/pdf', 'text/plain'],
    verification: { leaseMs: 60_000, timeoutMs: 15_000, retryCount: 2 },
    retention: { intentRetentionHours: 24, storedRetentionDays: 30, retiredRetentionDays: 90 },
    cleanupBatchSize: 100,
    cleanup: { leaseMs: 60_000, retryCount: 2 },
    isolatedDeliveryOrigin: 'https://delivery.known.test',
    deliveryCapabilitySecretRef: 'known/delivery/hmac/primary',
    deliveryCapabilityTtlSeconds: 60,
  };
  return Object.freeze({ ...base, ...overrides, r2: { ...base.r2, ...overrides.r2 } });
}

export function uuidFor(n: number | string): string {
  return `018f6f7a-8f2a-7a3d-a123-123456789${String(n).padStart(3, '0')}`;
}

export interface I09Identity {
  blobId: string;
  intentId: string;
  generationId: string;
  key: string;
}

/** Deterministic generation identity for a numbered fixture slot. */
export function identityFor(n: number): I09Identity {
  const blobId = uuidFor(1000 + n);
  const intentId = uuidFor(2000 + n);
  const generationId = uuidFor(3000 + n);
  const key = `${I09_LIVE_PREFIX}${uuidFor(4000 + n)}`;
  return { blobId, intentId, generationId, key };
}

export function allocateInput(id: I09Identity, overrides: Partial<AllocateGenerationInput> = {}): AllocateGenerationInput {
  return {
    blobId: id.blobId,
    intentId: id.intentId,
    generationId: id.generationId,
    principalId: I09_PRINCIPAL,
    collectionId: I09_COLLECTION,
    subjectIdentity: I09_SUBJECT,
    bucket: I09_BUCKET,
    key: id.key,
    keyFingerprint: sha256HexBytes(id.key),
    expectedSize: 16,
    expectedSha256: 'a'.repeat(64),
    mediaHint: 'image/png',
    policyRevision: 'policy-r1',
    idempotencyKey: `idem-${id.intentId}`,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory ledger rows
// ---------------------------------------------------------------------------

interface StoredIntent {
  intentId: string;
  blobId: string;
  generationId: string;
  principalId: string;
  collectionId: string;
  subjectIdentity: string;
  key: string;
  expectedSize: number | null;
  expectedSha256: string | null;
  mediaHint: string | null;
  policyRevision: string;
  idempotencyKey: string;
  expiresAt: Date;
}

interface StoredGeneration {
  generationId: string;
  blobId: string;
  bucket: string;
  key: string;
  generationState: GenerationState;
  observedEtag: string | null;
  observedSize: number | null;
  observedContentType: string | null;
  observedMetadata: Record<string, string>;
}

interface StoredBlob {
  blobId: string;
  ownerSubjectId: string;
  logicalState: BlobLogicalState;
  currentGenerationId: string | null;
  verifiedSize: number | null;
  verifiedSha256: string | null;
  mediaType: string | null;
  verificationPolicyVersion: string | null;
  verificationLeaseOwner: string | null;
  verificationLeaseGeneration: bigint;
  verificationLeaseExpiresAt: Date | null;
}

interface LedgerStore {
  intents: Map<string, StoredIntent>;
  generations: Map<string, StoredGeneration>;
  blobs: Map<string, StoredBlob>;
}

function emptyStore(): LedgerStore {
  return { intents: new Map(), generations: new Map(), blobs: new Map() };
}

function mergeInto(target: LedgerStore, source: LedgerStore): void {
  for (const [id, row] of source.intents) target.intents.set(id, row);
  for (const [id, row] of source.generations) target.generations.set(id, row);
  for (const [id, row] of source.blobs) target.blobs.set(id, row);
}

export type I09Tx = number;

/**
 * Transaction-aware in-memory attachments ledger for the I09 suites. Writes
 * are staged per transaction and only applied on commit; the verification
 * lease uses an injectable clock so lease expiry/takeover is deterministic.
 */
export class InMemoryVerificationLedger implements AttachmentsLedgerPort<I09Tx> {
  readonly committed: LedgerStore = emptyStore();
  private readonly pending = new Map<I09Tx, LedgerStore>();
  private txCounter = 0;
  private nowValue = new Date('2026-08-08T12:00:00.000Z');

  setNow(value: Date): void {
    this.nowValue = value;
  }

  advanceNow(ms: number): void {
    this.nowValue = new Date(this.nowValue.getTime() + ms);
  }

  begin(): I09Tx {
    this.txCounter += 1;
    this.pending.set(this.txCounter, emptyStore());
    return this.txCounter;
  }

  commit(tx: I09Tx): void {
    const staged = this.pending.get(tx);
    if (staged) {
      mergeInto(this.committed, staged);
      this.pending.delete(tx);
    }
  }

  rollback(tx: I09Tx): void {
    this.pending.delete(tx);
  }

  /** Row-lock analog: serializes mutating CAS calls like PostgreSQL row locks. */
  private casChain: Promise<unknown> = Promise.resolve();
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.casChain.then(work, work);
    this.casChain = run.then(() => undefined, () => undefined);
    return run;
  }

  blobState(blobId: string): StoredBlob | undefined {
    return this.committed.blobs.get(blobId);
  }

  generationState(generationId: string): StoredGeneration | undefined {
    return this.committed.generations.get(generationId);
  }

  private view(tx: I09Tx): LedgerStore {
    const staged = this.pending.get(tx);
    if (!staged) throw new Error('in-memory ledger: transaction not open');
    return staged;
  }

  private findBlobAnywhere(blobId: string): StoredBlob | undefined {
    // In-flight (staged, not yet committed) writes are the latest fact. The CAS
    // chain serializes writers exactly like a PostgreSQL row lock: a queued
    // writer must observe the previous writer's staged result, not the stale
    // committed row it is about to replace.
    return [...this.pending.values()].map((store) => store.blobs.get(blobId)).find((row) => row !== undefined)
      ?? this.committed.blobs.get(blobId);
  }

  private findGenerationAnywhere(generationId: string): StoredGeneration | undefined {
    return [...this.pending.values()].map((store) => store.generations.get(generationId)).find((row) => row !== undefined)
      ?? this.committed.generations.get(generationId);
  }

  private findIntentAnywhere(intentId: string): StoredIntent | undefined {
    return this.committed.intents.get(intentId)
      ?? [...this.pending.values()].map((store) => store.intents.get(intentId)).find((row) => row !== undefined);
  }

  private findIntentByGeneration(generationId: string): StoredIntent | undefined {
    return [...this.committed.intents.values()].find((row) => row.generationId === generationId)
      ?? [...this.pending.values()].flatMap((store) => [...store.intents.values()])
        .find((row) => row.generationId === generationId);
  }

  async findBlobForStatus(tx: I09Tx, input: FindBlobForStatusInput): Promise<FindBlobForStatusResult> {
    // P4A-P04 mirror: current blob/generation/intent facts resolved inside
    // the transaction (staged writes win, exactly like the production
    // tx-consistent read). Only the facts the replacement CAS path consumes
    // are surfaced; DB-clock facts are simulated from the injectable clock.
    const blob = this.findBlobAnywhere(input.blobId);
    if (!blob) return { outcome: 'not_found' };
    const currentGeneration = blob.currentGenerationId
      ? this.findGenerationAnywhere(blob.currentGenerationId)
      : undefined;
    const intent = blob.currentGenerationId
      ? this.findIntentByGeneration(blob.currentGenerationId)
      : undefined;
    return {
      outcome: 'found',
      facts: {
        blobId: blob.blobId,
        ownerSubjectId: blob.ownerSubjectId,
        logicalState: blob.logicalState,
        currentGenerationId: blob.currentGenerationId,
        currentGenerationState: currentGeneration?.generationState ?? null,
        collectionId: intent?.collectionId ?? null,
        verifiedSize: blob.verifiedSize,
        mediaType: blob.mediaType,
        expectedSize: intent?.expectedSize ?? null,
        mediaHint: intent?.mediaHint ?? null,
        createdAt: this.nowValue,
        updatedAt: this.nowValue,
        attachmentLogicalState: null,
      },
    };
  }

  async findIntentByBinding(tx: I09Tx, input: FindIntentByBindingInput): Promise<FindIntentByBindingResult> {
    const staged = this.view(tx);
    const found = [...this.committed.intents.values(), ...staged.intents.values()].find((intent) =>
      intent.collectionId === input.collectionId
      && intent.subjectIdentity === input.subjectIdentity
      && intent.idempotencyKey === input.idempotencyKey);
    if (!found) return { outcome: 'not_found' };
    return { outcome: 'found', intent: intentToFacts(found) };
  }

  async allocate(tx: I09Tx, input: AllocateGenerationInput): Promise<AllocateGenerationResult> {
    const staged = this.view(tx);
    const existing = this.findIntentAnywhere(input.intentId);
    if (existing) {
      if (existing.generationId === input.generationId && existing.blobId === input.blobId) {
        return { outcome: 'already_issued', intentId: input.intentId, generationId: input.generationId, blobId: input.blobId };
      }
      throw new AttachmentsIdentityError('intent_generation_mismatch');
    }
    if (this.committed.generations.has(input.generationId)
      || [...this.pending.values()].some((store) => store.generations.has(input.generationId))) {
      throw new AttachmentsIdentityError('generation_issued');
    }
    // Production `allocate` inserts the blob row with `on conflict (blob_id)
    // do nothing` — an existing blob (e.g. a second generation over the same
    // blob) is NEVER reset; its pointer and logical state stay untouched.
    if (!this.findBlobAnywhere(input.blobId)) {
      staged.blobs.set(input.blobId, {
        blobId: input.blobId,
        ownerSubjectId: input.subjectIdentity,
        logicalState: 'issued',
        currentGenerationId: null,
        verifiedSize: null,
        verifiedSha256: null,
        mediaType: null,
        verificationPolicyVersion: null,
        verificationLeaseOwner: null,
        verificationLeaseGeneration: 0n,
        verificationLeaseExpiresAt: null,
      });
    }
    staged.generations.set(input.generationId, {
      generationId: input.generationId,
      blobId: input.blobId,
      bucket: input.bucket,
      key: input.key,
      generationState: 'allocated',
      observedEtag: null,
      observedSize: null,
      observedContentType: null,
      observedMetadata: {},
    });
    staged.intents.set(input.intentId, {
      intentId: input.intentId,
      blobId: input.blobId,
      generationId: input.generationId,
      principalId: input.principalId,
      collectionId: input.collectionId,
      subjectIdentity: input.subjectIdentity,
      key: input.key,
      expectedSize: input.expectedSize ?? null,
      expectedSha256: input.expectedSha256 ?? null,
      mediaHint: input.mediaHint ?? null,
      policyRevision: input.policyRevision,
      idempotencyKey: input.idempotencyKey,
      expiresAt: input.expiresAt,
    });
    return { outcome: 'issued', intentId: input.intentId, generationId: input.generationId, blobId: input.blobId };
  }

  async complete(_tx: I09Tx, _input: CompleteGenerationInput): Promise<CompleteGenerationResult> {
    throw new Error('not_implemented:complete(I07 replacement semantics are out of the I09 scope)');
  }

  async findCompleteTarget(tx: I09Tx, input: CompleteUploadTargetInput): Promise<CompleteUploadTargetResult> {
    this.view(tx);
    const intent = this.findIntentAnywhere(input.intentId);
    if (!intent) return { outcome: 'not_found' };
    if (intent.blobId !== input.blobId || intent.generationId !== input.generationId) return { outcome: 'not_found' };
    const generation = this.findGenerationAnywhere(input.generationId);
    const blob = this.findBlobAnywhere(input.blobId);
    if (!generation || !blob) return { outcome: 'not_found' };
    return {
      outcome: 'found',
      facts: {
        intentId: intent.intentId,
        generationId: generation.generationId,
        blobId: blob.blobId,
        key: generation.key,
        bucket: generation.bucket,
        principalId: intent.principalId,
        expectedSize: intent.expectedSize,
        expectedSha256: intent.expectedSha256,
        mediaHint: intent.mediaHint,
        expiresAt: intent.expiresAt,
        generationState: generation.generationState,
        blobLogicalState: blob.logicalState,
        currentGenerationId: blob.currentGenerationId,
        observedEtag: generation.observedEtag,
        observedSize: generation.observedSize,
      },
    };
  }

  async completeUploadCas(tx: I09Tx, input: CompleteUploadCasInput): Promise<CompleteUploadCasResult> {
    return this.serialize(async () => {
    const staged = this.view(tx);
    const intent = this.findIntentAnywhere(input.intentId);
    if (!intent) return { outcome: 'not_found' };
    if (intent.generationId !== input.generationId || intent.blobId !== input.blobId) return { outcome: 'identity_mismatch' };
    if (intent.principalId !== input.actorPrincipalId) return { outcome: 'principal_mismatch' };
    const generation = this.findGenerationAnywhere(input.generationId);
    const blob = this.findBlobAnywhere(input.blobId);
    if (!generation || !blob) return { outcome: 'not_found' };
    if ((blob.logicalState === 'stored_private' || blob.logicalState === 'attached_private')
      && blob.currentGenerationId === input.generationId) {
      return { outcome: 'already_verified' };
    }

    if (intent.expectedSize !== null && intent.expectedSize !== input.declaredSize) {
      return { outcome: 'declared_facts_mismatch', code: 'size' };
    }
    if (intent.expectedSha256 !== null && intent.expectedSha256 !== input.declaredSha256) {
      return { outcome: 'declared_facts_mismatch', code: 'digest' };
    }
    if (intent.mediaHint !== null && intent.mediaHint !== input.declaredMediaType) {
      return { outcome: 'declared_facts_mismatch', code: 'media' };
    }
    if (intent.expiresAt.getTime() <= this.nowValue.getTime()) {
      if (generation.generationState === 'allocated' || generation.generationState === 'observed') {
        staged.generations.set(generation.generationId, { ...generation, generationState: 'orphaned' });
        if (blob.logicalState === 'issued') {
          staged.blobs.set(blob.blobId, { ...blob, logicalState: 'expired' });
        }
      }
      return { outcome: 'late_rejected', reason: 'expired' };
    }

    const observed = {
      etag: input.observedEtag,
      size: input.observedSize,
      contentType: input.observedContentType,
      metadata: input.observedMetadata,
    };
    switch (generation.generationState) {
      case 'allocated': {
        if (blob.currentGenerationId === null) {
          staged.generations.set(generation.generationId, {
            ...generation,
            generationState: 'active',
            observedEtag: observed.etag,
            observedSize: observed.size,
            observedContentType: observed.contentType,
            observedMetadata: observed.metadata,
          });
          staged.blobs.set(blob.blobId, {
            ...blob,
            logicalState: 'uploaded',
            currentGenerationId: generation.generationId,
          });
          return { outcome: 'uploaded' };
        }
        if (blob.currentGenerationId === generation.generationId) return { outcome: 'idempotent' };
        // FIX-L-045 support: mirror the production P4A-P07 replacement path —
        // the exact-key complete attestation binds the observed facts and the
        // generation reaches `observed`; the pointer is NOT moved here (the
        // frozen `activateReplacement` CAS does that afterwards).
        staged.generations.set(generation.generationId, {
          ...generation,
          generationState: 'observed',
          observedEtag: observed.etag,
          observedSize: observed.size,
          observedContentType: observed.contentType,
          observedMetadata: observed.metadata,
        });
        return { outcome: 'uploaded' };
      }
      case 'observed': {
        const bindingMatches = generation.observedEtag === observed.etag && generation.observedSize === observed.size;
        return bindingMatches ? { outcome: 'idempotent' } : { outcome: 'identity_mismatch' };
      }
      case 'active': {
        if (blob.currentGenerationId === generation.generationId) {
          const bindingMatches = generation.observedEtag === observed.etag && generation.observedSize === observed.size;
          return bindingMatches ? { outcome: 'idempotent' } : { outcome: 'identity_mismatch' };
        }
        return { outcome: 'late_rejected', reason: 'not_current' };
      }
      case 'retired': return { outcome: 'late_rejected', reason: 'replaced' };
      case 'orphaned': return { outcome: 'late_rejected', reason: 'orphaned' };
      case 'deletion_pending': return { outcome: 'late_rejected', reason: 'not_completable' };
      case 'deleted': return { outcome: 'late_rejected', reason: 'deleted' };
      case 'contract_corrupt': return { outcome: 'late_rejected', reason: 'contract_corrupt' };
      case 'quarantined': return { outcome: 'late_rejected', reason: 'quarantined' };
      default: return { outcome: 'late_rejected', reason: 'not_completable' };
    }
    });
  }

  async claimVerification(tx: I09Tx, input: ClaimVerificationInput): Promise<ClaimVerificationResult> {
    const staged = this.view(tx);
    const blob = this.findBlobAnywhere(input.blobId);
    if (!blob) return { outcome: 'not_found' };
    const generation = this.findGenerationAnywhere(input.generationId);
    if (!generation || generation.blobId !== input.blobId) return { outcome: 'not_found' };
    if (blob.logicalState === 'stored_private' || blob.logicalState === 'attached_private') {
      return { outcome: 'already_stored' };
    }
    if (blob.logicalState === 'expired') return { outcome: 'already_expired' };
    if (blob.currentGenerationId !== input.generationId) {
      // FIX-L-045 mirror: an authoritative replacement (the event's own
      // generation is retired by the replacement CAS, or already deleted by
      // cleanup) is terminal — the claim completes without touching the new
      // generation. Unknown/transient states stay lease_lost (retry) so a
      // real verification is never dropped.
      if (generation.generationState === 'retired' || generation.generationState === 'deleted') {
        return { outcome: 'already_replaced' };
      }
      return { outcome: 'lease_lost' };
    }
    const leaseHeld = blob.logicalState === 'verifying'
      && blob.verificationLeaseExpiresAt !== null
      && blob.verificationLeaseExpiresAt.getTime() > this.nowValue.getTime()
      && blob.verificationLeaseGeneration !== BigInt(input.attempt.leaseGeneration);
    if (leaseHeld) return { outcome: 'lease_lost' };
    const expiresAt = new Date(this.nowValue.getTime() + input.leaseTtlSeconds * 1000);
    staged.blobs.set(blob.blobId, {
      ...blob,
      logicalState: 'verifying',
      verificationLeaseOwner: input.attempt.outboxId,
      verificationLeaseGeneration: BigInt(input.attempt.leaseGeneration),
      verificationLeaseExpiresAt: expiresAt,
    });
    const intent = this.findIntentByGeneration(generation.generationId);
    const facts: VerificationTargetFacts = {
      bucket: generation.bucket,
      key: generation.key,
      observedEtag: generation.observedEtag,
      observedSize: generation.observedSize,
      expectedSize: intent?.expectedSize ?? null,
      expectedSha256: intent?.expectedSha256 ?? null,
      mediaHint: intent?.mediaHint ?? null,
      generationState: generation.generationState,
      blobLogicalState: 'verifying',
    };
    return {
      outcome: 'claimed',
      facts,
      leaseOwner: input.attempt.outboxId,
      leaseGeneration: input.attempt.leaseGeneration,
      leaseExpiresAt: expiresAt,
    };
  }

  async completeVerification(tx: I09Tx, input: CompleteVerificationInput): Promise<CompleteVerificationResult> {
    const staged = this.view(tx);
    const blob = this.findBlobAnywhere(input.blobId);
    if (!blob) return { outcome: 'not_found' };
    const fenceHolds = blob.logicalState === 'verifying'
      && blob.currentGenerationId === input.generationId
      && blob.verificationLeaseGeneration === BigInt(input.attempt.leaseGeneration);
    if (!fenceHolds) return { outcome: 'lease_lost' };
    staged.blobs.set(blob.blobId, {
      ...blob,
      logicalState: 'stored_private',
      verifiedSize: input.verifiedSize,
      verifiedSha256: input.verifiedSha256,
      mediaType: input.mediaType,
      verificationPolicyVersion: input.policyVersion,
      // The lease is fully released on stored_private.
      verificationLeaseOwner: null,
      verificationLeaseGeneration: 0n,
      verificationLeaseExpiresAt: null,
    });
    return { outcome: 'stored_private' };
  }

  async quarantineVerification(tx: I09Tx, input: QuarantineVerificationInput): Promise<QuarantineVerificationResult> {
    const staged = this.view(tx);
    const blob = this.findBlobAnywhere(input.blobId);
    const generation = this.findGenerationAnywhere(input.generationId);
    if (!blob || !generation) return { outcome: 'not_found' };
    const fenceHolds = blob.logicalState === 'verifying'
      && blob.currentGenerationId === input.generationId
      && blob.verificationLeaseGeneration === BigInt(input.attempt.leaseGeneration);
    if (!fenceHolds) return { outcome: 'lease_lost' };
    staged.blobs.set(blob.blobId, {
      ...blob,
      logicalState: 'expired',
      verificationLeaseOwner: null,
      verificationLeaseGeneration: 0n,
      verificationLeaseExpiresAt: null,
    });
    staged.generations.set(generation.generationId, { ...generation, generationState: 'quarantined' });
    return { outcome: 'quarantined' };
  }

  async activateReplacement(tx: I09Tx, input: ActivateReplacementInput): Promise<ActivateReplacementResult> {
    return this.serialize(async () => {
      const staged = this.view(tx);
      const blob = this.findBlobAnywhere(input.blobId);
      if (!blob) return { outcome: 'blob_not_found' };
      // FIX-L-045 support: mirror the production CAS — a committed future
      // Attachment binding is terminal; replacement cannot break it.
      if (blob.logicalState === 'attached_private') return { outcome: 'attached_not_replaced' };
      const newGen = this.findGenerationAnywhere(input.newGenerationId);
      if (!newGen) return { outcome: 'new_not_found' };
      if (newGen.blobId !== input.blobId) return { outcome: 'new_not_found' };
      // A commit-unknown replay of an already-applied CAS converges
      // idempotently when the new generation is already current+active.
      if (newGen.generationState === 'active' && blob.currentGenerationId === input.newGenerationId) {
        return { outcome: 'idempotent' };
      }
      if (blob.currentGenerationId !== input.expectedActiveGenerationId) return { outcome: 'stale_cas' };
      if (newGen.generationState !== 'observed') return { outcome: 'new_not_verified' };
      const oldGen = input.expectedActiveGenerationId
        ? this.findGenerationAnywhere(input.expectedActiveGenerationId)
        : undefined;
      if (oldGen) {
        staged.generations.set(oldGen.generationId, { ...oldGen, generationState: 'retired' });
      }
      staged.generations.set(newGen.generationId, { ...newGen, generationState: 'active' });
      // The pointer moved to an unverified generation: a stored blob is
      // demoted back to `uploaded` and its verified facts cleared, so the
      // verification worker re-verifies the NEW current generation.
      const demote = blob.logicalState === 'stored_private';
      staged.blobs.set(blob.blobId, {
        ...blob,
        currentGenerationId: newGen.generationId,
        ...(demote ? {
          logicalState: 'uploaded',
          verifiedSize: null,
          verifiedSha256: null,
          mediaType: null,
          verificationPolicyVersion: null,
        } : {}),
      });
      return { outcome: 'activated' };
    });
  }
  async claimCleanup(_tx: I09Tx, _input: ClaimCleanupInput): Promise<ClaimCleanupResult> {
    throw new Error('not_implemented:claimCleanup');
  }
  async completeCleanup(_tx: I09Tx, _input: CompleteCleanupInput): Promise<CompleteCleanupResult> {
    throw new Error('not_implemented:completeCleanup');
  }
  async finalizeLock(_tx: I09Tx, _input: FinalizeLockInput): Promise<FinalizeLockResult> {
    throw new Error('not_implemented:finalizeLock');
  }
  async readCleanupState(_tx: never, _input: { generationId: string }): Promise<{ outcome: 'found'; row: never } | { outcome: 'not_found' }> {
    return { outcome: 'not_found' };
  }

  async quarantineGeneration(_tx: I09Tx, _input: QuarantineGenerationInput): Promise<QuarantineGenerationResult> {
    throw new Error('not_implemented:quarantineGeneration');
  }
}

function intentToFacts(intent: StoredIntent): StoredIntentFacts {
  return {
    intentId: intent.intentId,
    generationId: intent.generationId,
    blobId: intent.blobId,
    key: intent.key,
    principalId: intent.principalId,
    collectionId: intent.collectionId,
    subjectIdentity: intent.subjectIdentity,
    expectedSize: intent.expectedSize,
    expectedSha256: intent.expectedSha256,
    mediaHint: intent.mediaHint,
    policyRevision: intent.policyRevision,
    idempotencyKey: intent.idempotencyKey,
    expiresAt: intent.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// In-memory unit of work (tx-aware, fault hooks)
// ---------------------------------------------------------------------------

export interface InMemoryVerificationUowHooks {
  beforeCommit?: (tx: I09Tx) => void | Promise<void>;
  /** Throw AFTER the commit was applied (commit-success-response-lost). */
  afterCommitAcknowledged?: () => void | Promise<void>;
}

export class InMemoryVerificationUow implements IntentUnitOfWork<I09Tx> {
  constructor(
    private readonly ledger: InMemoryVerificationLedger,
    private readonly hooks: InMemoryVerificationUowHooks = {},
  ) {}

  async execute<Result>(callback: (context: { transaction: I09Tx }) => Promise<Result>): Promise<Result> {
    const tx = this.ledger.begin();
    let result: Result;
    try {
      result = await callback({ transaction: tx });
      await this.hooks.beforeCommit?.(tx);
    } catch (error) {
      this.ledger.rollback(tx);
      throw error;
    }
    this.ledger.commit(tx);
    await this.hooks.afterCommitAcknowledged?.();
    return result;
  }
}

// ---------------------------------------------------------------------------
// In-memory generation object store (chunked streams + faults)
// ---------------------------------------------------------------------------

export interface I09StoredObject {
  etag: string;
  size: number;
  bytes: Uint8Array;
  contentType: string | null;
  metadata: Record<string, string>;
}

export interface I09ObjectStoreOptions {
  /** Stream chunk size in bytes (default 7; proves chunk-size independence). */
  chunkBytes?: number;
  /** Fail the stream (throw) after this many bytes have been read; null = no failure. */
  failStreamAfterBytes?: number | null;
  /** Report a HEAD etag that differs from the stored etag. */
  forceHeadEtag?: string | null;
  /** Report HEAD not_found. */
  forceHeadNotFound?: boolean;
  forceHeadClass?: 'denied' | 'retryable' | 'unknown';
  forceReadClass?: 'denied' | 'retryable' | 'unknown';
}

export class InMemoryVerificationObjectStore implements GenerationObjectStorePort {
  readonly objects = new Map<string, I09StoredObject>();
  readonly headCalls: Array<{ key: string; expectedEtag?: string }> = [];
  readonly readCalls: Array<{ key: string; expectedEtag: string }> = [];
  /** Streams destroyed/aborted by the consumer (oversize/abort evidence). */
  readonly destroyedStreams: string[] = [];
  options: I09ObjectStoreOptions = {};

  seed(key: string, bytes: Uint8Array, options: {
    etag?: string;
    contentType?: string | null;
    metadata?: Record<string, string>;
  } = {}): void {
    this.objects.set(key, {
      etag: options.etag ?? `"etag-${sha256HexBytes(key).slice(0, 16)}"`,
      size: bytes.byteLength,
      bytes,
      contentType: options.contentType ?? null,
      metadata: options.metadata ?? {},
    });
  }

  etagOf(key: string): string | undefined {
    return this.objects.get(key)?.etag;
  }

  bytesOf(key: string): Uint8Array | undefined {
    return this.objects.get(key)?.bytes;
  }

  async headExact(handle: { generationId: string; key: string }, options: { expectedEtag?: string } = {}): Promise<GenerationHeadOutcome> {
    this.headCalls.push({ key: handle.key, expectedEtag: options.expectedEtag });
    if (this.options.forceHeadNotFound) return { class: 'not_found' };
    if (this.options.forceHeadClass) return { class: this.options.forceHeadClass };
    const object = this.objects.get(handle.key);
    if (!object) return { class: 'not_found' };
    if (options.expectedEtag !== undefined && options.expectedEtag !== object.etag) {
      return { class: 'etag_mismatch' };
    }
    return {
      class: 'ok',
      identity: {
        generationId: handle.generationId,
        size: object.size,
        etag: this.options.forceHeadEtag ?? object.etag,
        metadata: object.metadata,
        contentType: object.contentType,
      },
    };
  }

  async readBounded(
    handle: { generationId: string; key: string },
    options: { expectedEtag: string; byteCeiling: number; signal: AbortSignal },
  ): Promise<GenerationReadOutcome> {
    this.readCalls.push({ key: handle.key, expectedEtag: options.expectedEtag });
    if (this.options.forceReadClass) return { class: this.options.forceReadClass };
    const object = this.objects.get(handle.key);
    if (!object) return { class: 'not_found' };
    if (options.expectedEtag !== object.etag) return { class: 'etag_mismatch' };
    if (object.size > options.byteCeiling) return { class: 'overflow', byteCeiling: options.byteCeiling };
    const chunkBytes = this.options.chunkBytes ?? 7;
    const failAfter = this.options.failStreamAfterBytes;
    const key = handle.key;
    const stream = this.streamObject(key, object, chunkBytes, options.signal, failAfter);
    return {
      class: 'ok',
      identity: {
        generationId: handle.generationId,
        size: object.size,
        etag: object.etag,
        metadata: object.metadata,
        contentType: object.contentType,
      },
      stream,
    };
  }

  private async *streamObject(
    key: string,
    object: I09StoredObject,
    chunkBytes: number,
    signal: AbortSignal,
    failAfter: number | null,
  ): AsyncGenerator<Uint8Array> {
    const onAbort = (): void => {
      if (!this.destroyedStreams.includes(key)) this.destroyedStreams.push(key);
    };
    if (signal.aborted) {
      onAbort();
      const error = new Error('stream aborted');
      error.name = 'AbortError';
      throw error;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      let offset = 0;
      let emitted = 0;
      while (offset < object.bytes.byteLength) {
        if (signal.aborted) {
          onAbort();
          const error = new Error('stream aborted');
          error.name = 'AbortError';
          throw error;
        }
        const end = Math.min(offset + chunkBytes, object.bytes.byteLength);
        const chunk = object.bytes.subarray(offset, end);
        if (failAfter !== null && emitted + chunk.byteLength > failAfter) {
          throw new Error('stream_interrupted_mid_body');
        }
        offset = end;
        emitted += chunk.byteLength;
        yield chunk;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// Recording verification outbox (enqueue dep for the complete use case)
// ---------------------------------------------------------------------------

export interface RecordedVerificationEnqueue {
  readonly payload: { blobId: string; generationId: string; intentId: string };
}

export class RecordingVerificationOutbox {
  readonly enqueued: RecordedVerificationEnqueue[] = [];
  failNext: Error | undefined;

  async enqueue(_tx: I09Tx, payload: { blobId: string; generationId: string; intentId: string }): Promise<void> {
    if (this.failNext) {
      const failure = this.failNext;
      this.failNext = undefined;
      throw failure;
    }
    this.enqueued.push({ payload: { ...payload } });
  }

  countFor(blobId: string): number {
    return this.enqueued.filter((entry) => entry.payload.blobId === blobId).length;
  }
}

export function fakeAttempt(n: number | string): VerificationAttemptFence {
  const value = String(n);
  return { outboxId: `outbox-${value}`, leaseGeneration: String(1000 + Number(value)) };
}

export function makeRandomId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
