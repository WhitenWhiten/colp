/**
 * Shared helpers for the P4A-I08 focused suites. This file is not a test file:
 * it matches no vitest test pattern and is never listed in a focused config.
 *
 * It provides a transaction-aware in-memory attachments ledger (writes are
 * staged per transaction and only applied on commit, so before-commit faults
 * leave nothing persisted while commit-success-response-lost faults recover
 * from the committed store), a matching unit-of-work, a recording grant
 * issuer, and an in-memory access-policy facts port for the authorization
 * matrix.
 */
import { createHash } from 'node:crypto';
import type { ActorPrincipal, AccessPolicyFactsPort, MembershipRole, ResourcePolicyFacts } from '../../src/modules/access-policy/index.js';
import {
  AttachmentsIdentityError,
  computeBlobIdFromBinding,
  type ActivateReplacementInput,
  type ActivateReplacementResult,
  type AllocateGenerationInput,
  type AllocateGenerationResult,
  type AttachmentsLedgerPort,
  type AttachmentsPortOptions,
  type ClaimCleanupInput,
  type ClaimCleanupResult,
  type CompleteCleanupInput,
  type CompleteCleanupResult,
  type CompleteGenerationInput,
  type CompleteGenerationResult,
  type FindIntentByBindingInput,
  type FindIntentByBindingResult,
  type FinalizeLockInput,
  type FinalizeLockResult,
  type IntentUnitOfWork,
  type QuarantineGenerationInput,
  type QuarantineGenerationResult,
  type StoredIntentFacts,
  type UploadGrant,
  type UploadGrantIssuerPort,
} from '../../src/modules/attachments/index.js';
import type { AttachmentsFeatureConfig } from '../../src/modules/attachments/index.js';

export const I08_SUBJECT = 'i08-subject-owner';
export const I08_PRINCIPAL = 'i08-principal';
export const I08_COLLECTION = 'i08-collection';
export const I08_BUCKET = 'i08-production-bucket';
export const I08_LIVE_PREFIX = 'attachments/live/';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function makeActor(subjectId = I08_SUBJECT, principalId = I08_PRINCIPAL): ActorPrincipal {
  return { principalId, subjectId, kind: 'account' };
}

export function makeI08Config(overrides: Partial<AttachmentsFeatureConfig> = {}): AttachmentsFeatureConfig {
  const base: AttachmentsFeatureConfig = {
    enabled: true,
    r2: {
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: I08_BUCKET,
      livePrefix: I08_LIVE_PREFIX,
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

// ---------------------------------------------------------------------------
// In-memory access-policy facts port
// ---------------------------------------------------------------------------

export interface MembershipSeed {
  readonly subjectId: string;
  readonly role: MembershipRole;
}

export interface CollectionSeed {
  readonly id: string;
  readonly ownerSubjectId: string;
  readonly visibility: 'private' | 'protected' | 'public' | 'unlisted';
  readonly policyRevision: string;
  readonly deleted?: boolean;
  readonly members?: readonly MembershipSeed[];
}

export class InMemoryAccessPolicy implements AccessPolicyFactsPort {
  readonly collections = new Map<string, {
    seed: CollectionSeed;
    members: Map<string, MembershipRole>;
  }>();

  seed(seed: CollectionSeed): void {
    const members = new Map<string, MembershipRole>();
    for (const member of seed.members ?? []) members.set(member.subjectId, member.role);
    this.collections.set(seed.id, { seed, members });
  }

  removeMember(collectionId: string, subjectId: string): void {
    this.collections.get(collectionId)?.members.delete(subjectId);
  }

  async loadCollectionFacts(input: { collectionId: string; actorSubjectId: string }): Promise<ResourcePolicyFacts | null> {
    const entry = this.collections.get(input.collectionId);
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
// In-memory transaction-aware attachments ledger
// ---------------------------------------------------------------------------

interface StoredIntent extends StoredIntentFacts {
  readonly bucket: string;
  readonly keyFingerprint: string;
  readonly createdAt: Date;
}

interface StoredGeneration {
  readonly generationId: string;
  readonly blobId: string;
  readonly bucket: string;
  readonly key: string;
  readonly keyFingerprint: string;
  readonly generationState: string;
  readonly createdAt: Date;
}

interface StoredKey {
  readonly generationId: string;
  readonly key: string;
  readonly keyFingerprint: string;
  readonly blobId: string;
  readonly createdAt: Date;
}

interface StoredBlob {
  readonly blobId: string;
  readonly ownerSubjectId: string;
  readonly logicalState: string;
  readonly createdAt: Date;
}

interface LedgerStore {
  readonly intents: Map<string, StoredIntent>;
  readonly generations: Map<string, StoredGeneration>;
  readonly keys: Map<string, StoredKey>;
  readonly blobs: Map<string, StoredBlob>;
}

function emptyStore(): LedgerStore {
  return { intents: new Map(), generations: new Map(), keys: new Map(), blobs: new Map() };
}

function mergeInto(target: LedgerStore, source: LedgerStore): void {
  for (const [id, row] of source.intents) target.intents.set(id, row);
  for (const [id, row] of source.generations) target.generations.set(id, row);
  for (const [id, row] of source.keys) target.keys.set(id, row);
  for (const [id, row] of source.blobs) target.blobs.set(id, row);
}

/** Transaction token type used by the in-memory harness. */
export type InMemoryTx = number;

export class InMemoryIntentLedger implements AttachmentsLedgerPort<InMemoryTx> {
  readonly committed: LedgerStore = emptyStore();
  private readonly pending = new Map<InMemoryTx, LedgerStore>();
  private txCounter = 0;

  begin(): InMemoryTx {
    this.txCounter += 1;
    this.pending.set(this.txCounter, emptyStore());
    return this.txCounter;
  }

  commit(tx: InMemoryTx): void {
    const staged = this.pending.get(tx);
    if (staged) {
      mergeInto(this.committed, staged);
      this.pending.delete(tx);
    }
  }

  rollback(tx: InMemoryTx): void {
    this.pending.delete(tx);
  }

  generationCount(): number {
    return this.committed.generations.size;
  }

  intentCount(): number {
    return this.committed.intents.size;
  }

  allKeys(): string[] {
    return [...this.committed.keys.values()].map((row) => row.key);
  }

  keyOfGeneration(generationId: string): string | undefined {
    return this.committed.generations.get(generationId)?.key;
  }

  private view(tx: InMemoryTx): LedgerStore {
    const staged = this.pending.get(tx);
    if (!staged) throw new Error('in-memory ledger: transaction not open');
    return staged;
  }

  private findAnyIntent(predicate: (intent: StoredIntent) => boolean): StoredIntent | undefined {
    for (const intent of this.committed.intents.values()) {
      if (predicate(intent)) return intent;
    }
    for (const staged of this.pending.values()) {
      for (const intent of staged.intents.values()) {
        if (predicate(intent)) return intent;
      }
    }
    return undefined;
  }

  async findIntentByBinding(tx: InMemoryTx, input: FindIntentByBindingInput): Promise<FindIntentByBindingResult> {
    const intent = this.findAnyIntent((candidate) =>
      candidate.collectionId === input.collectionId
      && candidate.subjectIdentity === input.subjectIdentity
      && candidate.idempotencyKey === input.idempotencyKey);
    if (!intent) return { outcome: 'not_found' };
    return { outcome: 'found', intent };
  }

  async allocate(tx: InMemoryTx, input: AllocateGenerationInput, options: AttachmentsPortOptions = {}): Promise<AllocateGenerationResult> {
    const staged = this.view(tx);
    const existing = this.findAnyIntent((intent) => intent.intentId === input.intentId);
    if (existing) {
      if (existing.generationId === input.generationId && existing.blobId === input.blobId) {
        return { outcome: 'already_issued', intentId: input.intentId, generationId: input.generationId, blobId: input.blobId };
      }
      throw new AttachmentsIdentityError('intent_generation_mismatch');
    }
    const keyExists = (key: string): boolean =>
      this.committed.keys.has(key) || [...this.pending.values()].some((store) => store.keys.has(key));
    const generationExists = (generationId: string): boolean =>
      this.committed.generations.has(generationId) || [...this.pending.values()].some((store) => store.generations.has(generationId));
    const fingerprintExists = (fingerprint: string): boolean =>
      [...this.committed.keys.values()].some((row) => row.keyFingerprint === fingerprint)
      || [...this.pending.values()].some((store) => [...store.keys.values()].some((row) => row.keyFingerprint === fingerprint));
    const bindingExists = (blobId: string, idempotencyKey: string): boolean =>
      this.findAnyIntent((intent) => intent.blobId === blobId && intent.idempotencyKey === idempotencyKey) !== undefined;

    if (generationExists(input.generationId)) throw new AttachmentsIdentityError('generation_issued');
    if (keyExists(input.key)) throw new AttachmentsIdentityError('key_issued');
    if (fingerprintExists(input.keyFingerprint)) throw new AttachmentsIdentityError('fingerprint_issued');
    if (bindingExists(input.blobId, input.idempotencyKey)) throw new AttachmentsIdentityError('idempotency_conflict');

    const createdAt = new Date('2026-08-08T12:00:00.000Z');
    staged.keys.set(input.key, {
      generationId: input.generationId, key: input.key, keyFingerprint: input.keyFingerprint,
      blobId: input.blobId, createdAt,
    });
    if (!this.committed.blobs.has(input.blobId) && ![...this.pending.values()].some((store) => store.blobs.has(input.blobId))) {
      staged.blobs.set(input.blobId, {
        blobId: input.blobId, ownerSubjectId: input.subjectIdentity, logicalState: 'issued', createdAt,
      });
    }
    staged.generations.set(input.generationId, {
      generationId: input.generationId, blobId: input.blobId, bucket: input.bucket, key: input.key,
      keyFingerprint: input.keyFingerprint, generationState: 'allocated', createdAt,
    });
    staged.intents.set(input.intentId, {
      intentId: input.intentId, generationId: input.generationId, blobId: input.blobId, key: input.key,
      principalId: input.principalId, collectionId: input.collectionId, subjectIdentity: input.subjectIdentity,
      expectedSize: input.expectedSize ?? null, expectedSha256: input.expectedSha256 ?? null,
      mediaHint: input.mediaHint ?? null, policyRevision: input.policyRevision,
      idempotencyKey: input.idempotencyKey, expiresAt: input.expiresAt,
      bucket: input.bucket, keyFingerprint: input.keyFingerprint, createdAt,
    });
    return { outcome: 'issued', intentId: input.intentId, generationId: input.generationId, blobId: input.blobId };
  }

  // The I08 use case only consumes findIntentByBinding + allocate; the
  // remaining port methods are stubs (I07 owns their contract).
  async complete(_tx: InMemoryTx, _input: CompleteGenerationInput): Promise<CompleteGenerationResult> {
    throw new Error('not_implemented:complete');
  }
  async activateReplacement(_tx: InMemoryTx, _input: ActivateReplacementInput): Promise<ActivateReplacementResult> {
    throw new Error('not_implemented:activateReplacement');
  }
  async claimCleanup(_tx: InMemoryTx, _input: ClaimCleanupInput): Promise<ClaimCleanupResult> {
    throw new Error('not_implemented:claimCleanup');
  }
  async completeCleanup(_tx: InMemoryTx, _input: CompleteCleanupInput): Promise<CompleteCleanupResult> {
    throw new Error('not_implemented:completeCleanup');
  }
  async finalizeLock(_tx: InMemoryTx, _input: FinalizeLockInput): Promise<FinalizeLockResult> {
    throw new Error('not_implemented:finalizeLock');
  }
  async readCleanupState(_tx: never, _input: { generationId: string }): Promise<{ outcome: 'found'; row: never } | { outcome: 'not_found' }> {
    return { outcome: 'not_found' };
  }

  async quarantineGeneration(_tx: InMemoryTx, _input: QuarantineGenerationInput): Promise<QuarantineGenerationResult> {
    throw new Error('not_implemented:quarantineGeneration');
  }
}

// ---------------------------------------------------------------------------
// Transaction-aware unit of work over the in-memory ledger
// ---------------------------------------------------------------------------

export interface InMemoryUowHooks {
  beforeCallback?: (tx: InMemoryTx) => void | Promise<void>;
  /** Throw to abort the transaction before commit (nothing persisted). */
  beforeCommit?: (tx: InMemoryTx) => void | Promise<void>;
  /** Throw AFTER the commit was applied (commit-success-response-lost). */
  afterCommitAcknowledged?: () => void | Promise<void>;
}

export class InMemoryIntentUow implements IntentUnitOfWork<InMemoryTx> {
  constructor(
    private readonly ledger: InMemoryIntentLedger,
    private readonly hooks: InMemoryUowHooks = {},
  ) {}

  async execute<Result>(callback: (context: { transaction: InMemoryTx }) => Promise<Result>): Promise<Result> {
    const tx = this.ledger.begin();
    await this.hooks.beforeCallback?.(tx);
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
// Recording grant issuer (production presigner shape, in-memory)
// ---------------------------------------------------------------------------

export interface RecordedGrantCall {
  readonly handle: { generationId: string; key: string };
  readonly options: { ttlSeconds: number; contentType: string; contentLength: number };
}

export class RecordingGrantStore implements UploadGrantIssuerPort {
  readonly grants: UploadGrant[] = [];
  readonly calls: RecordedGrantCall[] = [];
  /** One-shot signing failure; cleared after the next call. */
  failNextWith: Error | undefined;

  async issueCreateOnlyGrant(handle: { generationId: string; key: string }, options: { ttlSeconds: number; contentType?: string; contentLength: number; metadata?: Readonly<Record<string, string>> }): Promise<UploadGrant> {
    this.calls.push({
      handle: { generationId: handle.generationId, key: handle.key },
      options: { ttlSeconds: options.ttlSeconds, contentType: options.contentType ?? 'application/octet-stream', contentLength: options.contentLength },
    });
    if (this.failNextWith) {
      const failure = this.failNextWith;
      this.failNextWith = undefined;
      throw failure;
    }
    const signedAtIso = new Date().toISOString();
    const grant: UploadGrant = {
      url: `https://signing.invalid/put/${this.grants.length + 1}`,
      method: 'PUT',
      signedAtIso,
      expiresAtIso: new Date(Date.parse(signedAtIso) + options.ttlSeconds * 1000).toISOString(),
      ttlSeconds: options.ttlSeconds,
      generationId: handle.generationId,
      keyFingerprint: sha256Hex(handle.key),
      ifNoneMatch: '*',
      metadataHeaders: {},
      contentLength: options.contentLength,
      contentType: options.contentType ?? 'application/octet-stream',
    };
    this.grants.push(grant);
    return grant;
  }
}

// ---------------------------------------------------------------------------
// Deterministic crypto queue for collision negatives
// ---------------------------------------------------------------------------

export class QueueCrypto {
  private readonly values: string[];
  private index = 0;
  constructor(values: readonly string[]) {
    this.values = [...values];
  }
  randomHex(_bytes: number): string {
    const value = this.values[this.index];
    if (value === undefined) throw new Error('queue_crypto_exhausted');
    this.index += 1;
    return value;
  }
  get calls(): number {
    return this.index;
  }
}

/** Stable 32-hex identity generator for a numbered slot. */
export function hexFor(n: number | string): string {
  return sha256Hex(`i08-slot:${n}`).slice(0, 32);
}

export function bindingKeyFor(slot: number | string): string {
  return `idem-${slot}`;
}

export function expectedBlobId(collectionId: string, subjectIdentity: string, idempotencyKey: string): string {
  return computeBlobIdFromBinding(collectionId, subjectIdentity, idempotencyKey);
}
