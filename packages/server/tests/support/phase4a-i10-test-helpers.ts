/**
 * Shared helpers for the P4A-I10 focused suites. This file is not a test file:
 * it matches no vitest test pattern and is never listed in a focused config.
 *
 * Provides deterministic identity fixtures (two principals/collections,
 * different-content objects), an in-memory access-policy facts port that can
 * be mutated between barrier points (membership removal, collection
 * soft-delete), a minimal in-memory delivery ledger implementing
 * `findBlobForDelivery` (the ONLY port method the admission unit suite
 * exercises; the rest fail loudly so the suite cannot silently rely on a
 * permissive test double), the production HMAC capability signer + bounded
 * rate limiter, a recording audit logger, and a delivery-attempt stub that
 * models the I11 isolated-origin contract (zero body / no redirect / no-store)
 * using the SAME production verifier logic I11 will consume.
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  AccessPolicyFactsPort,
  ActorPrincipal,
  MembershipRole,
  ResourcePolicyFacts,
} from '../../src/modules/access-policy/index.js';
import {
  NOOP_BARRIER,
  createDeliveryRateLimiter,
  createHmacOwnerDeliveryCapabilitySigner,
  verifyOwnerDeliveryCapability,
  type ActivateReplacementInput,
  type ActivateReplacementResult,
  type AllocateGenerationInput,
  type AllocateGenerationResult,
  type AttachmentsFeatureConfig,
  type AttachmentsLedgerPort,
  type AttachmentsPortOptions,
  type BlobForDeliveryFacts,
  type BlobLogicalState,
  type ClaimCleanupInput,
  type ClaimCleanupResult,
  type ClaimVerificationInput,
  type ClaimVerificationResult,
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
  type DeliveryRateLimitPolicy,
  type DeliveryRateLimiter,
  type FinalizeLockInput,
  type FinalizeLockResult,
  type FindBlobForDeliveryInput,
  type FindBlobForDeliveryResult,
  type FindIntentByBindingInput,
  type FindIntentByBindingResult,
  type GenerationState,
  type IntentUnitOfWork,
  type OwnerDeliveryCapabilitySigner,
  type QuarantineGenerationInput,
  type QuarantineGenerationResult,
  type QuarantineVerificationInput,
  type QuarantineVerificationResult,
  type StoredIntentFacts,
} from '../../src/modules/attachments/index.js';

export const I10_SUBJECT_OWNER = 'i10-subject-owner';
export const I10_PRINCIPAL_OWNER = 'i10-principal-owner';
export const I10_SUBJECT_MEMBER = 'i10-subject-member';
export const I10_PRINCIPAL_MEMBER = 'i10-principal-member';
export const I10_SUBJECT_EDITOR = 'i10-subject-editor';
export const I10_PRINCIPAL_EDITOR = 'i10-principal-editor';
export const I10_SUBJECT_OTHER_OWNER = 'i10-subject-other-owner';
export const I10_PRINCIPAL_OTHER_OWNER = 'i10-principal-other-owner';
export const I10_SUBJECT_OUTSIDER = 'i10-subject-outsider';
export const I10_PRINCIPAL_OUTSIDER = 'i10-principal-outsider';
export const I10_COLLECTION_A = 'i10-collection-a';
export const I10_COLLECTION_B = 'i10-collection-b';
export const I10_BUCKET = 'i10-production-bucket';
export const I10_LIVE_PREFIX = 'attachments/live/';
export const I10_DELIVERY_ORIGIN = 'https://delivery.known.test';
/** Deterministic HMAC secret for tests (never a real credential). */
export const I10_DELIVERY_SECRET = Buffer.from('i10-delivery-capability-hmac-secret-0123456789abcdef', 'utf8');

export function sha256HexBytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function makeActor(subjectId = I10_SUBJECT_OWNER, principalId = I10_PRINCIPAL_OWNER): ActorPrincipal {
  return { principalId, subjectId, kind: 'account' };
}

export function makeI10Config(overrides: Partial<AttachmentsFeatureConfig> = {}): AttachmentsFeatureConfig {
  const base: AttachmentsFeatureConfig = {
    enabled: true,
    r2: {
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: I10_BUCKET,
      livePrefix: I10_LIVE_PREFIX,
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
    isolatedDeliveryOrigin: I10_DELIVERY_ORIGIN,
    deliveryCapabilitySecretRef: 'known/delivery/hmac/primary',
    deliveryCapabilityTtlSeconds: 60,
  };
  return Object.freeze({ ...base, ...overrides, r2: { ...base.r2, ...overrides.r2 } });
}

export function uuidFor(n: number | string): string {
  return `018f6f7a-8f2a-7a3d-a123-123456789${String(n).padStart(3, '0')}`;
}

export interface I10Identity {
  blobId: string;
  intentId: string;
  generationId: string;
  key: string;
}

/** Deterministic generation identity for a numbered fixture slot. */
export function identityFor(n: number): I10Identity {
  const blobId = uuidFor(1000 + n);
  const intentId = uuidFor(2000 + n);
  const generationId = uuidFor(3000 + n);
  const key = `${I10_LIVE_PREFIX}${uuidFor(4000 + n)}`;
  return { blobId, intentId, generationId, key };
}

export function allocateInput(id: I10Identity, overrides: Partial<AllocateGenerationInput> = {}): AllocateGenerationInput {
  return {
    blobId: id.blobId,
    intentId: id.intentId,
    generationId: id.generationId,
    principalId: I10_PRINCIPAL_OWNER,
    collectionId: I10_COLLECTION_A,
    subjectIdentity: I10_SUBJECT_OWNER,
    bucket: I10_BUCKET,
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
// In-memory access-policy facts port (mutable between barrier points)
// ---------------------------------------------------------------------------

export interface I10MembershipSeed {
  readonly subjectId: string;
  readonly role: MembershipRole;
}

export interface I10CollectionSeed {
  readonly id: string;
  readonly ownerSubjectId: string;
  readonly visibility: 'private' | 'protected' | 'public' | 'unlisted';
  readonly policyRevision: string;
  readonly deleted?: boolean;
  readonly members?: readonly I10MembershipSeed[];
}

export class InMemoryAccessPolicy implements AccessPolicyFactsPort {
  private readonly entries = new Map<string, { seed: I10CollectionSeed; members: Map<string, MembershipRole> }>();

  seed(seed: I10CollectionSeed): void {
    const members = new Map<string, MembershipRole>();
    for (const member of seed.members ?? []) members.set(member.subjectId, member.role);
    this.entries.set(seed.id, { seed: { ...seed }, members });
  }

  removeMember(collectionId: string, subjectId: string): void {
    this.entries.get(collectionId)?.members.delete(subjectId);
  }

  setDeleted(collectionId: string, deleted: boolean): void {
    const entry = this.entries.get(collectionId);
    if (entry) entry.seed = { ...entry.seed, deleted };
  }

  async loadCollectionFacts(input: { collectionId: string; actorSubjectId: string }): Promise<ResourcePolicyFacts | null> {
    const entry = this.entries.get(input.collectionId);
    if (!entry) return null;
    return {
      collectionId: entry.seed.id,
      ownerSubjectId: entry.seed.ownerSubjectId,
      visibility: entry.seed.visibility,
      policyRevision: entry.seed.policyRevision,
      membershipRole: entry.members.get(input.actorSubjectId) ?? null,
      deleted: entry.seed.deleted === true,
    };
  }
}

// ---------------------------------------------------------------------------
// Minimal in-memory delivery ledger (only findBlobForDelivery is real)
// ---------------------------------------------------------------------------

export type InMemoryTx = number;

export class InMemoryDeliveryLedger implements AttachmentsLedgerPort<InMemoryTx> {
  private readonly blobs = new Map<string, BlobForDeliveryFacts>();
  /** Every `findBlobForDelivery` input, so tests prove only the opaque blob id is passed. */
  readonly findCalls: FindBlobForDeliveryInput[] = [];

  seedBlob(seed: BlobForDeliveryFacts): void {
    this.blobs.set(seed.blobId, { ...seed });
  }

  setCurrentGeneration(blobId: string, generationId: string | null, generationState: GenerationState | null): void {
    const blob = this.blobs.get(blobId);
    if (!blob) throw new Error(`i10_unknown_blob:${blobId}`);
    this.blobs.set(blobId, { ...blob, currentGenerationId: generationId, currentGenerationState: generationState });
  }

  setLogicalState(blobId: string, logicalState: BlobLogicalState): void {
    const blob = this.blobs.get(blobId);
    if (!blob) throw new Error(`i10_unknown_blob:${blobId}`);
    this.blobs.set(blobId, { ...blob, logicalState });
  }

  async findBlobForDelivery(
    _tx: InMemoryTx,
    input: FindBlobForDeliveryInput,
    options: AttachmentsPortOptions = {},
  ): Promise<FindBlobForDeliveryResult> {
    const barrier = options.barrier ?? NOOP_BARRIER;
    await barrier.arriveAndWait('delivery_read_before');
    this.findCalls.push({ blobId: input.blobId });
    const blob = this.blobs.get(input.blobId);
    await barrier.arriveAndWait('delivery_read_after');
    if (!blob) return { outcome: 'not_found' };
    return { outcome: 'found', facts: { ...blob } };
  }

  private notImplemented(): never {
    throw new Error('i10_in_memory_ledger_method_not_implemented');
  }

  async findIntentByBinding(_tx: InMemoryTx, _input: FindIntentByBindingInput): Promise<FindIntentByBindingResult> {
    return this.notImplemented();
  }
  async allocate(_tx: InMemoryTx, _input: AllocateGenerationInput): Promise<AllocateGenerationResult> {
    return this.notImplemented();
  }
  async complete(_tx: InMemoryTx, _input: CompleteGenerationInput): Promise<CompleteGenerationResult> {
    return this.notImplemented();
  }
  async activateReplacement(_tx: InMemoryTx, _input: ActivateReplacementInput): Promise<ActivateReplacementResult> {
    return this.notImplemented();
  }
  async claimCleanup(_tx: InMemoryTx, _input: ClaimCleanupInput): Promise<ClaimCleanupResult> {
    return this.notImplemented();
  }
  async completeCleanup(_tx: InMemoryTx, _input: CompleteCleanupInput): Promise<CompleteCleanupResult> {
    return this.notImplemented();
  }
  async finalizeLock(_tx: InMemoryTx, _input: FinalizeLockInput): Promise<FinalizeLockResult> {
    return this.notImplemented();
  }
  async readCleanupState(_tx: never, _input: { generationId: string }): Promise<{ outcome: 'found'; row: never } | { outcome: 'not_found' }> {
    return { outcome: 'not_found' };
  }

  async quarantineGeneration(_tx: InMemoryTx, _input: QuarantineGenerationInput): Promise<QuarantineGenerationResult> {
    return this.notImplemented();
  }
  async findCompleteTarget(_tx: InMemoryTx, _input: CompleteUploadTargetInput): Promise<CompleteUploadTargetResult> {
    return this.notImplemented();
  }
  async completeUploadCas(_tx: InMemoryTx, _input: CompleteUploadCasInput): Promise<CompleteUploadCasResult> {
    return this.notImplemented();
  }
  async claimVerification(_tx: InMemoryTx, _input: ClaimVerificationInput): Promise<ClaimVerificationResult> {
    return this.notImplemented();
  }
  async completeVerification(_tx: InMemoryTx, _input: CompleteVerificationInput): Promise<CompleteVerificationResult> {
    return this.notImplemented();
  }
  async quarantineVerification(_tx: InMemoryTx, _input: QuarantineVerificationInput): Promise<QuarantineVerificationResult> {
    return this.notImplemented();
  }
}

// ---------------------------------------------------------------------------
// Recording audit logger
// ---------------------------------------------------------------------------

export interface I10LogEntry {
  readonly class: string;
  readonly blobId?: string;
  readonly generationId?: string;
  readonly principalId?: string;
  readonly statusCode?: number;
  readonly code?: string;
  readonly retryAfterSeconds?: number;
  readonly reason?: string;
}

export class RecordingOwnerDownloadLog {
  readonly entries: I10LogEntry[] = [];
  readonly handle = (entry: I10LogEntry): void => {
    this.entries.push({ ...entry });
  };

  classes(): string[] {
    return this.entries.map((entry) => String(entry.class));
  }

  entriesOf(class_: string): I10LogEntry[] {
    return this.entries.filter((entry) => entry.class === class_);
  }

  serialized(): string {
    return JSON.stringify(this.entries);
  }
}

// ---------------------------------------------------------------------------
// Delivery attempt stub: models the I11 isolated-origin contract using the
// SAME production verifier logic I11 will consume. A rejected or absent
// capability always yields zero body, no redirect, and a no-store response.
// ---------------------------------------------------------------------------

export interface I10DeliveryAttemptResult {
  readonly bodyBytes: number;
  readonly redirect: false;
  readonly noStore: true;
  readonly rejected: boolean;
  readonly reason?: string;
}

export class DeliveryAttemptStub {
  private readonly objects = new Map<string, Uint8Array>();

  constructor(private readonly options: {
    readonly secret: string | Uint8Array;
    readonly expectedAudience: string;
    readonly now?: () => Date;
  }) {}

  seedObject(generationId: string, bytes: Uint8Array): void {
    this.objects.set(generationId, bytes);
  }

  attempt(token: string): I10DeliveryAttemptResult {
    const now = this.options.now?.() ?? new Date();
    const verification = verifyOwnerDeliveryCapability({
      token,
      secret: this.options.secret,
      expectedAudience: this.options.expectedAudience,
      now,
    });
    if (verification.outcome !== 'valid') {
      return { bodyBytes: 0, redirect: false, noStore: true, rejected: true, reason: verification.reason };
    }
    const bytes = this.objects.get(verification.claims.generationId);
    return { bodyBytes: bytes?.byteLength ?? 0, redirect: false, noStore: true, rejected: false };
  }
}


// ---------------------------------------------------------------------------
// Harness: composes the production signer + bounded limiter + in-memory deps
// ---------------------------------------------------------------------------

export interface I10Harness {
  readonly ledger: InMemoryDeliveryLedger;
  readonly accessPolicy: InMemoryAccessPolicy;
  readonly signer: OwnerDeliveryCapabilitySigner;
  readonly limiter: DeliveryRateLimiter;
  readonly log: RecordingOwnerDownloadLog;
  readonly uow: IntentUnitOfWork<InMemoryTx>;
  readonly config: AttachmentsFeatureConfig;
  readonly now: () => Date;
}

export function createI10Harness(options: {
  readonly now?: () => Date;
  readonly rateLimitPolicy?: DeliveryRateLimitPolicy;
  readonly ttlSeconds?: number;
} = {}): I10Harness {
  const ledger = new InMemoryDeliveryLedger();
  const accessPolicy = new InMemoryAccessPolicy();
  const signer = createHmacOwnerDeliveryCapabilitySigner({
    secret: I10_DELIVERY_SECRET,
    audienceOrigin: I10_DELIVERY_ORIGIN,
    now: options.now,
  });
  const limiter = createDeliveryRateLimiter(options.rateLimitPolicy);
  const log = new RecordingOwnerDownloadLog();
  const now = options.now ?? (() => new Date());
  const uow: IntentUnitOfWork<InMemoryTx> = {
    execute: async (callback) => callback({ transaction: 1 }),
  };
  const config = makeI10Config(
    options.ttlSeconds !== undefined ? { deliveryCapabilityTtlSeconds: options.ttlSeconds } : {},
  );
  return { ledger, accessPolicy, signer, limiter, log, uow, config, now };
}
